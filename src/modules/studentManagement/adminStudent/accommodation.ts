

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
    recomputeStudentTotals,
} from '../../../utils/studentContext';
import { generateAndSaveHostelAllotmentOrder } from '../../finance/payment.service';
import { recordRetained } from '../../../utils/retainedRevenue';
import { RetainedRevenueCategory, RetainedRevenueSourceType } from '@prisma/client';

type HostelWithhold = {
    accommodation?: number;
    mess?: number;
    laundry?: number;
    registration?: number;
};

type HostelWithholdBreakdown = {
    accommodation: number;
    mess: number;
    laundry: number;
    registration: number;
};

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

    return { breakdown: null, cancellationFee, total: cancellationFee };
};

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

                ...(hostelId ? { hostelId } : { hostelId: { not: null } }),
                ...(hostelType ? { hostelType: hostelType as HostelType } : {}),
            },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),

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

            payments: {
                some: {
                    component: { in: hostelComponents },
                    status: PaymentStatus.SUCCESS,
                    isDeleted: false,
                    amount: { gt: 0 },
                    feeDemand: { isDeleted: false },
                },
            },

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
                            feeDemand: { isDeleted: false },
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

    async getTransportPaidStudents(query: any) {
        const { page = 1, limit = 10, search, gender, routeId, all } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;
        const fetchAll = !!all;

        const where: Prisma.StudentWhereInput = {

            ...(routeId ? { admissionDetails: { transportRouteId: routeId } } : {}),

            payments: {
                some: {
                    component: PaymentComponent.TRANSPORT,
                    status: PaymentStatus.SUCCESS,
                    isDeleted: false,
                    amount: { gt: 0 },
                    feeDemand: { isDeleted: false },
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
                            feeDemand: { isDeleted: false },
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

    async allocateBed(studentId: string, bedId: string, hostelIdFromBody: string | undefined, _academicYearIdInput: string | undefined, adminId: string | undefined) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'allocate bed');
        assertHostelAccommodation(ctx.admission, 'Run assign-hostel first.');
        assertNoBedAllocated(ctx.accommodationPricing as any, 'Use re-allocation flow.');
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

        if (bed.room.capacity !== ctx.accommodationPricing.sharing) {
            throw new AppError(
                `Snapshot is for SHARING_${ctx.accommodationPricing.sharing} but bed is in a ${bed.room.capacity}-sharing room. Re-run assign-hostel with the correct hostelType.`,
                400
            );
        }

        const result = await prisma.$transaction(async (tx) => {

            const hostelAllocYearId = (await getActiveAcademicYear(tx)).id;

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
                    hostelId: targetHostelId,
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

        generateAndSaveHostelAllotmentOrder(studentId).catch(() => { });

        return result;
    },

    async bulkAllocateRoomBeds(
        roomId: string,
        studentIds: string[],
        _academicYearIdInput: string | undefined,
        adminId: string | undefined
    ) {

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

        const students = await prisma.student.findMany({
            where: { id: { in: studentIds } },
            include: {
                admissionDetails: true,
                accommodationPricing: { where: { isActive: true }, take: 1 }
            } as any
        }) as any[];

        const studentMap = new Map(students.map(s => [s.id, s]));
        const validationErrors: { studentId: string; reason: string }[] = [];

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

        const pairs = studentIds.map((sid, idx) => ({
            studentId: sid,
            bed: vacantBeds[idx]
        }));

        const allocated: any[] = [];
        await prisma.$transaction(async (tx) => {

            const hostelAllocYearId = (await getActiveAcademicYear(tx)).id;
            for (const { studentId, bed } of pairs) {
                const student = studentMap.get(studentId)!;

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

        for (const a of allocated) {
            generateAndSaveHostelAllotmentOrder(a.studentId).catch(() => { });
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

    async reassignHostel(
        studentId: string,
        args: {
            hostelId: string;
            bedId: string;
            hostelPaymentMode: 'YEARWISE' | 'SEMWISE';
            reason: string;

            customPricing?: { accommodation: number; mess: number; laundry: number; registration: number };
        },
        adminId: string | undefined
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

        const academicYearId = admission.academicYearId ?? oldPricing.academicYearId ?? undefined;

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

        const result = await prisma.$transaction(async (tx) => {

            const credit          = await getAvailableHostelCredit(studentId, tx);
            const hostelPaid      = credit.grossPaid;
            const availableCredit = credit.availableCredit;
            const refundAmount    = availableCredit;

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

            await (tx.hostelAllocation as any).updateMany({
                where: { studentId, status: 'ACTIVE' },
                data: {
                    bedId: newBed.id,
                    startDate: new Date(),
                    updatedBy: adminId
                }
            });

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

            let supersededDemands = 0;
            if (hostelHeadIds.length > 0) {
                const result = await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                        isDeleted: false,
                    },
                    data: {
                        isDeleted: true,
                        updatedBy: adminId,
                    },
                });
                supersededDemands = result.count;
            }

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
                    academicYearId: academicYearId,
                    yearOfStudy: ctx.yearOfStudy,
                }
            });

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

            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 20000,
        });

        generateAndSaveHostelAllotmentOrder(studentId).catch(() => { });

        await recomputeStudentTotals(studentId);
        return result;
    },

    async assignHostel(
        studentId: string,
        hostelId: string | null | undefined,
        hostelPaymentMode: 'YEARWISE' | 'SEMWISE',
        hostelType: HostelType,
        adminId?: string,

        customPricing?: { accommodation: number; mess: number; laundry: number; registration: number }
    ) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'assign hostel');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        if (
            admission.accommodationType !== AccommodationType.NONE &&
            admission.accommodationType !== AccommodationType.HOSTEL
        ) {
            throw new AppError(
                `Student has accommodation type "${admission.accommodationType}". Use the change-accommodation flow to switch to HOSTEL.`,
                409
            );
        }

        const existingAllocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });
        if (existingAllocation) {
            throw new AppError('Bed already allocated. Use the reassign-hostel flow to change hostel/sharing/mode.', 409);
        }

        let hostel: { id: string; name: string; isDeleted: boolean } | null = null;
        if (hostelId) {
            hostel = await prisma.hostel.findUnique({ where: { id: hostelId } }) as any;
            if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
            if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);

            if (hostelId !== admission.hostelId) {
                await assertHostelHasCapacity(hostelId);
            }
        }

        const resolvedHostelId = hostelId ?? admission.hostelId ?? null;

        const sharing = parseInt(hostelType.split('_')[1], 10);
        const roomType = 'AC';

        const isSemwise = hostelPaymentMode === 'SEMWISE';

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

        const previousEffectiveTotal = ctx.accommodationPricing?.effectiveTotal ?? 0;
        const totalFeeDelta = effectiveTotal - previousEffectiveTotal;

        const result = await prisma.$transaction(async (tx) => {

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

            const hostelHeadIds = [accHead?.id, messHead?.id, laundryHead?.id, regHead?.id].filter(Boolean) as string[];
            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.deleteMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                    }
                });
            }

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

            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const demands: { feeHeadId: string; amount: number; label: string }[] = [];
            if (accHead && accommodationPrice > 0) demands.push({ feeHeadId: accHead.id, amount: accommodationPrice, label: 'accommodation' });
            if (messHead && messPrice > 0)         demands.push({ feeHeadId: messHead.id, amount: messPrice, label: 'mess' });
            if (laundryHead && laundryPrice > 0)   demands.push({ feeHeadId: laundryHead.id, amount: laundryPrice, label: 'laundry' });
            if (regHead && registrationFee > 0)    demands.push({ feeHeadId: regHead.id, amount: registrationFee, label: 'registration' });

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

            for (const r of byComponentAgg as any[]) {
                const comp = r.component as PaymentComponent;

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

        await recomputeStudentTotals(studentId);
        return result;
    },

    async assignTransport(
        studentId: string,
        transportRouteId: string,
        adminId?: string,

        customCost?: number
    ) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'assign transport');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        if (
            admission.accommodationType !== AccommodationType.NONE &&
            admission.accommodationType !== AccommodationType.TRANSPORT
        ) {
            throw new AppError(
                `Student has accommodation type "${admission.accommodationType}". Use the change-accommodation flow to switch to TRANSPORT.`,
                409
            );
        }

        const existingAllocation = await prisma.transportAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });
        if (existingAllocation) {
            throw new AppError('Student already has an active transport allocation. Use the reassign-transport flow.', 409);
        }

        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true }
        });
        const previousRouteId = admissionRow?.transportRouteId ?? null;

        const route = await prisma.transportRoute.findUnique({ where: { id: transportRouteId } });
        if (!route) throw new AppError('Transport route not found', 404);
        if (route.isDeleted) throw new AppError('Cannot assign to a deleted route', 400);
        if ((route.capacity ?? 0) > 0 && (route.filled ?? 0) >= (route.capacity ?? 0)) {

            if (transportRouteId !== previousRouteId) {
                throw new AppError('Transport route is full', 400);
            }
        }

        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

        const academicYearId = admission.academicYearId;
        const newCost = customCost ?? await resolveTransportRouteCost(transportRouteId, academicYearId ?? null);
        const pricingSource: 'CONFIG' | 'CUSTOM' = customCost != null ? 'CUSTOM' : 'CONFIG';

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

            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.TRANSPORT,
                    transportRouteId,
                    totalFee: { increment: totalFeeDelta }
                }
            });

            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId, updatedBy: adminId }
                });
            }

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

        await recomputeStudentTotals(studentId);
        return result;
    },

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

        if (transportRouteId !== oldRouteId) {
            const studentsOnNewRoute = await prisma.studentAdmission.count({
                where: { transportRouteId, status: { not: 'CANCELLED' } }
            });
            if ((newRoute.capacity ?? 0) > 0 && studentsOnNewRoute >= (newRoute.capacity ?? 0)) {
                throw new AppError('New transport route is full', 400);
            }
        }

        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

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

            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    transportRouteId,
                    totalFee: { increment: totalFeeDelta },
                }
            });

            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId, updatedBy: adminId }
                });
            }

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

        await recomputeStudentTotals(studentId);
        return result;
    },

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

        const feeHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const hostelHeadIds = Array.from(feeHeadMap.values()).filter(Boolean).map((h: any) => h.id);

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

            const credit = await getAvailableHostelCredit(studentId, tx);
            const paid = credit.grossPaid;
            const availableCredit = credit.availableCredit;

            const paidByComponent = await getHostelPaidByComponent(studentId, tx);
            const { breakdown: withholdBreakdown, cancellationFee: retainedCancellationFee, total: totalWithheld } = resolveHostelWithhold(args, paidByComponent);
            const refundAmount = Math.max(0, availableCredit - totalWithheld);

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

            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                        isDeleted: false,
                    },
                    data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId, updatedBy: adminId },
                });
            }

            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId },
            });

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
                        yearOfStudy: ctx.yearOfStudy,
                        createdBy: adminId,
                    } as any,
                });
            }

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

        await recomputeStudentTotals(studentId);
        return result;
    },

    async cancelTransport(
        studentId: string,
        args: { withhold?: number; cancellationFee?: number; reason: string },
        adminId?: string
    ) {

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

        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

        const transportCredit = await getAvailableTransportCredit(studentId);
        const paid = transportCredit.grossPaid;

        if (withhold > paid) {
            throw new AppError(
                `Cannot withhold more than was paid for transport (withhold ${withhold} > paid ${paid}).`,
                400
            );
        }
        const totalRetained = withhold + cancellationFee;

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

            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId, updatedBy: adminId },
                });
            }

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
                        yearOfStudy: ctx.yearOfStudy,
                        createdBy: adminId,
                    } as any,
                });
            }

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

        await recomputeStudentTotals(studentId);
        return result;
    },

    async switchHostelToTransport(
        studentId: string,
        args: {

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

        const route = await prisma.transportRoute.findUnique({ where: { id: transportRouteId } });
        if (!route) throw new AppError('Transport route not found', 404);
        if (route.isDeleted) throw new AppError('Cannot assign to a deleted route', 400);
        const studentsOnRoute = await prisma.studentAdmission.count({
            where: { transportRouteId, status: { not: 'CANCELLED' } },
        });
        if ((route.capacity ?? 0) > 0 && studentsOnRoute >= (route.capacity ?? 0)) {
            throw new AppError('Transport route is full', 400);
        }

        const newCost = args.customCost ?? await resolveTransportRouteCost(transportRouteId, academicYearId);
        const pricingSource: 'CONFIG' | 'CUSTOM' = args.customCost != null ? 'CUSTOM' : 'CONFIG';
        const previousHostelId = admission.hostelId;
        const previousHostelType = admission.hostelType;
        const allocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });

        const result = await prisma.$transaction(async (tx) => {

            const credit          = await getAvailableHostelCredit(studentId, tx);
            const hostelPaid      = credit.grossPaid;
            const availableCredit = credit.availableCredit;
            const paidByComponent = await getHostelPaidByComponent(studentId, tx);
            const { breakdown: withholdBreakdown, cancellationFee: retainedCancellationFee, total: totalRetained } =
                resolveHostelWithhold(withholdArgs, paidByComponent);
            const refundPool      = Math.max(0, availableCredit - totalRetained);

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

            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                        isDeleted: false,
                    },
                    data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId, updatedBy: adminId },
                });
            }

            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId },
            });

            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.TRANSPORT,
                    transportRouteId,
                    hostelId: null,
                    hostelType: null,
                    hostelPaymentMode: null,
                    roomNumber: null,

                    totalFee: { increment: newCost - pendingHostelTotal },
                },
            });

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
                        yearOfStudy: ctx.yearOfStudy,
                        createdBy: adminId,
                    } as any,
                });
            }

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

        await recomputeStudentTotals(studentId);
        return result;
    },

    async switchTransportToHostel(
        studentId: string,
        args: {

            withhold?: number;
            cancellationFee?: number;
            chargeRetained?: number;
            reason: string;

            hostelId?: string;
            hostelType: HostelType;
            hostelPaymentMode: 'YEARWISE' | 'SEMWISE';

            customPricing?: { accommodation: number; mess: number; laundry: number; registration: number };
        },
        adminId?: string
    ) {
        const withhold        = Math.max(0, args.withhold ?? 0);
        const cancellationFee = Math.max(0, args.cancellationFee ?? 0);

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

        if (hostelId) {
            const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
            if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
            if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);
            await assertHostelHasCapacity(hostelId);
        }

        const sharing = parseInt(hostelType.split('_')[1], 10);
        const roomType = 'AC';
        const isSemwise = hostelPaymentMode === 'SEMWISE';

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

        const refundPool = Math.max(0, transportPaid - totalRetained);

        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true },
        });
        const previousRouteId = admissionRow?.transportRouteId ?? null;

        const result = await prisma.$transaction(async (tx) => {

            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId, updatedBy: adminId },
                });
            }

            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.HOSTEL,
                    transportRouteId: null,
                    hostelId: hostelId ?? null,
                    hostelType,
                    hostelPaymentMode: hostelPaymentMode as HostelPaymentMode,

                    totalFee: { increment: effectiveTotal - pendingTransportTotal },
                },
            });

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
                        yearOfStudy: ctx.yearOfStudy,
                        createdBy: adminId,
                    } as any,
                });
            }

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

        await recomputeStudentTotals(studentId);
        return result;
    },

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

        const credit = await getAvailableHostelCredit(studentId);
        const hostelPaid = credit.grossPaid;
        const availableCredit = credit.availableCredit;
        const refundAmount    = availableCredit;

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
                studentOwes: newEffectiveTotal,
                refundAmountParked: refundAmount,
            },
            supersededDemands,
            newDemandsCreated,
            skippedComponents: skippedComponents.length > 0
                ? `Missing FeeHead for: ${skippedComponents.join(', ')}`
                : null,
        };
    },

    async previewCancelHostel(studentId: string, _args?: { cancellationFee?: number; withhold?: HostelWithhold }) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel hostel');
        const admission = ctx.admission!;
        if (admission.accommodationType !== AccommodationType.HOSTEL) {
            throw new AppError(`Student is not on HOSTEL (currently ${admission.accommodationType}). Nothing to cancel.`, 400);
        }

        const feeHeadMap = await resolveFeeHeadsByComponent(HOSTEL_FEE_COMPONENTS);
        const hostelHeadIds = Array.from(feeHeadMap.values()).filter(Boolean).map((h: any) => h.id);
        const { demands, totals } = await listDemandsWithPaid(studentId, hostelHeadIds);

        return { preview: true, leaving: 'HOSTEL', demands, totals };
    },

    async previewCancelTransport(studentId: string, _args?: { cancellationFee?: number }) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel transport');
        const admission = ctx.admission!;
        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(`Student is not on TRANSPORT (currently ${admission.accommodationType}). Nothing to cancel.`, 400);
        }

        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);
        const headIds = transportHead ? [transportHead.id] : [];
        const { demands, totals } = await listDemandsWithPaid(studentId, headIds);

        return { preview: true, leaving: 'TRANSPORT', demands, totals };
    },

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

        const newCost = args.customCost ?? await resolveTransportRouteCost(transportRouteId, academicYearId);
        const pricingSource: 'CONFIG' | 'CUSTOM' = args.customCost != null ? 'CUSTOM' : 'CONFIG';

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

        if (hostelId) {
            const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
            if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
            if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);
            await assertHostelHasCapacity(hostelId);
        }

        const sharing = parseInt(hostelType.split('_')[1], 10);
        const roomType = 'AC';
        const isSemwise = hostelPaymentMode === 'SEMWISE';

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
            data: { hostel: { connect: { id: hostelId } } } as any,
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
