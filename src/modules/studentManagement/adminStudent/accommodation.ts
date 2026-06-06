// Hostel + Transport + Bed allocation operations, split out of adminStudent.service.ts.
// Self-contained: no calls into other adminStudent domain modules.

import prisma from '../../../config/prisma';
import {
    AdmissionStatus,
    AccommodationType,
    FeeStatus,
    Prisma,
    HostelType,
    PaymentComponent,
    PaymentStatus,
    LedgerTransactionType,
    HostelPaymentMode,
} from '@prisma/client';
import { AppError } from '../../../utils/AppError';
import { MESSAGES } from '../../../constants/messages';
import { convertToPresignedUrl } from '../../../utils/s3Utils';
import { assertHostelHasCapacity } from '../../accommodation/hostel/hostel.service';
import {
    getStudentContext,
    assertActiveAdmission,
    assertHostelAccommodation,
    assertNoBedAllocated,
    resolveFeeHeadsByComponent,
    getAvailableHostelCredit,
    getAvailableTransportCredit,
    assertAcademicYearWritable,
    resolveHostelPriceCategory,
    resolveTransportRouteCost,
    getActiveAcademicYear,
} from '../../../utils/studentContext';
import { generateAndSaveHostelAllotmentOrder } from '../../finance/payment.service';
import { recordRetained } from '../../../utils/retainedRevenue';
import { RetainedRevenueCategory, RetainedRevenueSourceType } from '@prisma/client';

/** Per-component withholding input on hostel cancellation (amount the college keeps per service). */
type HostelWithhold = {
    accommodation?: number;
    mess?: number;
    laundry?: number;
    registration?: number;
};

/** Validated per-component withholding breakdown (every field present, ≥ 0). */
type HostelWithholdBreakdown = {
    accommodation: number;
    mess: number;
    laundry: number;
    registration: number;
};

/**
 * Sum SUCCESS (non-deleted) hostel payments grouped by component, so per-component
 * withholding on cancellation can be capped against what the student actually paid into
 * each service. Legacy bare `HOSTEL` payments are folded into accommodation (the bare
 * enum is being phased out and is treated as HOSTEL_ACCOMMODATION everywhere — see
 * payment.service). Pass `tx` to read inside an open transaction.
 */
const getHostelPaidByComponent = async (
    studentId: string,
    tx?: any
): Promise<HostelWithholdBreakdown & { total: number }> => {
    const client = tx || prisma;
    const rows = await client.payment.groupBy({
        by: ['component'],
        where: {
            studentId,
            status: PaymentStatus.SUCCESS,
            isDeleted: false,
            component: { in: [
                PaymentComponent.HOSTEL,
                PaymentComponent.HOSTEL_ACCOMMODATION,
                PaymentComponent.HOSTEL_MESS,
                PaymentComponent.HOSTEL_LAUNDRY,
                PaymentComponent.HOSTEL_REGISTRATION,
            ] },
        },
        _sum: { amount: true },
    });

    const paid = { accommodation: 0, mess: 0, laundry: 0, registration: 0, total: 0 };
    for (const r of rows as Array<{ component: PaymentComponent; _sum: { amount: number | null } }>) {
        const amt = r._sum.amount ?? 0;
        switch (r.component) {
            case PaymentComponent.HOSTEL:
            case PaymentComponent.HOSTEL_ACCOMMODATION:
                paid.accommodation += amt; break;
            case PaymentComponent.HOSTEL_MESS:
                paid.mess += amt; break;
            case PaymentComponent.HOSTEL_LAUNDRY:
                paid.laundry += amt; break;
            case PaymentComponent.HOSTEL_REGISTRATION:
                paid.registration += amt; break;
        }
    }
    paid.total = paid.accommodation + paid.mess + paid.laundry + paid.registration;
    return paid;
};

/**
 * Resolve the amount the college keeps on a hostel cancellation. Two independent levers, ADDED
 * together:
 *   - per-component `withhold` — each clamped ≥ 0 and validated so it can't exceed what the
 *     student paid into that component (throws 400 otherwise).
 *   - a separate flat `cancellationFee` — an additional penalty kept on top, NOT tied to any
 *     component (no per-component cap).
 *
 * total = Σ withhold + cancellationFee. `breakdown` is the per-component split (null when no
 * `withhold` object was sent); `cancellationFee` is returned separately so it can be recorded
 * and reported distinctly from the component withholds.
 */
const resolveHostelWithhold = (
    args: { cancellationFee?: number; withhold?: HostelWithhold },
    paidByComponent: HostelWithholdBreakdown
): { breakdown: HostelWithholdBreakdown | null; cancellationFee: number; total: number } => {
    const cancellationFee = Math.max(0, args.cancellationFee ?? 0);

    if (args.withhold) {
        const w = args.withhold;
        const breakdown: HostelWithholdBreakdown = {
            accommodation: Math.max(0, w.accommodation ?? 0),
            mess: Math.max(0, w.mess ?? 0),
            laundry: Math.max(0, w.laundry ?? 0),
            registration: Math.max(0, w.registration ?? 0),
        };
        const over: string[] = [];
        if (breakdown.accommodation > paidByComponent.accommodation)
            over.push(`accommodation (withhold ${breakdown.accommodation} > paid ${paidByComponent.accommodation})`);
        if (breakdown.mess > paidByComponent.mess)
            over.push(`mess (withhold ${breakdown.mess} > paid ${paidByComponent.mess})`);
        if (breakdown.laundry > paidByComponent.laundry)
            over.push(`laundry (withhold ${breakdown.laundry} > paid ${paidByComponent.laundry})`);
        if (breakdown.registration > paidByComponent.registration)
            over.push(`registration (withhold ${breakdown.registration} > paid ${paidByComponent.registration})`);
        if (over.length > 0) {
            throw new AppError(`Cannot withhold more than was paid for: ${over.join('; ')}.`, 400);
        }
        const componentsTotal = breakdown.accommodation + breakdown.mess + breakdown.laundry + breakdown.registration;
        return { breakdown, cancellationFee, total: componentsTotal + cancellationFee };
    }
    // No per-component withhold — just the flat cancellationFee (legacy/withdrawal flow).
    return { breakdown: null, cancellationFee, total: cancellationFee };
};

/**
 * List a student's active (non-deleted) demands for the given fee heads, each enriched with how
 * much has been PAID against it (sum of SUCCESS payments linked via feeDemandId) and the
 * outstanding balance. Shared by all the cancel/switch PREVIEWS so they uniformly show
 * "the demands of the accommodation being left + paid so far per demand" — the admin uses this
 * to decide what to keep before committing.
 */
const listDemandsWithPaid = async (studentId: string, feeHeadIds: string[]) => {
    const demands = feeHeadIds.length > 0
        ? await prisma.studentFeeDemand.findMany({
            where: { studentId, feeHeadId: { in: feeHeadIds }, isDeleted: false },
            include: { feeHead: { select: { id: true, name: true, component: true } } },
            orderBy: { dueDate: 'asc' },
        })
        : [];

    const demandIds = demands.map(d => d.id);
    const paidByDemand = new Map<string, number>();
    if (demandIds.length > 0) {
        const grouped = await prisma.payment.groupBy({
            by: ['feeDemandId'],
            where: { feeDemandId: { in: demandIds }, status: PaymentStatus.SUCCESS, isDeleted: false },
            _sum: { amount: true },
        });
        for (const g of grouped) if (g.feeDemandId) paidByDemand.set(g.feeDemandId, g._sum.amount ?? 0);
    }

    const list = demands.map((d: any) => {
        const net  = d.netAmount ?? d.amount;
        const paid = paidByDemand.get(d.id) ?? 0;
        return {
            demandId:          d.id,
            feeHeadId:         d.feeHeadId,
            feeHead:           d.feeHead?.name ?? null,
            component:         d.feeHead?.component ?? null,
            amount:            d.amount,
            discountAmount:    d.discountAmount,
            scholarshipAmount: d.scholarshipAmount,
            netAmount:         net,
            paid,
            outstanding:       Math.max(0, net - paid),
            status:            d.status,
            dueDate:           d.dueDate,
        };
    });

    const totals = list.reduce(
        (t, d) => ({ demanded: t.demanded + d.netAmount, paid: t.paid + d.paid, outstanding: t.outstanding + d.outstanding }),
        { demanded: 0, paid: 0, outstanding: 0 }
    );

    return { demands: list, totals };
};

const HOSTEL_FEE_COMPONENTS = [
    PaymentComponent.HOSTEL_ACCOMMODATION,
    PaymentComponent.HOSTEL_MESS,
    PaymentComponent.HOSTEL_LAUNDRY,
    PaymentComponent.HOSTEL_REGISTRATION,
];

export const AccommodationService = {
    /**
     * List vacant beds in a hostel, optionally filtered by sharing/roomType/floor.
     * Used by the assignment-UI dropdown.
     */
    async getAvailableBeds(hostelId: string, filters: { sharing?: number; roomType?: string; floor?: number }) {
        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError('Hostel is deleted', 400);

        const roomWhere: any = { hostelId, isDeleted: false };
        if (filters.sharing !== undefined) roomWhere.capacity = filters.sharing;
        if (filters.roomType !== undefined) roomWhere.type = filters.roomType;
        if (filters.floor !== undefined) roomWhere.floor = filters.floor;

        const rooms = await prisma.hostelRoom.findMany({
            where: roomWhere,
            include: {
                beds: {
                    where: { allocations: { none: { status: 'ACTIVE' } } },
                    orderBy: { number: 'asc' }
                }
            },
            orderBy: [{ floor: 'asc' }, { number: 'asc' }]
        });

        const beds = rooms.flatMap(room =>
            room.beds.map(bed => ({
                bedId: bed.id,
                bedNumber: bed.number,
                roomId: room.id,
                roomNumber: room.number,
                floor: room.floor,
                capacity: room.capacity,
                roomType: room.type
            }))
        );

        return { hostelId, count: beds.length, beds };
    },

    /**
     * List students who opted for hostel (accommodationType=HOSTEL) but
     * either have no HostelAllocation row, or whose allocation is non-active
     * (e.g. CANCELLED). Used by the bed-allocation worklist UI.
     */
    async getPendingHostelAllocations(query: any) {
        const {
            page = 1,
            limit = 10,
            search,
            hostelId,
            hostelType,
            gender,
        } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;

        const where: Prisma.StudentWhereInput = {
            admissionDetails: {
                // "Wants hostel" = has a specific hostel assigned. This is the
                // load-bearing signal for bed allocation. Some legacy admissions
                // have hostelId set but accommodationType=NONE — those still
                // belong on the worklist.
                ...(hostelId ? { hostelId } : { hostelId: { not: null } }),
                ...(hostelType ? { hostelType: hostelType as HostelType } : {}),
            },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            // "Not currently allocated" = no ACTIVE allocation row (regardless of year).
            hostelAllocations: { none: { status: 'ACTIVE' } },
            ...(search
                ? {
                      AND: [
                          {
                              OR: [
                                  { name: { contains: search, mode: 'insensitive' } },
                                  { phone: { contains: search } },
                                  { applicationId: { contains: search, mode: 'insensitive' } },
                              ],
                          },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                skip,
                take: limitNum,
                orderBy: [{ createdAt: 'desc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    gender: true,
                    phone: true,
                    email: true,
                    profilePhotoUrl: true,
                    createdAt: true,
                    admissionDetails: {
                        select: {
                            status: true,
                            hostelType: true,
                            hostelPaymentMode: true,
                            hostelId: true,
                            hostel: { select: { id: true, name: true, type: true } },
                            allottedCourse: { select: { id: true, name: true } },
                        },
                    },
                    hostelAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        select: {
                            id: true, status: true, startDate: true, endDate: true,
                            academicYearId: true,
                            academicYear: { select: { id: true, code: true, isActive: true } },
                        },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const enhanced = await Promise.all(
            students.map(async (s: any) => {
                const activeAlloc = s.hostelAllocations?.[0] ?? null;
                const { hostelAllocations, ...rest } = s;
                return {
                    ...rest,
                    hostelAllocation: activeAlloc,
                    profilePhotoUrl: await convertToPresignedUrl(s.profilePhotoUrl),
                    allocationStatus: activeAlloc?.status ?? 'NOT_ALLOCATED',
                };
            })
        );

        return {
            students: enhanced,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
            },
        };
    },

    /**
     * List every student with an active bed allocation (across all hostels).
     * Used for the "all bed-allocated students" report.
     */
    async getBedAllocatedStudents(query: any) {
        const { page = 1, limit = 10, search, gender, all } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;
        const fetchAll = !!all;

        const where: Prisma.StudentWhereInput = {
            hostelAllocations: { some: { status: 'ACTIVE' } },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            ...(search
                ? {
                      OR: [
                          { name: { contains: search, mode: 'insensitive' } },
                          { phone: { contains: search } },
                          { applicationId: { contains: search, mode: 'insensitive' } },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                ...(fetchAll ? {} : { skip, take: limitNum }),
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    phone: true,
                    gender: true,
                    admissionDetails: {
                        select: {
                            hostelType: true,
                            hostelPaymentMode: true,
                            allottedCourse: { select: { id: true, name: true } },
                        },
                    },
                    hostelAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        select: {
                            id: true,
                            startDate: true,
                            bedId: true,
                            academicYearId: true,
                            academicYear: { select: { id: true, code: true, isActive: true } },
                            bed: {
                                select: {
                                    id: true,
                                    number: true,
                                    room: {
                                        select: {
                                            id: true,
                                            number: true,
                                            floor: true,
                                            capacity: true,
                                            type: true,
                                            hostel: {
                                                select: { id: true, name: true, type: true },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const shaped = students.map((s: any) => {
            const alloc = s.hostelAllocations?.[0] ?? null;
            const bed = alloc?.bed;
            const room = bed?.room;
            const hostel = room?.hostel;
            return {
                id: s.id,
                applicationId: s.applicationId,
                name: s.name,
                fatherName: s.fatherName,
                phone: s.phone,
                gender: s.gender,
                courseType: s.admissionDetails?.allottedCourse?.name ?? null,
                hostelId: hostel?.id ?? null,
                hostelName: hostel?.name ?? null,
                hostelType: hostel?.type ?? null,
                sharingType: s.admissionDetails?.hostelType ?? (room ? `SHARING_${room.capacity}` : null),
                paymentMode: s.admissionDetails?.hostelPaymentMode ?? null,
                floor: room?.floor ?? null,
                roomId: room?.id ?? null,
                roomNumber: room?.number ?? null,
                roomType: room?.type ?? null,
                bedId: bed?.id ?? null,
                bedNumber: bed?.number ?? null,
                allocatedAt: alloc?.startDate ?? null,
            };
        });

        return {
            students: shaped,
            pagination: fetchAll
                ? { total, page: 1, limit: total, totalPages: 1 }
                : {
                      total,
                      page: pageNum,
                      limit: limitNum,
                      totalPages: Math.ceil(total / limitNum),
                  },
        };
    },

    /**
     * List every student with a transportRouteId set, with route fee + paid breakdown.
     * Used for the "all transport-allocated students" report.
     */
    async getTransportAllocatedStudents(query: any) {
        const { page = 1, limit = 10, search, gender, routeId, all } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;
        const fetchAll = !!all;

        const where: Prisma.StudentWhereInput = {
            AND: [
                {
                    admissionDetails: routeId
                        ? { transportRouteId: routeId }
                        : { transportRouteId: { not: null } },
                },
                ...(gender ? [{ gender: { equals: gender, mode: 'insensitive' as const } }] : []),
                ...(search
                    ? [
                          {
                              OR: [
                                  { name: { contains: search, mode: 'insensitive' as const } },
                                  { phone: { contains: search } },
                                  { applicationId: { contains: search, mode: 'insensitive' as const } },
                                  { admissionDetails: { transportRoute: { name: { contains: search, mode: 'insensitive' as const } } } },
                                  { admissionDetails: { transportRoute: { city: { contains: search, mode: 'insensitive' as const } } } },
                              ],
                          },
                      ]
                    : []),
            ],
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                ...(fetchAll ? {} : { skip, take: limitNum }),
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    phone: true,
                    gender: true,
                    degreeType: true,
                    admissionDetails: {
                        select: {
                            transportRouteId: true,
                            allottedCourse: { select: { id: true, name: true } },
                            transportRoute: {
                                select: { id: true, name: true, cost: true, busNumber: true, city: true },
                            },
                        },
                    },
                    feeDemands: {
                        where: {
                            isDeleted: false,
                            feeHead: { component: PaymentComponent.TRANSPORT },
                        },
                        select: { netAmount: true, amount: true, status: true },
                    },
                    payments: {
                        where: {
                            component: PaymentComponent.TRANSPORT,
                            status: PaymentStatus.SUCCESS,
                            isDeleted: false,
                        },
                        select: { amount: true },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const shaped = students.map((s: any) => {
            const route = s.admissionDetails?.transportRoute;
            const demandTotal = (s.feeDemands as any[]).reduce(
                (sum, d) => sum + (d.netAmount ?? d.amount ?? 0),
                0
            );
            const paidTotal = (s.payments as any[]).reduce(
                (sum, p) => sum + (p.amount ?? 0),
                0
            );
            // Route fee: prefer the frozen demand amount; fall back to route.cost
            // (covers students who have transportRouteId set but no demand yet).
            const transportRouteFee = demandTotal > 0 ? demandTotal : (route?.cost ?? 0);
            return {
                id: s.id,
                applicationId: s.applicationId,
                name: s.name,
                fatherName: s.fatherName,
                phone: s.phone,
                gender: s.gender,
                degreeType: s.degreeType,
                courseName: s.admissionDetails?.allottedCourse?.name ?? null,
                routeId: route?.id ?? null,
                routeName: route?.name ?? null,
                busNumber: route?.busNumber ?? null,
                city: route?.city ?? null,
                transportRouteFee,
                transportFeePaid: paidTotal,
                balance: Math.max(0, transportRouteFee - paidTotal),
            };
        });

        return {
            students: shaped,
            pagination: fetchAll
                ? { total, page: 1, limit: total, totalPages: 1 }
                : {
                      total,
                      page: pageNum,
                      limit: limitNum,
                      totalPages: Math.ceil(total / limitNum),
                  },
        };
    },

    /**
     * List all students with accommodationType=HOSTEL who have paid at least
     * ₹1 toward any hostel-tagged component (HOSTEL / HOSTEL_ACCOMMODATION /
     * HOSTEL_MESS / HOSTEL_LAUNDRY / HOSTEL_REGISTRATION).
     * No hostelId filter — spans all hostels.
     */
    async getHostelPaidStudents(query: any) {
        const { page = 1, limit = 10, search, gender, hostelType, all } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;
        const fetchAll = !!all;

        const hostelComponents = [
            PaymentComponent.HOSTEL,
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ];

        const where: Prisma.StudentWhereInput = {
            admissionDetails: {
                accommodationType: AccommodationType.HOSTEL,
                ...(hostelType ? { hostelType: hostelType as HostelType } : {}),
            },
            // At least one successful hostel-tagged payment exists for this student.
            payments: {
                some: {
                    component: { in: hostelComponents },
                    status: PaymentStatus.SUCCESS,
                    isDeleted: false,
                    amount: { gt: 0 },
                },
            },
            // Exclude students who already have an ACTIVE bed allocation (in any year).
            hostelAllocations: { none: { status: 'ACTIVE' } },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            ...(search
                ? {
                      OR: [
                          { name: { contains: search, mode: 'insensitive' } },
                          { phone: { contains: search } },
                          { applicationId: { contains: search, mode: 'insensitive' } },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                ...(fetchAll ? {} : { skip, take: limitNum }),
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    phone: true,
                    gender: true,
                    degreeType: true,
                    admissionDetails: {
                        select: {
                            hostelType: true,
                            hostelPaymentMode: true,
                            roomNumber: true,
                            hostelId: true,
                            hostel: { select: { id: true, name: true, type: true } },
                            allottedCourse: { select: { id: true, name: true } },
                        },
                    },
                    feeDemands: {
                        where: {
                            isDeleted: false,
                            feeHead: { component: { in: hostelComponents } },
                        },
                        select: { netAmount: true, amount: true },
                    },
                    payments: {
                        where: {
                            component: { in: hostelComponents },
                            status: PaymentStatus.SUCCESS,
                            isDeleted: false,
                        },
                        select: { amount: true },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const shaped = students.map((s: any) => {
            const hostelDemandTotal = (s.feeDemands as any[]).reduce(
                (sum, d) => sum + (d.netAmount ?? d.amount ?? 0),
                0
            );
            const hostelPaid = (s.payments as any[]).reduce(
                (sum, p) => sum + (p.amount ?? 0),
                0
            );
            return {
                id: s.id,
                applicationId: s.applicationId,
                name: s.name,
                fatherName: s.fatherName,
                phone: s.phone,
                gender: s.gender,
                degreeType: s.degreeType,
                courseName: s.admissionDetails?.allottedCourse?.name ?? null,
                hostelId: s.admissionDetails?.hostel?.id ?? null,
                hostelName: s.admissionDetails?.hostel?.name ?? null,
                hostelType: s.admissionDetails?.hostelType ?? null,
                hostelPaymentMode: s.admissionDetails?.hostelPaymentMode ?? null,
                roomNumber: s.admissionDetails?.roomNumber ?? null,
                hostelTotal: hostelDemandTotal,
                hostelPaid,
                balance: Math.max(0, hostelDemandTotal - hostelPaid),
            };
        });

        return {
            students: shaped,
            pagination: fetchAll
                ? { total, page: 1, limit: total, totalPages: 1 }
                : {
                      total,
                      page: pageNum,
                      limit: limitNum,
                      totalPages: Math.ceil(total / limitNum),
                  },
        };
    },

    /**
     * List all students with accommodationType=TRANSPORT who have paid at least
     * ₹1 toward the TRANSPORT component. Optional routeId filters to a single route.
     */
    async getTransportPaidStudents(query: any) {
        const { page = 1, limit = 10, search, gender, routeId, all } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;
        const fetchAll = !!all;

        const where: Prisma.StudentWhereInput = {
            // "Paid transport" is defined by an actual TRANSPORT payment, not by
            // accommodationType — some students who paid have a transportRouteId set
            // but accommodationType still NONE (e.g. paid before/without the assign
            // flow). Mirror getTransportAllocatedStudents, which keys off the route.
            ...(routeId ? { admissionDetails: { transportRouteId: routeId } } : {}),
            // At least one successful TRANSPORT payment exists for this student.
            payments: {
                some: {
                    component: PaymentComponent.TRANSPORT,
                    status: PaymentStatus.SUCCESS,
                    isDeleted: false,
                    amount: { gt: 0 },
                },
            },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            ...(search
                ? {
                      OR: [
                          { name: { contains: search, mode: 'insensitive' } },
                          { phone: { contains: search } },
                          { applicationId: { contains: search, mode: 'insensitive' } },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                ...(fetchAll ? {} : { skip, take: limitNum }),
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    phone: true,
                    gender: true,
                    degreeType: true,
                    admissionDetails: {
                        select: {
                            transportRouteId: true,
                            allottedCourse: { select: { id: true, name: true } },
                            transportRoute: {
                                select: { id: true, name: true, cost: true, busNumber: true, city: true },
                            },
                        },
                    },
                    feeDemands: {
                        where: {
                            isDeleted: false,
                            feeHead: { component: PaymentComponent.TRANSPORT },
                        },
                        select: { netAmount: true, amount: true },
                    },
                    payments: {
                        where: {
                            component: PaymentComponent.TRANSPORT,
                            status: PaymentStatus.SUCCESS,
                            isDeleted: false,
                        },
                        select: { amount: true },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const shaped = students.map((s: any) => {
            const route = s.admissionDetails?.transportRoute;
            const demandTotal = (s.feeDemands as any[]).reduce(
                (sum, d) => sum + (d.netAmount ?? d.amount ?? 0),
                0
            );
            const paidTotal = (s.payments as any[]).reduce(
                (sum, p) => sum + (p.amount ?? 0),
                0
            );
            const transportRouteFee = demandTotal > 0 ? demandTotal : (route?.cost ?? 0);
            return {
                id: s.id,
                applicationId: s.applicationId,
                name: s.name,
                fatherName: s.fatherName,
                phone: s.phone,
                gender: s.gender,
                degreeType: s.degreeType,
                courseName: s.admissionDetails?.allottedCourse?.name ?? null,
                routeId: route?.id ?? null,
                routeName: route?.name ?? null,
                busNumber: route?.busNumber ?? null,
                city: route?.city ?? null,
                transportRouteFee,
                transportFeePaid: paidTotal,
                balance: Math.max(0, transportRouteFee - paidTotal),
            };
        });

        return {
            students: shaped,
            pagination: fetchAll
                ? { total, page: 1, limit: total, totalPages: 1 }
                : {
                      total,
                      page: pageNum,
                      limit: limitNum,
                      totalPages: Math.ceil(total / limitNum),
                  },
        };
    },

    /**
     * List all students assigned to a hostel (allocated or not).
     * Used by the hostel-detail roster view.
     */
    async getStudentsByHostel(hostelId: string, query: any) {
        const {
            page = 1,
            limit = 10,
            search,
            hostelType,
            gender,
            allottedCourseId,
            allocationStatus,
        } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;

        const hostel = await prisma.hostel.findUnique({
            where: { id: hostelId },
            select: { id: true, name: true, type: true, isDeleted: true }
        });
        if (!hostel || hostel.isDeleted) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

        const allocationFilter: Prisma.StudentWhereInput = (() => {
            if (allocationStatus === 'ALLOCATED') {
                return { hostelAllocations: { some: { status: 'ACTIVE' } } };
            }
            if (allocationStatus === 'NOT_ALLOCATED') {
                return { hostelAllocations: { none: { status: 'ACTIVE' } } };
            }
            return {};
        })();

        const where: Prisma.StudentWhereInput = {
            admissionDetails: {
                hostelId,
                ...(hostelType ? { hostelType: hostelType as HostelType } : {}),
                ...(allottedCourseId ? { allottedCourseId } : {}),
            },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            ...allocationFilter,
            ...(search
                ? {
                      AND: [
                          {
                              OR: [
                                  { name: { contains: search, mode: 'insensitive' } },
                                  { phone: { contains: search } },
                                  { applicationId: { contains: search, mode: 'insensitive' } },
                              ],
                          },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                skip,
                take: limitNum,
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    motherName: true,
                    gender: true,
                    phone: true,
                    profilePhotoUrl: true,
                    admissionDetails: {
                        select: {
                            hostelType: true,
                            roomNumber: true,
                            hostelPaymentMode: true,
                            allottedCourse: { select: { id: true, name: true } },
                        },
                    },
                    hostelAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        select: {
                            status: true,
                            startDate: true,
                            academicYearId: true,
                            academicYear: { select: { id: true, code: true, isActive: true } },
                            bed: {
                                select: {
                                    number: true,
                                    room: {
                                        select: { id: true, number: true, capacity: true, type: true, floor: true },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const enhanced = await Promise.all(
            students.map(async (s) => {
                const activeAlloc = (s as any).hostelAllocations?.[0] ?? null;
                return {
                    applicationId: s.applicationId,
                    name: s.name,
                    fatherName: s.fatherName,
                    motherName: s.motherName,
                    gender: s.gender,
                    phone: s.phone,
                    profilePhotoUrl: await convertToPresignedUrl(s.profilePhotoUrl),
                    hostelType: s.admissionDetails?.hostelType ?? null,
                    hostelPaymentMode: s.admissionDetails?.hostelPaymentMode ?? null,
                    roomNumber:
                        activeAlloc?.bed?.room?.number
                        ?? s.admissionDetails?.roomNumber
                        ?? null,
                    bedNumber: activeAlloc?.bed?.number ?? null,
                    floor: activeAlloc?.bed?.room?.floor ?? null,
                    allottedCourse: s.admissionDetails?.allottedCourse?.name ?? null,
                    allocationStatus: activeAlloc?.status ?? 'NOT_ALLOCATED',
                    allocatedAt: activeAlloc?.startDate ?? null,
                };
            })
        );

        return {
            hostel: { id: hostel.id, name: hostel.name, type: hostel.type },
            students: enhanced,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
            },
        };
    },

    /**
     * Allocate a specific bed to a student who already has accommodationType=HOSTEL.
     * Atomically:
     *   - Validates student + bed eligibility
     *   - Updates StudentAdmission { hostelType, roomNumber }
     *   - Creates HostelAllocation row, marks bed occupied
     *   - Snapshots pricing into StudentAccommodationPricing
     *   - Creates StudentFeeDemand rows (one per fee component)
     *   - Increments StudentAdmission.totalFee
     */
    async allocateBed(studentId: string, bedId: string, hostelIdFromBody: string | undefined, _academicYearIdInput: string | undefined, adminId: string | undefined) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'allocate bed');
        assertHostelAccommodation(ctx.admission, 'Run assign-hostel first.');
        assertNoBedAllocated(ctx.accommodationPricing as any, 'Use re-allocation flow.'); // legacy guard kept; superseded by HostelAllocation lookup below
        const admission = ctx.admission!;
        if (!ctx.accommodationPricing) {
            throw new AppError('No pricing snapshot. Run assign-hostel first.', 400);
        }
        const existingAllocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });
        if (existingAllocation) {
            throw new AppError('Student already has an active bed allocation. Use the reassign-hostel flow.', 409);
        }

        const bed = await prisma.hostelBed.findUnique({
            where: { id: bedId },
            include: { room: true, allocations: { where: { status: 'ACTIVE' }, take: 1 } }
        });
        if (!bed) throw new AppError('Bed not found', 404);
        if ((bed as any).allocations?.length > 0) throw new AppError('Bed is already allocated to another student', 409);
        if (bed.room.isDeleted) throw new AppError('Cannot allocate a bed in a deleted room', 400);

        // hostelId resolution & consistency check:
        // Body-provided > admission.hostelId. Bed's room must belong to the resolved hostelId.
        const targetHostelId = hostelIdFromBody ?? admission.hostelId;
        if (!targetHostelId) {
            throw new AppError('Student has no hostel assigned. Pass hostelId in body or run assign-hostel first.', 400);
        }
        if (bed.room.hostelId !== targetHostelId) {
            throw new AppError("Bed does not belong to the assigned hostel", 400);
        }
        if (admission.hostelId && hostelIdFromBody && admission.hostelId !== hostelIdFromBody) {
            throw new AppError(`hostelId mismatch: admission has ${admission.hostelId}, body has ${hostelIdFromBody}`, 400);
        }

        // Snapshot's sharing tier must match the bed's room capacity.
        if (bed.room.capacity !== ctx.accommodationPricing.sharing) {
            throw new AppError(
                `Snapshot is for SHARING_${ctx.accommodationPricing.sharing} but bed is in a ${bed.room.capacity}-sharing room. Re-run assign-hostel with the correct hostelType.`,
                400
            );
        }

        const result = await prisma.$transaction(async (tx) => {
            // academicYearId is required (per-year allocation history). Fail fast if no active year.
            const hostelAllocYearId = (await getActiveAcademicYear(tx)).id;
            // Upsert by (studentId, academicYearId): re-allocating in the same year (after a
            // prior VACATED row in that year) updates the existing row instead of failing.
            await (tx.hostelAllocation as any).upsert({
                where: { studentId_academicYearId: { studentId, academicYearId: hostelAllocYearId } },
                create: {
                    studentId,
                    bedId,
                    startDate: new Date(),
                    status: 'ACTIVE',
                    academicYearId: hostelAllocYearId,
                    createdBy: adminId
                },
                update: {
                    bedId,
                    startDate: new Date(),
                    endDate: null,
                    status: 'ACTIVE',
                    updatedBy: adminId
                }
            });

            await tx.hostelBed.update({
                where: { id: bedId },
                data: { isOccupied: true, updatedBy: adminId }
            });

            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    hostelId: targetHostelId,             // persist (idempotent if already set)
                    roomNumber: bed.room.number,
                }
            });

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'BED_ALLOCATED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        bedId, bedNumber: bed.number,
                        roomId: bed.room.id, roomNumber: bed.room.number,
                        hostelId: targetHostelId,
                        hostelType: admission.hostelType,
                        hostelIdSource: hostelIdFromBody ? 'body' : 'admission',
                    }
                }
            });

            return {
                allocation: { studentId, bedId, hostelId: targetHostelId, roomNumber: bed.room.number, hostelType: admission.hostelType },
            };
        });

        // Generate hostel allotment order PDF (best-effort, post-transaction).
        generateAndSaveHostelAllotmentOrder(studentId).catch(() => { /* logged inside */ });

        return result;
    },

    /**
     * Bulk-allocate vacant beds in ONE room to a list of students.
     *
     * Use case: admin picks a room with N vacant beds + provides up to N student IDs.
     * System fills the beds in order (`bed.number` ASC).
     *
     * Pre-validates everyone first, then executes the whole batch atomically.
     * If ANY student fails validation, NONE are allocated — admin fixes the input list and retries.
     *
     * Each successful student gets:
     *   - StudentAdmission updated (accommodationType=HOSTEL, hostelId, hostelType, roomNumber, paymentMode, totalFee+=effectiveTotal)
     *   - HostelAllocation row created (status=ACTIVE)
     *   - HostelBed marked occupied
     *   - StudentAccommodationPricing snapshot created
     *   - StudentFeeDemand rows created (per available FeeHead)
     */
    async bulkAllocateRoomBeds(
        roomId: string,
        studentIds: string[],
        _academicYearIdInput: string | undefined,
        adminId: string | undefined
    ) {
        // 1. Validate room. "Vacant" = bed has no ACTIVE allocation (VACATED rows from prior years are OK).
        const room = await prisma.hostelRoom.findUnique({
            where: { id: roomId },
            include: {
                hostel: true,
                beds: {
                    where: { allocations: { none: { status: 'ACTIVE' } } },
                    orderBy: { number: 'asc' },
                    include: { allocations: { where: { status: 'ACTIVE' }, take: 1 } }
                }
            }
        });
        if (!room) throw new AppError('Room not found', 404);
        if (room.isDeleted) throw new AppError('Cannot allocate beds in a deleted room', 400);
        if (room.hostel.isDeleted) throw new AppError("Cannot allocate beds in a deleted hostel", 400);

        const vacantBeds = room.beds;
        if (vacantBeds.length === 0) {
            throw new AppError('No vacant beds in this room', 400);
        }
        if (studentIds.length > vacantBeds.length) {
            throw new AppError(
                `Room has ${vacantBeds.length} vacant bed(s) but ${studentIds.length} students supplied. Reduce the list or pick another room.`,
                400
            );
        }

        const hostelId = room.hostelId;
        const sharing = room.capacity;
        const hostelType = `SHARING_${sharing}` as HostelType;

        // 2. Validate every student up-front. Pricing was set at assign-hostel,
        // so we just verify each student has a snapshot matching this room's sharing tier.
        const students = await prisma.student.findMany({
            where: { id: { in: studentIds } },
            include: {
                admissionDetails: true,
                accommodationPricing: { where: { isActive: true }, take: 1 }
            } as any
        }) as any[];

        const studentMap = new Map(students.map(s => [s.id, s]));
        const validationErrors: { studentId: string; reason: string }[] = [];

        // Only ACTIVE allocations matter for blocking — VACATED rows are historical.
        const allocations = await prisma.hostelAllocation.findMany({
            where: { studentId: { in: studentIds }, status: 'ACTIVE' }
        });
        const allocByStudent = new Map(allocations.map(a => [a.studentId, a]));

        for (const sid of studentIds) {
            const s = studentMap.get(sid);
            if (!s) { validationErrors.push({ studentId: sid, reason: 'Student not found' }); continue; }
            if (!s.admissionDetails) {
                validationErrors.push({ studentId: sid, reason: 'No admission record' });
                continue;
            }
            if (s.admissionDetails.status === AdmissionStatus.CANCELLED) {
                validationErrors.push({ studentId: sid, reason: 'Admission is cancelled' });
                continue;
            }
            const existingAlloc = allocByStudent.get(sid);
            if (existingAlloc) {
                validationErrors.push({ studentId: sid, reason: 'Already has an active bed allocation' });
                continue;
            }
            if (s.admissionDetails.accommodationType !== AccommodationType.HOSTEL) {
                validationErrors.push({
                    studentId: sid,
                    reason: `accommodationType is ${s.admissionDetails.accommodationType}, expected HOSTEL. Run assign-hostel first.`
                });
                continue;
            }
            if (!s.admissionDetails.hostelId) {
                validationErrors.push({ studentId: sid, reason: 'No hostel assigned. Run assign-hostel first.' });
                continue;
            }
            if (s.admissionDetails.hostelId !== hostelId) {
                validationErrors.push({
                    studentId: sid,
                    reason: `Assigned to a different hostel (${s.admissionDetails.hostelId}). Reassign first.`
                });
                continue;
            }
            const activePricing = s.accommodationPricing?.[0];
            if (!activePricing) {
                validationErrors.push({
                    studentId: sid,
                    reason: 'No pricing snapshot. Run assign-hostel first.'
                });
                continue;
            }
            if (activePricing.sharing !== sharing) {
                validationErrors.push({
                    studentId: sid,
                    reason: `Snapshot is for SHARING_${activePricing.sharing} but room is SHARING_${sharing}. Re-run assign-hostel with the correct hostelType.`
                });
                continue;
            }
        }

        if (validationErrors.length > 0) {
            return {
                success: false,
                phase: 'PRE_VALIDATION',
                roomId,
                roomNumber: room.number,
                hostelId,
                requested: studentIds.length,
                vacantBedsAvailable: vacantBeds.length,
                allocated: 0,
                errors: validationErrors,
                message: 'No students were allocated. Fix the validation errors above and retry.'
            };
        }

        // Pair students with beds (in input order)
        const pairs = studentIds.map((sid, idx) => ({
            studentId: sid,
            bed: vacantBeds[idx]
        }));

        const allocated: any[] = [];
        await prisma.$transaction(async (tx) => {
            // academicYearId is required now (per-year history). Fail fast if no active year configured.
            const hostelAllocYearId = (await getActiveAcademicYear(tx)).id;
            for (const { studentId, bed } of pairs) {
                const student = studentMap.get(studentId)!;

                // Upsert by (studentId, academicYearId): if the student previously VACATED in this
                // same year, reuse that row instead of failing the composite unique.
                await (tx.hostelAllocation as any).upsert({
                    where: { studentId_academicYearId: { studentId, academicYearId: hostelAllocYearId } },
                    create: {
                        studentId,
                        bedId: bed.id,
                        startDate: new Date(),
                        status: 'ACTIVE',
                        academicYearId: hostelAllocYearId,
                        createdBy: adminId
                    },
                    update: {
                        bedId: bed.id,
                        startDate: new Date(),
                        endDate: null,
                        status: 'ACTIVE',
                        updatedBy: adminId
                    }
                });

                await tx.hostelBed.update({
                    where: { id: bed.id },
                    data: { isOccupied: true, updatedBy: adminId }
                });

                await tx.studentAdmission.update({
                    where: { studentId },
                    data: { roomNumber: room.number }
                });

                await tx.auditLog.create({
                    data: {
                        userId: adminId,
                        action: 'BED_ALLOCATED_BULK',
                        entity: 'StudentAdmission',
                        entityId: studentId,
                        details: {
                            bedId: bed.id, bedNumber: bed.number,
                            roomId, roomNumber: room.number,
                            hostelId,
                            hostelType,
                            sharing,
                            batchSize: pairs.length,
                        }
                    }
                });

                allocated.push({
                    studentId,
                    studentName: student.name,
                    bedId: bed.id,
                    bedNumber: bed.number,
                });
            }
        }, { timeout: 60000 });

        // Generate hostel allotment orders for each allocated student (best-effort, post-transaction).
        for (const a of allocated) {
            generateAndSaveHostelAllotmentOrder(a.studentId).catch(() => { /* logged inside */ });
        }

        return {
            success: true,
            phase: 'COMPLETED',
            roomId,
            roomNumber: room.number,
            hostelId,
            hostelType,
            requested: studentIds.length,
            allocated: allocated.length,
            remainingVacantInRoom: vacantBeds.length - allocated.length,
            allocations: allocated,
        };
    },

    /**
     * Re-assign a student to a different hostel/bed AFTER initial bed allocation.
     * Atomically:
     *   - Vacates old bed (HostelAllocation status flips to ACTIVE on new bed; old bed isOccupied=false)
     *   - Updates StudentAdmission (hostelId, hostelType, roomNumber, paymentMode, totalFee delta)
     *   - Replaces StudentAccommodationPricing snapshot
     *   - Soft-deletes outstanding hostel fee demands (paid history preserved)
     *   - Creates new fee demands for new pricing
     *   - Writes a StudentLedger entry for the audit trail
     */
    async reassignHostel(
        studentId: string,
        args: {
            hostelId: string;
            bedId: string;
            hostelPaymentMode: 'YEARWISE' | 'SEMWISE';
            reason: string;
            // Admin override: when present, these per-component amounts fully replace
            // the config price tier. Credit/discount/refund logic still applies on top.
            customPricing?: { accommodation: number; mess: number; laundry: number; registration: number };
        },
        adminId: string | undefined
    ) {
        // 1. Validate student
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'reassign hostel');
        assertHostelAccommodation(ctx.admission, 'Use assign-hostel + allocate-bed first.');
        const admission = ctx.admission!;
        const oldPricing = ctx.accommodationPricing;
        if (!oldPricing) {
            throw new AppError('Student has no allocated bed yet. Use allocate-bed first.', 400);
        }
        // Reject if the year these demands belong to has been closed.
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        // 2. Find old allocation (the current ACTIVE row regardless of year)
        const oldAllocation = await (prisma.hostelAllocation as any).findFirst({
            where: { studentId, status: 'ACTIVE' },
            include: { bed: { include: { room: true } } }
        });
        if (!oldAllocation) throw new AppError('No active bed allocation found', 404);

        // 3. Validate new bed
        const newBed = await prisma.hostelBed.findUnique({
            where: { id: args.bedId },
            include: { room: true, allocations: { where: { status: 'ACTIVE' }, take: 1 } }
        });
        if (!newBed) throw new AppError('New bed not found', 404);
        if (newBed.room.isDeleted) throw new AppError('Cannot allocate a bed in a deleted room', 400);
        if (newBed.room.hostelId !== args.hostelId) {
            throw new AppError('Bed does not belong to the selected hostel', 400);
        }
        // Allow same bed (paymentMode-only change), but block if different student holds it
        const newBedActive = (newBed as any).allocations?.[0];
        if (newBedActive && newBed.id !== oldAllocation.bedId) {
            throw new AppError('New bed is already allocated to another student', 409);
        }

        // 4. Validate new hostel
        const newHostel = await prisma.hostel.findUnique({ where: { id: args.hostelId } });
        if (!newHostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (newHostel.isDeleted) throw new AppError('Cannot reassign to a deleted hostel', 400);

        // Capacity check only if moving to a different hostel
        if (args.hostelId !== oldPricing.hostelId) {
            await assertHostelHasCapacity(args.hostelId);
        }

        // 5. Compute new pricing.
        //   - customPricing present → admin override: use those amounts verbatim and
        //     skip the config tier entirely (pricingSource = CUSTOM).
        //   - otherwise → year-scoped config tier (falls back to legacy year-null row).
        const sharing = newBed.room.capacity;
        const roomType = newBed.room.type;
        const isSemwise = args.hostelPaymentMode === 'SEMWISE';

        let accommodationPrice: number;
        let messPrice: number;
        let laundryPrice: number;
        let registrationFee: number;
        let pricingSource: 'CONFIG' | 'CUSTOM';

        if (args.customPricing) {
            accommodationPrice = args.customPricing.accommodation;
            messPrice          = args.customPricing.mess;
            laundryPrice       = args.customPricing.laundry;
            registrationFee    = args.customPricing.registration;
            pricingSource      = 'CUSTOM';
        } else {
            const priceCategory = await resolveHostelPriceCategory(
                { sharing, roomType, academicYearId: admission.academicYearId }
            );
            if (!priceCategory) {
                throw new AppError(`No active price tier found for sharing=${sharing}, roomType=${roomType} in academic year ${admission.academicYearId ?? '<none>'}.`, 400);
            }
            accommodationPrice = ((priceCategory as any)[isSemwise ? 'accommodationSemwise' : 'accommodationYearwise']) ?? 0;
            messPrice          = ((priceCategory as any)[isSemwise ? 'messSemwise' : 'messYearwise']) ?? 0;
            laundryPrice       = ((priceCategory as any)[isSemwise ? 'laundrySemwise' : 'laundryYearwise']) ?? 0;
            registrationFee    = (priceCategory as any).registrationFee ?? 0;
            pricingSource      = 'CONFIG';
        }
        const newEffectiveTotal = accommodationPrice + messPrice + laundryPrice + registrationFee;

        const newHostelType = `SHARING_${sharing}` as HostelType;
        const oldEffectiveTotal = oldPricing.effectiveTotal ?? 0;
        const totalFeeDelta = newEffectiveTotal - oldEffectiveTotal;
        // Always stamp new records with the student's CURRENT admission year (matches the
        // year used to resolve the new price tier above), not the old snapshot's year.
        const academicYearId = admission.academicYearId ?? oldPricing.academicYearId ?? undefined;

        // 6. Resolve hostel-related FeeHeads via component tag (with name-keyword fallback)
        const feeHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const accHead = feeHeadMap.get(PaymentComponent.HOSTEL_ACCOMMODATION);
        const messHead = feeHeadMap.get(PaymentComponent.HOSTEL_MESS);
        const laundryHead = feeHeadMap.get(PaymentComponent.HOSTEL_LAUNDRY);
        const regHead = feeHeadMap.get(PaymentComponent.HOSTEL_REGISTRATION);

        const hostelHeadIds = [accHead?.id, messHead?.id, laundryHead?.id, regHead?.id].filter(Boolean) as string[];

        // 7. Atomic transition. Uses Serializable isolation so two concurrent reassign
        // calls can't both read the same `availableCredit` and create duplicate
        // FeeCorrection refunds. Postgres will retry one if they collide.
        const result = await prisma.$transaction(async (tx) => {
            // 7a. Compute available hostel credit INSIDE the tx (was outside — race condition).
            // availableCredit = grossPaid − sum(prior FeeCorrection refunds, settled + pending).
            // See `getAvailableHostelCredit` in studentContext.ts.
            const credit          = await getAvailableHostelCredit(studentId, tx);
            const hostelPaid      = credit.grossPaid;
            const availableCredit = credit.availableCredit;
            const refundAmount    = availableCredit;
            // a. Vacate old bed (only if changing beds)
            if (newBed.id !== oldAllocation.bedId) {
                await tx.hostelBed.update({
                    where: { id: oldAllocation.bedId },
                    data: { isOccupied: false, updatedBy: adminId }
                });
                await tx.hostelBed.update({
                    where: { id: newBed.id },
                    data: { isOccupied: true, updatedBy: adminId }
                });
            }

            // b. Update the ACTIVE HostelAllocation row in place (one per student is active at a time).
            await (tx.hostelAllocation as any).updateMany({
                where: { studentId, status: 'ACTIVE' },
                data: {
                    bedId: newBed.id,
                    startDate: new Date(),
                    updatedBy: adminId
                }
            });

            // c. Update admission
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    hostelId: args.hostelId,
                    hostelType: newHostelType,
                    roomNumber: newBed.room.number,
                    hostelPaymentMode: isSemwise ? HostelPaymentMode.SEMWISE : HostelPaymentMode.YEARWISE,
                    totalFee: { increment: totalFeeDelta }
                }
            });

            // d. Supersede the previous snapshot and write a new active one.
            // Old rows are kept (isActive=false) for refund/audit history.
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId }
            });
            await (tx.studentAccommodationPricing as any).create({
                data: {
                    studentId,
                    academicYearId,
                    sharing,
                    roomType,
                    paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                    hostelId: args.hostelId,
                    accommodationPrice,
                    messPrice,
                    laundryPrice,
                    registrationFee,
                    effectiveTotal: newEffectiveTotal,
                    pricingSource,
                    isActive: true,
                    createdBy: adminId
                }
            });

            // e. Supersede ALL active hostel demands (not just PENDING). Already-paid amounts
            //    are re-credited into the new demands via the payment-based pool, so leaving
            //    PARTIAL/FULL rows here would only accumulate overlapping/stale demands.
            //    Soft-deleted rows are retained (isDeleted=true) as audit history.
            let supersededDemands = 0;
            if (hostelHeadIds.length > 0) {
                const result = await tx.studentFeeDemand.deleteMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds }
                    }
                });
                supersededDemands = result.count;
            }

            // f. Create new demands at full price (no embedded credit).
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const components: { head: typeof accHead; amount: number; label: string }[] = [
                { head: accHead,     amount: accommodationPrice, label: 'accommodation' },
                { head: messHead,    amount: messPrice,          label: 'mess' },
                { head: laundryHead, amount: laundryPrice,       label: 'laundry' },
                { head: regHead,     amount: registrationFee,    label: 'registration' }
            ];
            const createdDemands: string[] = [];
            const skippedComponents: string[] = [];
            for (const c of components) {
                if (!c.head) { if (c.amount > 0) skippedComponents.push(c.label); continue; }
                if (c.amount <= 0) continue;
                const d = await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: c.head.id,
                        amount: c.amount,
                        discountAmount: 0,
                        netAmount: c.amount,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: FeeStatus.PENDING,
                        remarks: `Hostel ${c.label} (re-assigned: ${newHostelType}, ${args.hostelPaymentMode})`,
                        createdBy: adminId
                    }
                });
                createdDemands.push(d.id);
            }

            let feeCorrectionId: string | null = null;
            if (refundAmount > 0) {
                const fc = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: refundAmount,
                        reason: `Hostel re-assignment refund (${args.reason})`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: oldPricing.hostelId,
                        referenceType: 'HOSTEL_REASSIGNMENT',
                        remarks: `grossPaid: ${hostelPaid}, availableCredit: ${availableCredit}, oldEffectiveTotal: ${oldEffectiveTotal}, newEffectiveTotal: ${newEffectiveTotal}, refundAmount: ${refundAmount} (full credit parked; admin to apply via apply-to-demand)`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
                feeCorrectionId = fc.id;
            }

            // g. Audit ledger entry (financial)
            await tx.studentLedger.create({
                data: {
                    studentId,
                    date: new Date(),
                    type: totalFeeDelta >= 0 ? LedgerTransactionType.DEBIT : LedgerTransactionType.CREDIT,
                    amount: Math.abs(totalFeeDelta),
                    description: `Hostel re-assigned: ${oldAllocation.bed.room.number} → ${newBed.room.number} (${newHostelType}, ${args.hostelPaymentMode}). Reason: ${args.reason}`,
                    referenceType: 'HOSTEL_REASSIGNMENT',
                    referenceId: studentId,
                    createdBy: adminId,
                    academicYearId: academicYearId
                }
            });

            // g2. Audit log entry (admin-action trace)
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'HOSTEL_REASSIGNED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousHostelId: oldPricing.hostelId,
                        previousRoomNumber: oldAllocation.bed.room.number,
                        previousBedId: oldAllocation.bedId,
                        previousPaymentMode: oldPricing.paymentMode,
                        previousEffectiveTotal: oldEffectiveTotal,
                        newHostelId: args.hostelId,
                        newRoomNumber: newBed.room.number,
                        newBedId: newBed.id,
                        newPaymentMode: args.hostelPaymentMode,
                        newEffectiveTotal,
                        pricingSource,
                        customPricing: args.customPricing ?? null,
                        feeDelta: totalFeeDelta,
                        hostelPaid,
                        availableCredit,
                        refundAmount,
                        feeCorrectionId,
                        reason: args.reason,
                    }
                }
            });

            return {
                previous: {
                    hostelId: oldPricing.hostelId,
                    hostelType: `SHARING_${oldPricing.sharing}`,
                    roomNumber: oldAllocation.bed.room.number,
                    bedNumber: oldAllocation.bed.number,
                    paymentMode: oldPricing.paymentMode,
                    effectiveTotal: oldEffectiveTotal,
                },
                current: {
                    hostelId: args.hostelId,
                    hostelType: newHostelType,
                    roomNumber: newBed.room.number,
                    bedNumber: newBed.number,
                    paymentMode: args.hostelPaymentMode,
                    effectiveTotal: newEffectiveTotal,
                    pricingSource,
                    components: { accommodationPrice, messPrice, laundryPrice, registrationFee },
                },
                feeDelta: totalFeeDelta,
                financialAdjustment: {
                    hostelPaid,
                    availableCredit,
                    studentOwes: newEffectiveTotal,
                    refundAmount,
                    feeCorrectionId,
                },
                supersededDemands,
                newDemandsCreated: createdDemands.length,
                skippedComponents: skippedComponents.length > 0
                    ? `Missing FeeHead for: ${skippedComponents.join(', ')}`
                    : null,
                reason: args.reason
            };
        }, {
            // Serializable isolation prevents two concurrent reassign requests from
            // both reading the same `availableCredit` and creating duplicate
            // FeeCorrection refunds. Postgres will retry one of them automatically.
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 20000,
        });

        // Refresh hostel allotment order PDF post-reassignment (best-effort).
        // Replaces the existing StudentDocument under HOSTEL_ALLOTMENT_ORDER.
        generateAndSaveHostelAllotmentOrder(studentId).catch(() => { /* logged inside */ });

        return result;
    },

    /**
     * Set or update a student's hostel assignment (pre-bed-allocation).
     *
     * Allowed transitions:
     *   - NONE → HOSTEL (initial assignment)
     *   - HOSTEL → HOSTEL (change hostelId/paymentMode BEFORE bed is allocated)
     *
     * Locked once a bed is allocated (= StudentAccommodationPricing exists).
     * After bed allocation, use the re-assignment flow which handles vacating
     * the old bed and computing fee adjustments.
     */
    async assignHostel(
        studentId: string,
        hostelId: string | null | undefined,
        hostelPaymentMode: 'YEARWISE' | 'SEMWISE',
        hostelType: HostelType,
        adminId?: string,
        // Admin override: per-component amounts that fully replace the config tier.
        customPricing?: { accommodation: number; mess: number; laundry: number; registration: number }
    ) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'assign hostel');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        // TRANSPORT/other → HOSTEL is a different flow. Block it.
        if (
            admission.accommodationType !== AccommodationType.NONE &&
            admission.accommodationType !== AccommodationType.HOSTEL
        ) {
            throw new AppError(
                `Student has accommodation type "${admission.accommodationType}". Use the change-accommodation flow to switch to HOSTEL.`,
                409
            );
        }

        // Block re-assignment after a bed is bound. Use reassign-hostel instead.
        const existingAllocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });
        if (existingAllocation) {
            throw new AppError('Bed already allocated. Use the reassign-hostel flow to change hostel/sharing/mode.', 409);
        }

        // hostelId is optional at this stage: assign-hostel sets the pricing tier +
        // payment mode + fee demands; the specific hostel (and bed) can be bound later
        // via allocate-bed. When provided, validate it and check capacity.
        let hostel: { id: string; name: string; isDeleted: boolean } | null = null;
        if (hostelId) {
            hostel = await prisma.hostel.findUnique({ where: { id: hostelId } }) as any;
            if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
            if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);

            // Skip capacity check when just changing payment mode on the same hostel
            if (hostelId !== admission.hostelId) {
                await assertHostelHasCapacity(hostelId);
            }
        }
        // Preserve any existing hostel binding when none is supplied this call.
        const resolvedHostelId = hostelId ?? admission.hostelId ?? null;

        // Derive sharing tier from hostelType. Hardcoded roomType=AC (campus has AC only today).
        const sharing = parseInt(hostelType.split('_')[1], 10);
        const roomType = 'AC';

        const isSemwise = hostelPaymentMode === 'SEMWISE';

        // Custom override → use admin amounts verbatim, skip the config tier.
        let accommodationPrice: number;
        let messPrice: number;
        let laundryPrice: number;
        let registrationFee: number;
        let pricingSource: 'CONFIG' | 'CUSTOM';

        if (customPricing) {
            accommodationPrice = customPricing.accommodation;
            messPrice          = customPricing.mess;
            laundryPrice       = customPricing.laundry;
            registrationFee    = customPricing.registration;
            pricingSource      = 'CUSTOM';
        } else {
            const priceCategory = await resolveHostelPriceCategory(
                { sharing, roomType, academicYearId: admission.academicYearId }
            );
            if (!priceCategory) {
                throw new AppError(
                    `No active price tier found for sharing=${sharing}, roomType=${roomType} in academic year ${admission.academicYearId ?? '<none>'}. Create one in HostelPriceCategory first.`,
                    400
                );
            }
            accommodationPrice = (isSemwise ? priceCategory.accommodationSemwise : priceCategory.accommodationYearwise) ?? 0;
            messPrice          = (isSemwise ? priceCategory.messSemwise : priceCategory.messYearwise) ?? 0;
            laundryPrice       = (isSemwise ? priceCategory.laundrySemwise : priceCategory.laundryYearwise) ?? 0;
            registrationFee    = priceCategory.registrationFee ?? 0;
            pricingSource      = 'CONFIG';
        }
        const effectiveTotal = accommodationPrice + messPrice + laundryPrice + registrationFee;

        const academicYearId = admission.academicYearId;

        // Resolve hostel fee heads
        const feeHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const accHead     = feeHeadMap.get(PaymentComponent.HOSTEL_ACCOMMODATION);
        const messHead    = feeHeadMap.get(PaymentComponent.HOSTEL_MESS);
        const laundryHead = feeHeadMap.get(PaymentComponent.HOSTEL_LAUNDRY);
        const regHead     = feeHeadMap.get(PaymentComponent.HOSTEL_REGISTRATION);

        // Diff against an existing snapshot (re-assign before bed allocation must adjust totalFee delta).
        const previousEffectiveTotal = ctx.accommodationPricing?.effectiveTotal ?? 0;
        const totalFeeDelta = effectiveTotal - previousEffectiveTotal;

        const result = await prisma.$transaction(async (tx) => {
            // NO fee-correction settlement on assign: prior leftover refunds are left untouched
            // (no reclaim/void here) so this flow never settles any FeeCorrection amount.

            // 1. Update admission (mode + tier + totals)
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.HOSTEL,
                    hostelId: resolvedHostelId,
                    hostelType,
                    hostelPaymentMode: hostelPaymentMode as HostelPaymentMode,
                    totalFee: { increment: totalFeeDelta }
                }
            });

            // 2. Hard-delete ALL existing hostel demands before creating fresh ones.
            const hostelHeadIds = [accHead?.id, messHead?.id, laundryHead?.id, regHead?.id].filter(Boolean) as string[];
            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.deleteMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                    }
                });
            }

            // 3. Supersede any prior snapshot and write a new active one.
            // Prior rows from earlier hostel cycles are kept (isActive=false) for audit/refund history.
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId }
            });
            await (tx.studentAccommodationPricing as any).create({
                data: {
                    studentId,
                    academicYearId,
                    sharing,
                    roomType,
                    paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                    hostelId: resolvedHostelId,
                    accommodationPrice,
                    messPrice,
                    laundryPrice,
                    registrationFee,
                    effectiveTotal,
                    pricingSource,
                    isActive: true,
                    createdBy: adminId
                }
            });

            // 4. Create fresh demands, netting out any payments already made against
            // the superseded demands for each fee head so the student is never
            // asked to pay twice for the same component on a re-assign.
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const demands: { feeHeadId: string; amount: number; label: string }[] = [];
            if (accHead && accommodationPrice > 0) demands.push({ feeHeadId: accHead.id, amount: accommodationPrice, label: 'accommodation' });
            if (messHead && messPrice > 0)         demands.push({ feeHeadId: messHead.id, amount: messPrice, label: 'mess' });
            if (laundryHead && laundryPrice > 0)   demands.push({ feeHeadId: laundryHead.id, amount: laundryPrice, label: 'laundry' });
            if (regHead && registrationFee > 0)    demands.push({ feeHeadId: regHead.id, amount: registrationFee, label: 'registration' });

            // Aggregate prior successful payments per fee head so we can reduce netAmount.
            // Two queries merged:
            //   (a) payments that have feeHeadId set — grouped by feeHeadId
            //   (b) payments with feeHeadId=null but matching hostel component — grouped by component
            //       (catches pre-fix payments that were created without feeHeadId resolution)
            const headToComponent = new Map<string, PaymentComponent>([
                ...(accHead    ? [[accHead.id,    PaymentComponent.HOSTEL_ACCOMMODATION]] : []) as [string, PaymentComponent][],
                ...(messHead   ? [[messHead.id,   PaymentComponent.HOSTEL_MESS]]          : []) as [string, PaymentComponent][],
                ...(laundryHead ? [[laundryHead.id, PaymentComponent.HOSTEL_LAUNDRY]]     : []) as [string, PaymentComponent][],
                ...(regHead    ? [[regHead.id,    PaymentComponent.HOSTEL_REGISTRATION]]  : []) as [string, PaymentComponent][],
            ]);
            const componentToHead = new Map<PaymentComponent, string>(
                Array.from(headToComponent.entries()).map(([h, c]) => [c, h])
            );

            const [byHeadAgg, byComponentAgg] = await Promise.all([
                tx.payment.groupBy({
                    by: ['feeHeadId'],
                    where: {
                        studentId,
                        status: PaymentStatus.SUCCESS,
                        isDeleted: false,
                        feeHeadId: { in: demands.map(d => d.feeHeadId) },
                    },
                    _sum: { amount: true },
                }),
                tx.payment.groupBy({
                    by: ['component'],
                    where: {
                        studentId,
                        status: PaymentStatus.SUCCESS,
                        isDeleted: false,
                        feeHeadId: null,
                        component: { in: [
                            PaymentComponent.HOSTEL,
                            PaymentComponent.HOSTEL_ACCOMMODATION,
                            PaymentComponent.HOSTEL_MESS,
                            PaymentComponent.HOSTEL_LAUNDRY,
                            PaymentComponent.HOSTEL_REGISTRATION,
                        ]},
                    },
                    _sum: { amount: true },
                }),
            ]);

            const priorPaidByHead = new Map<string, number>(
                (byHeadAgg as any[]).map(r => [r.feeHeadId, r._sum.amount ?? 0])
            );
            // Merge component-only payments into the same map
            for (const r of byComponentAgg as any[]) {
                const comp = r.component as PaymentComponent;
                // HOSTEL (legacy) counts toward accommodation
                const resolvedComp = comp === PaymentComponent.HOSTEL ? PaymentComponent.HOSTEL_ACCOMMODATION : comp;
                const headId = componentToHead.get(resolvedComp);
                if (headId) {
                    priorPaidByHead.set(headId, (priorPaidByHead.get(headId) ?? 0) + (r._sum.amount ?? 0));
                }
            }

            for (const d of demands) {
                const alreadyPaid = priorPaidByHead.get(d.feeHeadId) ?? 0;
                const netAmount = Math.max(0, d.amount - alreadyPaid);
                const status = netAmount === 0 ? FeeStatus.FULL : alreadyPaid > 0 ? FeeStatus.PARTIAL : FeeStatus.PENDING;
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: d.feeHeadId,
                        amount: d.amount,
                        netAmount,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status,
                        remarks: `Hostel ${d.label} (${hostelType}, ${roomType}, ${isSemwise ? 'SEMWISE' : 'YEARWISE'})`,
                        createdBy: adminId
                    }
                });
            }

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'HOSTEL_ASSIGNED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousHostelId: admission.hostelId,
                        previousAccommodationType: admission.accommodationType,
                        previousHostelType: admission.hostelType,
                        previousEffectiveTotal,
                        newHostelId: resolvedHostelId,
                        newHostelType: hostelType,
                        newPaymentMode: hostelPaymentMode,
                        newEffectiveTotal: effectiveTotal,
                        totalFeeDelta,
                        hostelName: hostel?.name ?? null,
                        sharing,
                        roomType,
                        pricingSource,
                        customPricing: customPricing ?? null,
                        feeDemandsCreated: demands.length,
                    }
                }
            });

            return {
                hostelId: resolvedHostelId,
                hostelType,
                paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                pricing: { accommodationPrice, messPrice, laundryPrice, registrationFee, effectiveTotal },
                pricingSource,
                feeDemandsCreated: demands.length,
                totalFeeDelta,
            };
        });

        return result;
    },

    /**
     * Set or update a student's transport assignment (pre-stop-allocation).
     *
     * Mirrors assignHostel but simpler — transport pricing is a single line
     * (TransportRoute.cost), no payment mode, no sharing tier.
     *
     * Allowed transitions:
     *   - NONE → TRANSPORT (initial assignment)
     *   - TRANSPORT → TRANSPORT (change route BEFORE TransportAllocation row exists)
     *
     * Locked once a TransportAllocation row exists for the student. Use a
     * separate reassign-transport flow after that.
     *
     * Side effects:
     *   - Sets accommodationType=TRANSPORT, transportRouteId on admission
     *   - Soft-deletes any prior PENDING TRANSPORT fee demand
     *   - Creates a fresh StudentFeeDemand tagged TRANSPORT with route.cost
     *   - Adjusts StudentAdmission.totalFee by the delta
     */
    async assignTransport(
        studentId: string,
        transportRouteId: string,
        adminId?: string,
        // Admin override: replaces the resolved route cost.
        customCost?: number
    ) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'assign transport');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        // HOSTEL/other → TRANSPORT is a different flow. Block it.
        if (
            admission.accommodationType !== AccommodationType.NONE &&
            admission.accommodationType !== AccommodationType.TRANSPORT
        ) {
            throw new AppError(
                `Student has accommodation type "${admission.accommodationType}". Use the change-accommodation flow to switch to TRANSPORT.`,
                409
            );
        }

        // Block re-assignment after a TransportAllocation has been created.
        const existingAllocation = await prisma.transportAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });
        if (existingAllocation) {
            throw new AppError('Student already has an active transport allocation. Use the reassign-transport flow.', 409);
        }

        // Fetch existing transportRouteId directly (not exposed on ctx.admission shape)
        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true }
        });
        const previousRouteId = admissionRow?.transportRouteId ?? null;

        const route = await prisma.transportRoute.findUnique({ where: { id: transportRouteId } });
        if (!route) throw new AppError('Transport route not found', 404);
        if (route.isDeleted) throw new AppError('Cannot assign to a deleted route', 400);
        if ((route.capacity ?? 0) > 0 && (route.filled ?? 0) >= (route.capacity ?? 0)) {
            // Allow re-assigning to the SAME route (no capacity bump needed)
            if (transportRouteId !== previousRouteId) {
                throw new AppError('Transport route is full', 400);
            }
        }

        // Resolve the TRANSPORT fee head (single component)
        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

        // Custom override → use admin cost verbatim; else year-aware route cost
        // (per-year override, falling back to route.cost).
        const academicYearId = admission.academicYearId;
        const newCost = customCost ?? await resolveTransportRouteCost(transportRouteId, academicYearId ?? null);
        const pricingSource: 'CONFIG' | 'CUSTOM' = customCost != null ? 'CUSTOM' : 'CONFIG';

        // Diff against existing PENDING TRANSPORT demand (if any) to compute totalFee delta.
        let previousCost = 0;
        if (transportHead) {
            const existingDemands = await prisma.studentFeeDemand.findMany({
                where: {
                    studentId,
                    feeHeadId: transportHead.id,
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                select: { netAmount: true, amount: true },
            });
            previousCost = existingDemands.reduce((s, d) => s + (d.netAmount ?? d.amount ?? 0), 0);
        }
        const totalFeeDelta = newCost - previousCost;

        const result = await prisma.$transaction(async (tx) => {
            // NO fee-correction settlement on assign: prior leftover refunds are left untouched
            // (no reclaim/void here) so this flow never settles any FeeCorrection amount.

            // 1. Update admission
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.TRANSPORT,
                    transportRouteId,
                    totalFee: { increment: totalFeeDelta }
                }
            });

            // 2. Supersede ALL active transport demand(s) (not just PENDING) so stale rows
            //    can't accumulate; soft-deleted rows remain as audit history.
            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId }
                });
            }

            // 3. Create fresh demand
            let feeDemandsCreated = 0;
            if (transportHead && newCost > 0) {
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 30);
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: transportHead.id,
                        amount: newCost,
                        netAmount: newCost,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: FeeStatus.PENDING,
                        remarks: `Transport (${route.name}, ${route.busNumber ?? '—'})`,
                        createdBy: adminId
                    }
                });
                feeDemandsCreated = 1;
            }

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'TRANSPORT_ASSIGNED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousAccommodationType: admission.accommodationType,
                        previousRouteId,
                        previousCost,
                        newRouteId: transportRouteId,
                        newCost,
                        totalFeeDelta,
                        routeName: route.name,
                        pricingSource,
                        customCost: customCost ?? null,
                        feeDemandsCreated,
                    }
                }
            });

            return {
                transportRouteId,
                routeName: route.name,
                cost: newCost,
                pricingSource,
                feeDemandsCreated,
                totalFeeDelta,
                missingFeeHead: !transportHead
                    ? 'No FeeHead tagged with component=TRANSPORT — fee demand was NOT created. Create the fee head and retry.'
                    : null,
            };
        });

        return result;
    },

    /**
     * Re-assign a TRANSPORT student to a different route.
     *
     * Transport doesn't have a separate "allocate" step — having a route on the
     * admission IS being on transport. So this is just: change route, replace
     * demand, adjust totalFee.
     *
     * Side effects (atomic):
     *   - Updates StudentAdmission.transportRouteId
     *   - Soft-deletes any prior PENDING TRANSPORT fee demand
     *   - Creates a fresh StudentFeeDemand using the new route's cost
     *   - Adjusts StudentAdmission.totalFee by the delta (newCost − previousPendingCost)
     *   - Writes audit log including the reason
     *
     * Pre-conditions:
     *   - Admission active, accommodationType === TRANSPORT
     *   - New route exists, not deleted, has capacity (skipped when same route)
     */
    async reassignTransport(
        studentId: string,
        args: { transportRouteId: string; reason: string; customCost?: number },
        adminId?: string
    ) {
        const { transportRouteId, reason } = args;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'reassign transport');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(
                `Student is not on TRANSPORT (currently ${admission.accommodationType}). Use assign-transport instead.`,
                400
            );
        }

        const newRoute = await prisma.transportRoute.findUnique({ where: { id: transportRouteId } });
        if (!newRoute) throw new AppError('New transport route not found', 404);
        if (newRoute.isDeleted) throw new AppError('Cannot reassign to a deleted route', 400);

        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true }
        });
        const oldRouteId = admissionRow?.transportRouteId ?? null;

        // Capacity check on the NEW route, only when actually changing routes.
        if (transportRouteId !== oldRouteId) {
            const studentsOnNewRoute = await prisma.studentAdmission.count({
                where: { transportRouteId, status: { not: 'CANCELLED' } }
            });
            if ((newRoute.capacity ?? 0) > 0 && studentsOnNewRoute >= (newRoute.capacity ?? 0)) {
                throw new AppError('New transport route is full', 400);
            }
        }

        // Resolve TRANSPORT fee head and existing PENDING cost
        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

        // Custom override → use admin cost verbatim; else the route's own cost.
        const newCost = args.customCost ?? (newRoute.cost ?? 0);
        const pricingSource: 'CONFIG' | 'CUSTOM' = args.customCost != null ? 'CUSTOM' : 'CONFIG';
        let previousCost = 0;
        if (transportHead) {
            const existingDemands = await prisma.studentFeeDemand.findMany({
                where: {
                    studentId,
                    feeHeadId: transportHead.id,
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                select: { netAmount: true, amount: true },
            });
            previousCost = existingDemands.reduce((s, d) => s + (d.netAmount ?? d.amount ?? 0), 0);
        }
        const totalFeeDelta = newCost - previousCost;

        const academicYearId = admission.academicYearId;

        const result = await prisma.$transaction(async (tx) => {
            // 1. Update admission
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    transportRouteId,
                    totalFee: { increment: totalFeeDelta },
                }
            });

            // 2. Supersede ALL active transport demand(s) (not just PENDING) so stale rows
            //    can't accumulate; soft-deleted rows remain as audit history.
            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId }
                });
            }

            // 3. Create fresh demand
            let feeDemandsCreated = 0;
            if (transportHead && newCost > 0) {
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 30);
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: transportHead.id,
                        amount: newCost,
                        netAmount: newCost,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: FeeStatus.PENDING,
                        remarks: `Transport (re-assigned: ${newRoute.name}). Reason: ${reason}`,
                        createdBy: adminId
                    }
                });
                feeDemandsCreated = 1;
            }

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'TRANSPORT_REASSIGNED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        oldRouteId,
                        newRouteId: transportRouteId,
                        previousCost,
                        newCost,
                        totalFeeDelta,
                        reason,
                        routeName: newRoute.name,
                        pricingSource,
                        customCost: args.customCost ?? null,
                    }
                }
            });

            return {
                transportRouteId,
                routeName: newRoute.name,
                cost: newCost,
                pricingSource,
                feeDemandsCreated,
                totalFeeDelta,
                missingFeeHead: !transportHead
                    ? 'No FeeHead tagged with component=TRANSPORT — fee demand was NOT created. Create the fee head and retry.'
                    : null,
            };
        });

        return result;
    },

    /**
     * Cancel a student's HOSTEL allocation: flip back to NONE, clear hostel fields,
     * vacate bed, soft-delete pending demands, drop pricing snapshot, and create a
     * FeeCorrection (type=ACCOMMODATION_CHANGE_REFUND) for any refundable amount.
     *
     * Refund formula: max(0, hostelPaid − cancellationFee).
     * - cancellationFee is the amount the college keeps as a non-refundable charge.
     * - If paid < cancellationFee, no refund is created (admin can chase the balance separately).
     */
    async cancelHostel(
        studentId: string,
        args: { cancellationFee?: number; withhold?: HostelWithhold; reason: string },
        adminId?: string
    ) {
        const reason = args.reason;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel hostel');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        if (admission.accommodationType !== AccommodationType.HOSTEL) {
            throw new AppError(
                `Student is not on HOSTEL (currently ${admission.accommodationType}). Nothing to cancel.`,
                400
            );
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) {
            throw new AppError('Cannot cancel: student has no academicYearId on admission', 400);
        }

        // Resolve hostel fee heads
        const feeHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const hostelHeadIds = Array.from(feeHeadMap.values()).filter(Boolean).map((h: any) => h.id);

        // Sum pending hostel demand (to back out from totalFee). Read outside tx —
        // the value is just a totalFee delta and doesn't affect availableCredit.
        let pendingDemandTotal = 0;
        if (hostelHeadIds.length > 0) {
            const pendingAgg = await prisma.studentFeeDemand.aggregate({
                where: {
                    studentId,
                    feeHeadId: { in: hostelHeadIds },
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                _sum: { netAmount: true },
            });
            pendingDemandTotal = pendingAgg._sum.netAmount ?? 0;
        }

        const previousHostelId = admission.hostelId;
        const previousHostelType = admission.hostelType;
        const allocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });

        const result = await prisma.$transaction(async (tx) => {
            // availableCredit = gross hostel paid (no prior-refund netting; that's the separate
            // refunds module's job). Read in-tx for race-safety.
            const credit = await getAvailableHostelCredit(studentId, tx);
            const paid = credit.grossPaid;
            const availableCredit = credit.availableCredit;

            // The admin sends what the college KEEPS (per-component `withhold`, each capped at
            // what was paid into that component; or the legacy single-lump cancellationFee).
            // Whatever is NOT kept is what we owe the student back → refundAmount, which becomes
            // a carry-forward FeeCorrection below.
            const paidByComponent = await getHostelPaidByComponent(studentId, tx);
            const { breakdown: withholdBreakdown, cancellationFee: retainedCancellationFee, total: totalWithheld } = resolveHostelWithhold(args, paidByComponent);
            const refundAmount = Math.max(0, availableCredit - totalWithheld);
            // 1. Vacate active allocation if any
            if (allocation) {
                await (tx.hostelAllocation as any).updateMany({
                    where: { studentId, status: 'ACTIVE' },
                    data: { status: 'VACATED', endDate: new Date(), updatedBy: adminId },
                });
                await tx.hostelBed.update({
                    where: { id: allocation.bedId },
                    data: { isOccupied: false, updatedBy: adminId },
                });
            }

            // 2. Soft-delete ALL active hostel demands (not just PENDING) — the service is
            //    being cancelled, so no hostel demand should remain; refund is handled via
            //    FeeCorrection from the payment-based credit pool.
            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId },
                });
            }

            // 3. Mark snapshot inactive (preserved for refund/audit history; future
            //    re-assign creates a new active row).
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId },
            });

            // 4. Reset admission to NONE
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.NONE,
                    hostelId: null,
                    hostelType: null,
                    hostelPaymentMode: null,
                    roomNumber: null,
                    totalFee: { decrement: pendingDemandTotal },
                },
            });

            let feeCorrection: any = null;
            if (refundAmount > 0 || totalWithheld > 0) {
                feeCorrection = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: refundAmount,
                        retainedAmount: totalWithheld,
                        retentionBreakdown: {
                            accommodation:   withholdBreakdown?.accommodation ?? 0,
                            mess:            withholdBreakdown?.mess          ?? 0,
                            laundry:         withholdBreakdown?.laundry       ?? 0,
                            registration:    withholdBreakdown?.registration  ?? 0,
                            cancellationFee: retainedCancellationFee ?? 0,
                        },
                        reason: `Hostel cancellation: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousHostelId,
                        referenceType: 'HOSTEL_CANCELLATION',
                        remarks: `grossPaid: ${paid}, availableCredit: ${availableCredit}, withheld: ${totalWithheld}${withholdBreakdown ? ` (acc: ${withholdBreakdown.accommodation}, mess: ${withholdBreakdown.mess}, laundry: ${withholdBreakdown.laundry}, reg: ${withholdBreakdown.registration})` : ''}, cancellationFee: ${retainedCancellationFee}, refund: ${refundAmount}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });

                if (totalWithheld > 0) {
                    await recordRetained(tx, {
                        studentId, academicYearId,
                        sourceType: RetainedRevenueSourceType.FEE_CORRECTION,
                        sourceId:   feeCorrection.id,
                        occurredAt: feeCorrection.createdAt ?? new Date(),
                        hostelId:   previousHostelId ?? undefined,
                        createdBy:  adminId,
                        expectedTotal: totalWithheld,
                        lines: [
                            { category: RetainedRevenueCategory.HOSTEL_ACCOMMODATION_USAGE,   amount: withholdBreakdown?.accommodation ?? 0 },
                            { category: RetainedRevenueCategory.HOSTEL_MESS_USAGE,            amount: withholdBreakdown?.mess          ?? 0 },
                            { category: RetainedRevenueCategory.HOSTEL_LAUNDRY_USAGE,         amount: withholdBreakdown?.laundry       ?? 0 },
                            { category: RetainedRevenueCategory.HOSTEL_REGISTRATION_RETAINED, amount: withholdBreakdown?.registration  ?? 0 },
                            { category: RetainedRevenueCategory.HOSTEL_CANCELLATION_FEE,      amount: retainedCancellationFee ?? 0 },
                        ],
                    });
                }
            }

            // 5b. Audit ledger entry for the retained portion (cancellation fee that the
            // college kept). Tagged referenceType=HOSTEL_CANCELLATION so it is visible in
            // the student's ledger / financial timeline but is SKIPPED by the per-component
            // breakdown calculation (REFUND_LIKE_REFERENCE_TYPES in getStudentFinancialHistory),
            // i.e. it never pollutes the OTHER bucket.
            if (totalWithheld > 0) {
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: LedgerTransactionType.DEBIT,
                        amount: totalWithheld,
                        description: `Hostel cancellation fee retained: ${reason}`,
                        referenceId: feeCorrection?.id ?? previousHostelId ?? null,
                        referenceType: 'HOSTEL_CANCELLATION',
                        academicYearId,
                        createdBy: adminId,
                    } as any,
                });
            }

            // 6. Audit
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'HOSTEL_CANCELLED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousHostelId,
                        previousHostelType,
                        paid,
                        totalWithheld,
                        withholdBreakdown,
                        cancellationFee: retainedCancellationFee,
                        paidByComponent,
                        refundAmount,
                        pendingDemandRemoved: pendingDemandTotal,
                        bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                        reason,
                    },
                },
            });

            return {
                paid,
                totalWithheld,
                withholdBreakdown,
                cancellationFee: retainedCancellationFee,
                paidByComponent,
                refundAmount,
                pendingDemandRemoved: pendingDemandTotal,
                bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                feeCorrectionId: feeCorrection?.id ?? null,
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 20000,
        });

        return result;
    },

    /**
     * Cancel a student's TRANSPORT route: flip back to NONE, clear transportRouteId,
     * soft-delete pending TRANSPORT demand, and create a FeeCorrection
     * (type=ACCOMMODATION_CHANGE_REFUND) for any refundable amount.
     */
    async cancelTransport(
        studentId: string,
        args: { withhold?: number; cancellationFee?: number; reason: string },
        adminId?: string
    ) {
        // Two independent levers the college keeps, ADDED together:
        //   withhold        — amount kept from what was paid into transport (capped ≤ paid).
        //   cancellationFee — a separate flat penalty on top (not capped).
        const withhold        = Math.max(0, args.withhold ?? 0);
        const cancellationFee = Math.max(0, args.cancellationFee ?? 0);
        const reason = args.reason;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel transport');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(
                `Student is not on TRANSPORT (currently ${admission.accommodationType}). Nothing to cancel.`,
                400
            );
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) {
            throw new AppError('Cannot cancel: student has no academicYearId on admission', 400);
        }

        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true },
        });
        const previousRouteId = admissionRow?.transportRouteId ?? null;

        // Resolve TRANSPORT fee head
        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

        // Available transport credit = gross transport payments − transport refunds already
        // issued (prior cancel/switch). Using gross alone would re-refund the same rupees
        // across a switch→switch-back→cancel cycle (double refund). Mirrors hostel credit.
        const transportCredit = await getAvailableTransportCredit(studentId);
        const paid = transportCredit.grossPaid;

        // Guard: the kept-from-paid `withhold` can't exceed what was paid into transport.
        // (cancellationFee is an uncapped penalty — if total kept exceeds paid the refund just
        // clamps to 0; mirrors the hostel cancellation rule.)
        if (withhold > paid) {
            throw new AppError(
                `Cannot withhold more than was paid for transport (withhold ${withhold} > paid ${paid}).`,
                400
            );
        }
        const totalRetained = withhold + cancellationFee;

        // Sum pending demand
        let pendingDemandTotal = 0;
        if (transportHead) {
            const pendingAgg = await prisma.studentFeeDemand.aggregate({
                where: {
                    studentId,
                    feeHeadId: transportHead.id,
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                _sum: { netAmount: true },
            });
            pendingDemandTotal = pendingAgg._sum.netAmount ?? 0;
        }

        const refundAmount = Math.max(0, transportCredit.availableCredit - totalRetained);

        const result = await prisma.$transaction(async (tx) => {
            // 1. Soft-delete ALL active transport demand(s) (not just PENDING) — the service
            //    is being cancelled; refund is handled via FeeCorrection.
            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId },
                });
            }

            // 2. Reset admission
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.NONE,
                    transportRouteId: null,
                    totalFee: { decrement: pendingDemandTotal },
                },
            });

            let feeCorrection: any = null;
            if (refundAmount > 0 || totalRetained > 0) {
                feeCorrection = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: refundAmount,
                        retainedAmount: totalRetained,
                        retentionBreakdown: {
                            transport:       withhold ?? 0,
                            cancellationFee: cancellationFee ?? 0,
                        },
                        reason: `Transport cancellation: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousRouteId,
                        referenceType: 'TRANSPORT_CANCELLATION',
                        remarks: `Paid: ${paid}, withhold: ${withhold}, cancellationFee: ${cancellationFee}, totalRetained: ${totalRetained}, refund: ${refundAmount}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });

                if (totalRetained > 0) {
                    await recordRetained(tx, {
                        studentId, academicYearId,
                        sourceType: RetainedRevenueSourceType.FEE_CORRECTION,
                        sourceId:   feeCorrection.id,
                        occurredAt: feeCorrection.createdAt ?? new Date(),
                        routeId:    previousRouteId ?? undefined,
                        createdBy:  adminId,
                        expectedTotal: totalRetained,
                        lines: [
                            { category: RetainedRevenueCategory.TRANSPORT_USAGE,            amount: withhold ?? 0 },
                            { category: RetainedRevenueCategory.TRANSPORT_CANCELLATION_FEE, amount: cancellationFee ?? 0 },
                        ],
                    });
                }
            }

            // 3b. Audit ledger entry for the retained portion. Same pattern as cancelHostel:
            // visible in the ledger / financial timeline, but the per-component breakdown in
            // getStudentFinancialHistory skips TRANSPORT_CANCELLATION (REFUND_LIKE_REFERENCE_TYPES)
            // so it never pollutes the OTHER bucket.
            if (totalRetained > 0) {
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: LedgerTransactionType.DEBIT,
                        amount: totalRetained,
                        description: `Transport cancellation fee retained: ${reason}`,
                        referenceId: feeCorrection?.id ?? previousRouteId ?? null,
                        referenceType: 'TRANSPORT_CANCELLATION',
                        academicYearId,
                        createdBy: adminId,
                    } as any,
                });
            }

            // 4. Audit
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'TRANSPORT_CANCELLED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousRouteId,
                        paid,
                        withhold,
                        cancellationFee,
                        totalRetained,
                        refundAmount,
                        pendingDemandRemoved: pendingDemandTotal,
                        reason,
                    },
                },
            });

            return {
                paid,
                withhold,
                cancellationFee,
                totalRetained,
                refundAmount,
                pendingDemandRemoved: pendingDemandTotal,
                feeCorrectionId: feeCorrection?.id ?? null,
            };
        });

        return result;
    },

    /**
     * One-shot switch from HOSTEL to TRANSPORT with proration.
     *
     * Money flow:
     *   refundPool   = max(0, hostelPaid − chargeRetained)
     *   (the whole refundPool goes to a carry-forward FeeCorrection; nothing is
     *    auto-applied as a discount on the new TRANSPORT demand)
     *
     * The new TRANSPORT StudentFeeDemand is billed at full price (`discountAmount=0`,
     * `netAmount=newCost`). Admin can apply the FeeCorrection credit to it later via
     * if the credit fully covers the new route).
     */
    async switchHostelToTransport(
        studentId: string,
        args: {
            // What the college KEEPS from the hostel side: per-component `withhold` (each ≤ paid
            // for that component) + a separate flat `cancellationFee`. Legacy `chargeRetained`
            // (a single flat amount) is still accepted and folded into the flat fee.
            withhold?: HostelWithhold;
            cancellationFee?: number;
            chargeRetained?: number;
            reason: string;
            transportRouteId: string;
            customCost?: number;
        },
        adminId?: string
    ) {
        const { reason, transportRouteId } = args;
        // Normalize the "kept" inputs: withhold (per-component) + cancellationFee, with legacy
        // chargeRetained treated as an additional flat fee.
        const withholdArgs = {
            withhold: args.withhold,
            cancellationFee: Math.max(0, args.cancellationFee ?? 0) + Math.max(0, args.chargeRetained ?? 0),
        };

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'switch hostel to transport');
        const admission = ctx.admission!;

        if (admission.accommodationType !== AccommodationType.HOSTEL) {
            throw new AppError(
                `Student is not on HOSTEL (currently ${admission.accommodationType}). Use assign-transport directly.`,
                400
            );
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) throw new AppError('Cannot switch: student has no academicYearId on admission', 400);
        await assertAcademicYearWritable(academicYearId);

        // Resolve fee heads
        const hostelHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const hostelHeadIds = Array.from(hostelHeadMap.values()).filter(Boolean).map((h: any) => h.id);
        const transportHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = transportHeadMap.get(PaymentComponent.TRANSPORT);

        let pendingHostelTotal = 0;
        if (hostelHeadIds.length > 0) {
            const pAgg = await prisma.studentFeeDemand.aggregate({
                where: {
                    studentId,
                    feeHeadId: { in: hostelHeadIds },
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                _sum: { netAmount: true },
            });
            pendingHostelTotal = pAgg._sum.netAmount ?? 0;
        }

        // Validate new route
        const route = await prisma.transportRoute.findUnique({ where: { id: transportRouteId } });
        if (!route) throw new AppError('Transport route not found', 404);
        if (route.isDeleted) throw new AppError('Cannot assign to a deleted route', 400);
        const studentsOnRoute = await prisma.studentAdmission.count({
            where: { transportRouteId, status: { not: 'CANCELLED' } },
        });
        if ((route.capacity ?? 0) > 0 && studentsOnRoute >= (route.capacity ?? 0)) {
            throw new AppError('Transport route is full', 400);
        }

        // Custom override → admin cost verbatim; else year-aware route cost.
        const newCost = args.customCost ?? await resolveTransportRouteCost(transportRouteId, academicYearId);
        const pricingSource: 'CONFIG' | 'CUSTOM' = args.customCost != null ? 'CUSTOM' : 'CONFIG';
        const previousHostelId = admission.hostelId;
        const previousHostelType = admission.hostelType;
        const allocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });

        const result = await prisma.$transaction(async (tx) => {
            // NO fee-correction settlement on switch: prior leftover refunds are left untouched
            // (no reclaim/void here) so this flow never settles any FeeCorrection amount.

            // NO auto-adjustment: the old hostel payment is NOT applied as a discount on the
            // new transport demand (billed at FULL cost). Instead the refundable amount
            // (hostelPaid − total kept) is returned as a carry-forward FeeCorrection the
            // student/admin settles separately. "Kept" = per-component withhold + cancellationFee.
            const credit          = await getAvailableHostelCredit(studentId, tx);
            const hostelPaid      = credit.grossPaid;
            const availableCredit = credit.availableCredit;
            const paidByComponent = await getHostelPaidByComponent(studentId, tx);
            const { breakdown: withholdBreakdown, cancellationFee: retainedCancellationFee, total: totalRetained } =
                resolveHostelWithhold(withholdArgs, paidByComponent);
            const refundPool      = Math.max(0, availableCredit - totalRetained);

            // ── 1. Cancel hostel ──
            if (allocation) {
                await (tx.hostelAllocation as any).updateMany({
                    where: { studentId, status: 'ACTIVE' },
                    data: { status: 'VACATED', endDate: new Date(), updatedBy: adminId },
                });
                await tx.hostelBed.update({
                    where: { id: allocation.bedId },
                    data: { isOccupied: false, updatedBy: adminId },
                });
            }
            // Soft-delete ALL active hostel demands (not just PENDING) — leaving the hostel,
            // so no hostel demand should remain; the paid amount becomes the switch credit.
            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId },
                });
            }
            // Mark snapshot inactive (preserved for refund/audit history).
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId },
            });

            // ── 2. Switch admission to TRANSPORT ──
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.TRANSPORT,
                    transportRouteId,
                    hostelId: null,
                    hostelType: null,
                    hostelPaymentMode: null,
                    roomNumber: null,
                    // totalFee: subtract pending hostel removed, add new transport gross
                    totalFee: { increment: newCost - pendingHostelTotal },
                },
            });

            // ── 3. Create new TRANSPORT demand at full price ──
            let feeDemandsCreated = 0;
            let createdDemandId: string | null = null;
            if (transportHead && newCost > 0) {
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 30);
                const demand = await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: transportHead.id,
                        amount: newCost,
                        discountAmount: 0,
                        netAmount: newCost,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: FeeStatus.PENDING,
                        remarks: `Transport (${route.name}). Reason: ${reason}`,
                        createdBy: adminId,
                    },
                });
                feeDemandsCreated = 1;
                createdDemandId = demand.id;
            }

            let feeCorrectionId: string | null = null;
            if (refundPool > 0 || totalRetained > 0) {
                const fc = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: refundPool,
                        retainedAmount: totalRetained,
                        retentionBreakdown: {
                            accommodation:   withholdBreakdown?.accommodation ?? 0,
                            mess:            withholdBreakdown?.mess          ?? 0,
                            laundry:         withholdBreakdown?.laundry       ?? 0,
                            registration:    withholdBreakdown?.registration  ?? 0,
                            cancellationFee: retainedCancellationFee ?? 0,
                        },
                        reason: `Hostel→Transport switch refund: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousHostelId,
                        referenceType: 'HOSTEL_TO_TRANSPORT_SWITCH',
                        remarks: `grossPaid: ${hostelPaid}, availableCredit: ${availableCredit}, withheld: ${totalRetained}${withholdBreakdown ? ` (acc: ${withholdBreakdown.accommodation}, mess: ${withholdBreakdown.mess}, laundry: ${withholdBreakdown.laundry}, reg: ${withholdBreakdown.registration})` : ''}, cancellationFee: ${retainedCancellationFee}, refund: ${refundPool} (no auto-adjustment to new transport demand)`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
                feeCorrectionId = fc.id;

                if (totalRetained > 0) {
                    await recordRetained(tx, {
                        studentId, academicYearId,
                        sourceType: RetainedRevenueSourceType.FEE_CORRECTION,
                        sourceId:   fc.id,
                        occurredAt: fc.createdAt ?? new Date(),
                        hostelId:   previousHostelId ?? undefined,
                        createdBy:  adminId,
                        expectedTotal: totalRetained,
                        lines: [
                            { category: RetainedRevenueCategory.HOSTEL_ACCOMMODATION_USAGE,   amount: withholdBreakdown?.accommodation ?? 0 },
                            { category: RetainedRevenueCategory.HOSTEL_MESS_USAGE,            amount: withholdBreakdown?.mess          ?? 0 },
                            { category: RetainedRevenueCategory.HOSTEL_LAUNDRY_USAGE,         amount: withholdBreakdown?.laundry       ?? 0 },
                            { category: RetainedRevenueCategory.HOSTEL_REGISTRATION_RETAINED, amount: withholdBreakdown?.registration  ?? 0 },
                            { category: RetainedRevenueCategory.HOSTEL_CANCELLATION_FEE,      amount: retainedCancellationFee ?? 0 },
                        ],
                    });
                }
            }

            // Audit ledger entry for the retained portion (hostel-side fee the college kept
            // at switch). Tagged HOSTEL_TO_TRANSPORT_SWITCH — visible in the student ledger
            // / financial timeline, but skipped by the per-component breakdown
            // (REFUND_LIKE_REFERENCE_TYPES in getStudentFinancialHistory), so it never
            // pollutes the OTHER bucket. Independent of `leftover > 0`: a switch can retain
            // money even when no refund is owed (full retention).
            if (totalRetained > 0) {
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: LedgerTransactionType.DEBIT,
                        amount: totalRetained,
                        description: `Hostel→Transport switch fee retained: ${reason}`,
                        referenceId: feeCorrectionId ?? previousHostelId ?? null,
                        referenceType: 'HOSTEL_TO_TRANSPORT_SWITCH',
                        academicYearId,
                        createdBy: adminId,
                    } as any,
                });
            }

            // ── 5. Audit ──
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'HOSTEL_TO_TRANSPORT_SWITCH',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousHostelId,
                        previousHostelType,
                        newRouteId: transportRouteId,
                        routeName: route.name,
                        hostelPaid,
                        withholdBreakdown,
                        cancellationFee: retainedCancellationFee,
                        totalRetained,
                        refundPool,
                        newCost,
                        pricingSource,
                        customCost: args.customCost ?? null,
                        pendingHostelRemoved: pendingHostelTotal,
                        bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                        feeDemandsCreated,
                        createdDemandId,
                        feeCorrectionId,
                        reason,
                    },
                },
            });

            return {
                cancellation: {
                    hostelPaid,
                    withholdBreakdown,
                    cancellationFee: retainedCancellationFee,
                    totalRetained,
                    refundPool,
                    pendingHostelRemoved: pendingHostelTotal,
                    bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                },
                newAssignment: {
                    transportRouteId,
                    routeName: route.name,
                    cost: newCost,
                    pricingSource,
                    studentOwes: newCost,
                    feeDemandsCreated,
                    demandId: createdDemandId,
                },
                refund: {
                    refundPool,
                    feeCorrectionId,
                },
                missingFeeHead: !transportHead
                    ? 'No FeeHead tagged with component=TRANSPORT — fee demand was NOT created.'
                    : null,
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 20000,
        });

        return result;
    },

    /**
     * One-shot switch from TRANSPORT to HOSTEL with proration.
     * Same idea as the reverse: refund pool from transport (paid − chargeRetained) is
     * applied as a discount across the NEW hostel demand rows (split proportionally
     * across the four components), and any leftover goes to FeeCorrection.
     */
    async switchTransportToHostel(
        studentId: string,
        args: {
            // withhold capped ≤ availableCredit; cancellationFee uncapped. chargeRetained
            // is the legacy single-lump param, folded into the flat penalty.
            withhold?: number;
            cancellationFee?: number;
            chargeRetained?: number;
            reason: string;
            // Optional — the switch + demands + refund are committed by sharing tier;
            // the specific hostel/bed can be assigned later (assign-hostel/allocate-bed).
            hostelId?: string;
            hostelType: HostelType;
            hostelPaymentMode: 'YEARWISE' | 'SEMWISE';
            // Admin override for the new hostel charge (replaces config tier).
            customPricing?: { accommodation: number; mess: number; laundry: number; registration: number };
        },
        adminId?: string
    ) {
        const withhold        = Math.max(0, args.withhold ?? 0);
        const cancellationFee = Math.max(0, args.cancellationFee ?? 0);
        // Legacy single-lump param. Treated as additional flat penalty on top of cancellationFee.
        const chargeRetainedLegacy = Math.max(0, args.chargeRetained ?? 0);
        const flatPenalty = cancellationFee + chargeRetainedLegacy;
        const { reason, hostelId, hostelType, hostelPaymentMode } = args;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'switch transport to hostel');
        const admission = ctx.admission!;

        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(
                `Student is not on TRANSPORT (currently ${admission.accommodationType}). Use assign-hostel directly.`,
                400
            );
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) throw new AppError('Cannot switch: student has no academicYearId on admission', 400);
        await assertAcademicYearWritable(academicYearId);

        // Resolve fee heads
        const transportHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = transportHeadMap.get(PaymentComponent.TRANSPORT);
        const hostelHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const accHead = hostelHeadMap.get(PaymentComponent.HOSTEL_ACCOMMODATION);
        const messHead = hostelHeadMap.get(PaymentComponent.HOSTEL_MESS);
        const laundryHead = hostelHeadMap.get(PaymentComponent.HOSTEL_LAUNDRY);
        const regHead = hostelHeadMap.get(PaymentComponent.HOSTEL_REGISTRATION);

        // Validate new hostel only if one was chosen. hostelId is optional here —
        // the switch commits by sharing tier; the specific hostel/bed is assigned later.
        if (hostelId) {
            const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
            if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
            if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);
            await assertHostelHasCapacity(hostelId);
        }

        const sharing = parseInt(hostelType.split('_')[1], 10);
        const roomType = 'AC';
        const isSemwise = hostelPaymentMode === 'SEMWISE';

        // Custom override → use admin amounts verbatim, skip the config tier.
        let accommodationPrice: number;
        let messPrice: number;
        let laundryPrice: number;
        let registrationFee: number;
        let pricingSource: 'CONFIG' | 'CUSTOM';

        if (args.customPricing) {
            accommodationPrice = args.customPricing.accommodation;
            messPrice          = args.customPricing.mess;
            laundryPrice       = args.customPricing.laundry;
            registrationFee    = args.customPricing.registration;
            pricingSource      = 'CUSTOM';
        } else {
            const priceCategory = await resolveHostelPriceCategory(
                { sharing, roomType, academicYearId }
            );
            if (!priceCategory) {
                throw new AppError(`No active price tier for sharing=${sharing}, roomType=${roomType} in academic year ${academicYearId}.`, 400);
            }
            accommodationPrice = (isSemwise ? priceCategory.accommodationSemwise : priceCategory.accommodationYearwise) ?? 0;
            messPrice          = (isSemwise ? priceCategory.messSemwise : priceCategory.messYearwise) ?? 0;
            laundryPrice       = (isSemwise ? priceCategory.laundrySemwise : priceCategory.laundryYearwise) ?? 0;
            registrationFee    = priceCategory.registrationFee ?? 0;
            pricingSource      = 'CONFIG';
        }
        const effectiveTotal = accommodationPrice + messPrice + laundryPrice + registrationFee;

        // Available transport credit = gross transport payments − transport refunds already
        // issued. Using gross would re-refund money returned by an earlier transport
        // refund (double refund) when switching back and forth. Mirrors hostel credit.
        const transportCredit = await getAvailableTransportCredit(studentId);
        const transportPaid = transportCredit.availableCredit;

        if (withhold > transportPaid) {
            throw new AppError(
                `Cannot withhold more than available transport credit (withhold ${withhold} > available ${transportPaid}).`,
                400,
            );
        }
        const totalRetained = withhold + flatPenalty;

        let pendingTransportTotal = 0;
        if (transportHead) {
            const pAgg = await prisma.studentFeeDemand.aggregate({
                where: {
                    studentId,
                    feeHeadId: transportHead.id,
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                _sum: { netAmount: true },
            });
            pendingTransportTotal = pAgg._sum.netAmount ?? 0;
        }

        // NO auto-adjustment: transport credit is NOT applied as a discount on the new hostel
        // demands (each billed at FULL cost). The refundable amount (availableCredit −
        // totalRetained) is returned as a carry-forward FeeCorrection, settled separately.
        const refundPool = Math.max(0, transportPaid - totalRetained);

        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true },
        });
        const previousRouteId = admissionRow?.transportRouteId ?? null;

        const result = await prisma.$transaction(async (tx) => {
            // NO fee-correction settlement on switch: prior leftover refunds are left untouched
            // (no reclaim/void here) so this flow never settles any FeeCorrection amount.

            // ── 1. Cancel transport ── (soft-delete ALL active transport demands, not just
            //    PENDING — leaving transport, so no transport demand should remain).
            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId },
                });
            }

            // ── 2. Switch admission to HOSTEL ──
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.HOSTEL,
                    transportRouteId: null,
                    hostelId: hostelId ?? null,
                    hostelType,
                    hostelPaymentMode: hostelPaymentMode as HostelPaymentMode,
                    // totalFee: subtract pending transport, add full new hostel gross
                    totalFee: { increment: effectiveTotal - pendingTransportTotal },
                },
            });

            // ── 3. Supersede prior snapshot and write a new active one ──
            // Prior rows are kept (isActive=false) for refund/audit history.
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId },
            });
            await (tx.studentAccommodationPricing as any).create({
                data: {
                    studentId,
                    academicYearId,
                    sharing,
                    roomType,
                    paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                    hostelId: hostelId ?? null,
                    accommodationPrice,
                    messPrice,
                    laundryPrice,
                    registrationFee,
                    effectiveTotal,
                    pricingSource,
                    isActive: true,
                    createdBy: adminId,
                },
            });

            // ── 4. Create 4 hostel demands with proportional discounts ──
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const buildDemand = async (
                head: any,
                gross: number,
                label: string
            ) => {
                if (!head || gross <= 0) return false;
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: head.id,
                        amount: gross,
                        discountAmount: 0,
                        netAmount: gross,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: FeeStatus.PENDING,
                        remarks: `Hostel ${label} (${hostelType}, ${roomType}, ${isSemwise ? 'SEMWISE' : 'YEARWISE'}). Reason: ${reason}`,
                        createdBy: adminId,
                    },
                });
                return true;
            };
            let feeDemandsCreated = 0;
            if (await buildDemand(accHead, accommodationPrice, 'accommodation')) feeDemandsCreated++;
            if (await buildDemand(messHead, messPrice, 'mess')) feeDemandsCreated++;
            if (await buildDemand(laundryHead, laundryPrice, 'laundry')) feeDemandsCreated++;
            if (await buildDemand(regHead, registrationFee, 'registration')) feeDemandsCreated++;

            let feeCorrectionId: string | null = null;
            if (refundPool > 0 || totalRetained > 0) {
                const fc = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: refundPool,
                        retainedAmount: totalRetained,
                        retentionBreakdown: {
                            transport:       withhold,
                            cancellationFee: flatPenalty,
                        },
                        reason: `Transport→Hostel switch refund: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousRouteId,
                        referenceType: 'TRANSPORT_TO_HOSTEL_SWITCH',
                        remarks: `transportPaid: ${transportPaid}, withhold: ${withhold}, cancellationFee: ${flatPenalty}, totalRetained: ${totalRetained}, refund: ${refundPool} (no auto-adjustment to new hostel demands)`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
                feeCorrectionId = fc.id;

                if (totalRetained > 0) {
                    await recordRetained(tx, {
                        studentId, academicYearId,
                        sourceType: RetainedRevenueSourceType.FEE_CORRECTION,
                        sourceId:   fc.id,
                        occurredAt: fc.createdAt ?? new Date(),
                        routeId:    previousRouteId ?? undefined,
                        createdBy:  adminId,
                        expectedTotal: totalRetained,
                        lines: [
                            { category: RetainedRevenueCategory.TRANSPORT_USAGE,            amount: withhold },
                            { category: RetainedRevenueCategory.TRANSPORT_CANCELLATION_FEE, amount: flatPenalty },
                        ],
                    });
                }
            }

            // Audit ledger entry for the retained portion (transport-side fee the college
            // kept at switch). Same pattern as switchHostelToTransport. Tagged
            // TRANSPORT_TO_HOSTEL_SWITCH so it's visible in the ledger but skipped by the
            // per-component breakdown. Independent of `leftover > 0`.
            if (totalRetained > 0) {
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: LedgerTransactionType.DEBIT,
                        amount: totalRetained,
                        description: `Transport→Hostel switch fee retained: ${reason}`,
                        referenceId: feeCorrectionId ?? previousRouteId ?? null,
                        referenceType: 'TRANSPORT_TO_HOSTEL_SWITCH',
                        academicYearId,
                        createdBy: adminId,
                    } as any,
                });
            }

            // ── 6. Audit ──
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'TRANSPORT_TO_HOSTEL_SWITCH',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousRouteId,
                        newHostelId: hostelId,
                        hostelType,
                        hostelPaymentMode,
                        transportPaid,
                        withhold,
                        cancellationFee: flatPenalty,
                        totalRetained,
                        refundPool,
                        effectiveTotal,
                        pricingSource,
                        customPricing: args.customPricing ?? null,
                        pendingTransportRemoved: pendingTransportTotal,
                        feeDemandsCreated,
                        feeCorrectionId,
                        reason,
                    },
                },
            });

            return {
                cancellation: {
                    transportPaid,
                    withhold,
                    cancellationFee: flatPenalty,
                    totalRetained,
                    refundPool,
                    pendingTransportRemoved: pendingTransportTotal,
                },
                newAssignment: {
                    hostelId: hostelId ?? null,
                    hostelType,
                    paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                    pricing: { accommodationPrice, messPrice, laundryPrice, registrationFee, effectiveTotal },
                    studentOwes: effectiveTotal,
                    feeDemandsCreated,
                },
                refund: {
                    refundPool,
                    feeCorrectionId,
                },
            };
        });

        return result;
    },

    /* ════════════════════════════════════════════════════════════════════════
     *  PREVIEW (dry-run) methods
     *
     *  Each mirrors the validation + money math of its write counterpart but
     *  performs NO writes — no demands, no FeeCorrection, no audit/ledger rows.
     *  Credit is read with `getAvailableHostelCredit(studentId)` (no tx) instead
     *  of inside a serializable transaction; the returned numbers are an estimate
     *  that the real call recomputes at commit time, so they can drift slightly
     *  if a concurrent payment/refund lands in between.
     *
     *  Validation parity is intentional: a preview surfaces the same 4xx the
     *  write would throw, so the admin learns up-front whether the action is even
     *  allowed (year closed, bed taken, no snapshot, etc.).
     * ════════════════════════════════════════════════════════════════════════ */

    /**
     * Preview reassignHostel: compute the new pricing, fee delta, and credit
     * distribution for moving a student to a different hostel/bed — without writing.
     */
    async previewReassignHostel(
        studentId: string,
        args: {
            hostelId: string;
            bedId: string;
            hostelPaymentMode: 'YEARWISE' | 'SEMWISE';
            customPricing?: { accommodation: number; mess: number; laundry: number; registration: number };
        }
    ) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'reassign hostel');
        assertHostelAccommodation(ctx.admission, 'Use assign-hostel + allocate-bed first.');
        const admission = ctx.admission!;
        const oldPricing = ctx.accommodationPricing;
        if (!oldPricing) {
            throw new AppError('Student has no allocated bed yet. Use allocate-bed first.', 400);
        }
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        const oldAllocation = await (prisma.hostelAllocation as any).findFirst({
            where: { studentId, status: 'ACTIVE' },
            include: { bed: { include: { room: true } } }
        });
        if (!oldAllocation) throw new AppError('No active bed allocation found', 404);

        const newBed = await prisma.hostelBed.findUnique({
            where: { id: args.bedId },
            include: { room: true, allocations: { where: { status: 'ACTIVE' }, take: 1 } }
        });
        if (!newBed) throw new AppError('New bed not found', 404);
        if (newBed.room.isDeleted) throw new AppError('Cannot allocate a bed in a deleted room', 400);
        if (newBed.room.hostelId !== args.hostelId) {
            throw new AppError('Bed does not belong to the selected hostel', 400);
        }
        const newBedActive = (newBed as any).allocations?.[0];
        if (newBedActive && newBed.id !== oldAllocation.bedId) {
            throw new AppError('New bed is already allocated to another student', 409);
        }

        const newHostel = await prisma.hostel.findUnique({ where: { id: args.hostelId } });
        if (!newHostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (newHostel.isDeleted) throw new AppError('Cannot reassign to a deleted hostel', 400);
        if (args.hostelId !== oldPricing.hostelId) {
            await assertHostelHasCapacity(args.hostelId);
        }

        const sharing = newBed.room.capacity;
        const roomType = newBed.room.type;
        const isSemwise = args.hostelPaymentMode === 'SEMWISE';

        // Mirror the write path: custom override replaces the config tier entirely.
        let accommodationPrice: number;
        let messPrice: number;
        let laundryPrice: number;
        let registrationFee: number;
        let pricingSource: 'CONFIG' | 'CUSTOM';

        if (args.customPricing) {
            accommodationPrice = args.customPricing.accommodation;
            messPrice          = args.customPricing.mess;
            laundryPrice       = args.customPricing.laundry;
            registrationFee    = args.customPricing.registration;
            pricingSource      = 'CUSTOM';
        } else {
            const priceCategory = await resolveHostelPriceCategory(
                { sharing, roomType, academicYearId: admission.academicYearId }
            );
            if (!priceCategory) {
                throw new AppError(`No active price tier found for sharing=${sharing}, roomType=${roomType} in academic year ${admission.academicYearId ?? '<none>'}.`, 400);
            }
            accommodationPrice = ((priceCategory as any)[isSemwise ? 'accommodationSemwise' : 'accommodationYearwise']) ?? 0;
            messPrice          = ((priceCategory as any)[isSemwise ? 'messSemwise' : 'messYearwise']) ?? 0;
            laundryPrice       = ((priceCategory as any)[isSemwise ? 'laundrySemwise' : 'laundryYearwise']) ?? 0;
            registrationFee    = (priceCategory as any).registrationFee ?? 0;
            pricingSource      = 'CONFIG';
        }
        const newEffectiveTotal = accommodationPrice + messPrice + laundryPrice + registrationFee;

        const newHostelType = `SHARING_${sharing}` as HostelType;
        const oldEffectiveTotal = oldPricing.effectiveTotal ?? 0;
        const totalFeeDelta = newEffectiveTotal - oldEffectiveTotal;

        // Credit read-only (no tx). Same formula as the write path: custom override
        // disables auto-applied credit and auto-refund.
        const credit = await getAvailableHostelCredit(studentId);
        const hostelPaid = credit.grossPaid;
        const availableCredit = credit.availableCredit;
        const refundAmount    = availableCredit;

        // Counts the real call would produce (read-only).
        const feeHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const accHead = feeHeadMap.get(PaymentComponent.HOSTEL_ACCOMMODATION);
        const messHead = feeHeadMap.get(PaymentComponent.HOSTEL_MESS);
        const laundryHead = feeHeadMap.get(PaymentComponent.HOSTEL_LAUNDRY);
        const regHead = feeHeadMap.get(PaymentComponent.HOSTEL_REGISTRATION);
        const hostelHeadIds = [accHead?.id, messHead?.id, laundryHead?.id, regHead?.id].filter(Boolean) as string[];

        const supersededDemands = hostelHeadIds.length > 0
            ? await prisma.studentFeeDemand.count({
                  where: { studentId, isDeleted: false, status: FeeStatus.PENDING, feeHeadId: { in: hostelHeadIds } },
              })
            : 0;

        const componentsToCreate: { head: typeof accHead; amount: number; label: string }[] = [
            { head: accHead, amount: accommodationPrice, label: 'accommodation' },
            { head: messHead, amount: messPrice, label: 'mess' },
            { head: laundryHead, amount: laundryPrice, label: 'laundry' },
            { head: regHead, amount: registrationFee, label: 'registration' },
        ];
        const skippedComponents = componentsToCreate.filter(c => !c.head && c.amount > 0).map(c => c.label);
        const newDemandsCreated = componentsToCreate.filter(c => c.head && c.amount > 0).length;

        return {
            preview: true,
            previous: {
                hostelId: oldPricing.hostelId,
                hostelType: `SHARING_${oldPricing.sharing}`,
                roomNumber: oldAllocation.bed.room.number,
                bedNumber: oldAllocation.bed.number,
                paymentMode: oldPricing.paymentMode,
                effectiveTotal: oldEffectiveTotal,
            },
            current: {
                hostelId: args.hostelId,
                hostelType: newHostelType,
                roomNumber: newBed.room.number,
                bedNumber: newBed.number,
                paymentMode: args.hostelPaymentMode,
                effectiveTotal: newEffectiveTotal,
                pricingSource,
                components: { accommodationPrice, messPrice, laundryPrice, registrationFee },
            },
            feeDelta: totalFeeDelta,
            financialAdjustment: {
                hostelPaid,
                availableCredit,
                studentOwes: newEffectiveTotal, // full new charge; credit parked as FeeCorrection
                refundAmountParked: refundAmount,
            },
            supersededDemands,
            newDemandsCreated,
            skippedComponents: skippedComponents.length > 0
                ? `Missing FeeHead for: ${skippedComponents.join(', ')}`
                : null,
        };
    },

    /**
     * Preview cancelHostel: compute the refundable amount and what would be
     * removed/vacated — without writing.
     */
    async previewCancelHostel(studentId: string, _args?: { cancellationFee?: number; withhold?: HostelWithhold }) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel hostel');
        const admission = ctx.admission!;
        if (admission.accommodationType !== AccommodationType.HOSTEL) {
            throw new AppError(`Student is not on HOSTEL (currently ${admission.accommodationType}). Nothing to cancel.`, 400);
        }

        // Show the hostel demands being left + how much was paid against each.
        const feeHeadMap = await resolveFeeHeadsByComponent(HOSTEL_FEE_COMPONENTS);
        const hostelHeadIds = Array.from(feeHeadMap.values()).filter(Boolean).map((h: any) => h.id);
        const { demands, totals } = await listDemandsWithPaid(studentId, hostelHeadIds);

        return { preview: true, leaving: 'HOSTEL', demands, totals };
    },

    /**
     * Preview cancelTransport: compute the refundable amount and pending demand
     * that would be removed — without writing.
     */
    async previewCancelTransport(studentId: string, _args?: { cancellationFee?: number }) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel transport');
        const admission = ctx.admission!;
        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(`Student is not on TRANSPORT (currently ${admission.accommodationType}). Nothing to cancel.`, 400);
        }

        // Show the transport demand(s) being left + how much was paid against each.
        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);
        const headIds = transportHead ? [transportHead.id] : [];
        const { demands, totals } = await listDemandsWithPaid(studentId, headIds);

        return { preview: true, leaving: 'TRANSPORT', demands, totals };
    },

    /**
     * Preview switchHostelToTransport: compute the refund pool, credit applied to
     * the new transport demand, and any leftover refund — without writing.
     */
    async previewSwitchHostelToTransport(
        studentId: string,
        args: { chargeRetained?: number; transportRouteId: string; customCost?: number }
    ) {
        const { transportRouteId } = args;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'switch hostel to transport');
        const admission = ctx.admission!;
        if (admission.accommodationType !== AccommodationType.HOSTEL) {
            throw new AppError(`Student is not on HOSTEL (currently ${admission.accommodationType}). Use assign-transport directly.`, 400);
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) throw new AppError('Cannot switch: student has no academicYearId on admission', 400);
        await assertAcademicYearWritable(academicYearId);

        const transportHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = transportHeadMap.get(PaymentComponent.TRANSPORT);

        const route = await prisma.transportRoute.findUnique({ where: { id: transportRouteId } });
        if (!route) throw new AppError('Transport route not found', 404);
        if (route.isDeleted) throw new AppError('Cannot assign to a deleted route', 400);
        const studentsOnRoute = await prisma.studentAdmission.count({
            where: { transportRouteId, status: { not: 'CANCELLED' } },
        });
        if ((route.capacity ?? 0) > 0 && studentsOnRoute >= (route.capacity ?? 0)) {
            throw new AppError('Transport route is full', 400);
        }

        // Custom override → admin cost verbatim; mirrors the write path.
        const newCost = args.customCost ?? await resolveTransportRouteCost(transportRouteId, academicYearId);
        const pricingSource: 'CONFIG' | 'CUSTOM' = args.customCost != null ? 'CUSTOM' : 'CONFIG';

        // Show the HOSTEL demands being left + how much was paid against each (admin uses this
        // to decide what to keep; the refund of the rest goes to a FeeCorrection on commit).
        const hostelHeadMap = await resolveFeeHeadsByComponent(HOSTEL_FEE_COMPONENTS);
        const hostelHeadIds = Array.from(hostelHeadMap.values()).filter(Boolean).map((h: any) => h.id);
        const { demands, totals } = await listDemandsWithPaid(studentId, hostelHeadIds);

        return {
            preview: true,
            leaving: 'HOSTEL',
            demands,
            totals,
            newRoute: { transportRouteId, routeName: route.name, cost: newCost, pricingSource },
            missingFeeHead: !transportHead
                ? 'No FeeHead tagged with component=TRANSPORT — fee demand would NOT be created.'
                : null,
        };
    },

    /**
     * Preview switchTransportToHostel: compute the refund pool, proportional credit
     * distribution across the 4 hostel demands, and any leftover refund — without writing.
     */
    async previewSwitchTransportToHostel(
        studentId: string,
        args: { chargeRetained?: number; hostelId?: string; hostelType: HostelType; hostelPaymentMode: 'YEARWISE' | 'SEMWISE'; customPricing?: { accommodation: number; mess: number; laundry: number; registration: number } }
    ) {
        const { hostelId, hostelType, hostelPaymentMode } = args;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'switch transport to hostel');
        const admission = ctx.admission!;
        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(`Student is not on TRANSPORT (currently ${admission.accommodationType}). Use assign-hostel directly.`, 400);
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) throw new AppError('Cannot switch: student has no academicYearId on admission', 400);
        await assertAcademicYearWritable(academicYearId);

        const transportHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = transportHeadMap.get(PaymentComponent.TRANSPORT);

        // hostelId is OPTIONAL for the preview — pricing is keyed by sharing, not the
        // specific hostel. Validate the hostel only if one was chosen; otherwise the
        // preview just shows the credit/refund math for the sharing tier (the specific
        // hostel/bed is picked later at assign-hostel/allocate-bed).
        if (hostelId) {
            const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
            if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
            if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);
            await assertHostelHasCapacity(hostelId);
        }

        const sharing = parseInt(hostelType.split('_')[1], 10);
        const roomType = 'AC';
        const isSemwise = hostelPaymentMode === 'SEMWISE';

        // Mirror the write path: custom override replaces the config tier.
        let accommodationPrice: number;
        let messPrice: number;
        let laundryPrice: number;
        let registrationFee: number;
        let pricingSource: 'CONFIG' | 'CUSTOM';

        if (args.customPricing) {
            accommodationPrice = args.customPricing.accommodation;
            messPrice          = args.customPricing.mess;
            laundryPrice       = args.customPricing.laundry;
            registrationFee    = args.customPricing.registration;
            pricingSource      = 'CUSTOM';
        } else {
            const priceCategory = await resolveHostelPriceCategory({ sharing, roomType, academicYearId });
            if (!priceCategory) {
                throw new AppError(`No active price tier for sharing=${sharing}, roomType=${roomType} in academic year ${academicYearId}.`, 400);
            }
            accommodationPrice = (isSemwise ? priceCategory.accommodationSemwise : priceCategory.accommodationYearwise) ?? 0;
            messPrice          = (isSemwise ? priceCategory.messSemwise : priceCategory.messYearwise) ?? 0;
            laundryPrice       = (isSemwise ? priceCategory.laundrySemwise : priceCategory.laundryYearwise) ?? 0;
            registrationFee    = priceCategory.registrationFee ?? 0;
            pricingSource      = 'CONFIG';
        }
        const effectiveTotal = accommodationPrice + messPrice + laundryPrice + registrationFee;

        // Show the TRANSPORT demand(s) being left + how much was paid against each (admin uses
        // this to decide what to keep; the refund of the rest goes to a FeeCorrection on commit).
        const headIds = transportHead ? [transportHead.id] : [];
        const { demands, totals } = await listDemandsWithPaid(studentId, headIds);

        return {
            preview: true,
            leaving: 'TRANSPORT',
            demands,
            totals,
            newHostel: {
                hostelId: hostelId ?? null,
                hostelType,
                paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                pricing: { accommodationPrice, messPrice, laundryPrice, registrationFee, effectiveTotal },
                pricingSource,
            },
        };
    },

    async updateHostelId(
        studentId: string,
        hostelId: string,
        adminId: string | undefined
    ) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'update hostelId');
        const admission = ctx.admission!;

        if (admission.accommodationType !== AccommodationType.HOSTEL) {
            throw new AppError(
                `Student accommodation type is "${admission.accommodationType}", not HOSTEL. Cannot update hostelId.`,
                400
            );
        }

        const isAdding = !admission.hostelId;

        const { grossPaid } = await getAvailableHostelCredit(studentId);
        if (grossPaid <= 0) {
            throw new AppError(
                'Student has not made any hostel payment yet. At least one payment is required before updating hostelId.',
                400
            );
        }

        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } }) as any;
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);

        await prisma.studentAdmission.update({
            where: { studentId },
            data: { hostelId, updatedBy: adminId } as any,
        });

        await prisma.auditLog.create({
            data: {
                userId: adminId,
                action: isAdding ? 'HOSTEL_ID_ADDED' : 'HOSTEL_ID_UPDATED',
                entity: 'StudentAdmission',
                entityId: studentId,
                details: {
                    previousHostelId: admission.hostelId ?? null,
                    newHostelId: hostelId,
                    hostelName: hostel.name,
                    grossPaid,
                    operation: isAdding ? 'ADD' : 'UPDATE',
                },
            },
        });

        return {
            hostelId,
            hostelName: hostel.name,
            previousHostelId: admission.hostelId ?? null,
            operation: isAdding ? 'added' : 'updated',
        };
    },
};
