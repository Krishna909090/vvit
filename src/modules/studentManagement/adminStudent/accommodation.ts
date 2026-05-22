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
            // Custom override → admin decides the exact charge. Do NOT auto-apply paid
            // credit as discount and do NOT auto-refund leftover; the admin's amounts are
            // billed in full (admin handles any prior-payment adjustment separately).
            const appliedToNew    = args.customPricing ? 0 : Math.min(availableCredit, newEffectiveTotal);
            const leftoverRefund  = args.customPricing ? 0 : Math.max(0, availableCredit - newEffectiveTotal);

            // Distribute appliedToNew proportionally across the 4 new demands.
            // Last (registration) absorbs rounding so discounts sum exactly to appliedToNew.
            const distribute = (componentPrice: number) =>
                newEffectiveTotal > 0 ? Math.round((componentPrice / newEffectiveTotal) * appliedToNew) : 0;
            const accDiscount     = distribute(accommodationPrice);
            const messDiscount    = distribute(messPrice);
            const laundryDiscount = distribute(laundryPrice);
            const regDiscount     = appliedToNew - accDiscount - messDiscount - laundryDiscount;
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
                const result = await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        isDeleted: false,
                        feeHeadId: { in: hostelHeadIds }
                    },
                    data: {
                        isDeleted: true,
                        deletedAt: new Date(),
                        deletedBy: adminId,
                        remarks: `Superseded by hostel re-assignment to ${newHostelType} ${args.hostelPaymentMode}`
                    }
                });
                supersededDemands = result.count;
            }

            // f. Create new demands for the new pricing.
            // Apply already-paid amount as `discountAmount` per component (proportional).
            // netAmount = max(0, gross − discount). status = FULL when net=0, else PENDING.
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const components: { head: typeof accHead; amount: number; discount: number; label: string }[] = [
                { head: accHead,     amount: accommodationPrice, discount: accDiscount,     label: 'accommodation' },
                { head: messHead,    amount: messPrice,          discount: messDiscount,    label: 'mess' },
                { head: laundryHead, amount: laundryPrice,       discount: laundryDiscount, label: 'laundry' },
                { head: regHead,     amount: registrationFee,    discount: regDiscount,     label: 'registration' }
            ];
            const createdDemands: string[] = [];
            const skippedComponents: string[] = [];
            for (const c of components) {
                if (!c.head) { if (c.amount > 0) skippedComponents.push(c.label); continue; }
                if (c.amount <= 0) continue;
                const net = Math.max(0, c.amount - c.discount);
                const d = await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: c.head.id,
                        amount: c.amount,
                        discountAmount: c.discount,
                        netAmount: net,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: net === 0 ? FeeStatus.FULL : FeeStatus.PENDING,
                        remarks:
                            c.discount > 0
                                ? `Hostel ${c.label} (re-assigned: ${newHostelType}, ${args.hostelPaymentMode}). Previous-payment credit applied: ${c.discount}.`
                                : `Hostel ${c.label} (re-assigned: ${newHostelType}, ${args.hostelPaymentMode})`,
                        createdBy: adminId
                    }
                });
                createdDemands.push(d.id);
            }

            // f2. If old hostel paid > new cost, the excess is refundable. Park it in FeeCorrection.
            let feeCorrectionId: string | null = null;
            if (leftoverRefund > 0) {
                const fc = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: leftoverRefund,
                        reason: `Hostel re-assignment refund (${args.reason})`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: oldPricing.hostelId,
                        referenceType: 'HOSTEL_REASSIGNMENT',
                        remarks: `grossPaid: ${hostelPaid}, priorRefunds: ${credit.priorRefunds}, availableCredit: ${availableCredit}, oldEffectiveTotal: ${oldEffectiveTotal}, newEffectiveTotal: ${newEffectiveTotal}, appliedToNew: ${appliedToNew}, leftover: ${leftoverRefund}`,
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
                        appliedToNew,
                        leftoverRefund,
                        creditDistribution: { accDiscount, messDiscount, laundryDiscount, regDiscount },
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
                    appliedToNew,
                    studentOwes: Math.max(0, newEffectiveTotal - appliedToNew),
                    leftoverRefund,
                    creditDistribution: { accDiscount, messDiscount, laundryDiscount, regDiscount },
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
        hostelId: string,
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

        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);

        // Skip capacity check when just changing payment mode on the same hostel
        if (hostelId !== admission.hostelId) {
            await assertHostelHasCapacity(hostelId);
        }

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
            // 1. Update admission (mode + tier + totals)
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.HOSTEL,
                    hostelId,
                    hostelType,
                    hostelPaymentMode: hostelPaymentMode as HostelPaymentMode,
                    totalFee: { increment: totalFeeDelta }
                }
            });

            // 2. Supersede ALL active hostel demands (not just PENDING) so paid/superseded
            //    rows can't accumulate across repeated assigns; soft-deleted rows remain as
            //    audit history. (Re-billing is avoided because new demands net out prior pay.)
            const hostelHeadIds = [accHead?.id, messHead?.id, laundryHead?.id, regHead?.id].filter(Boolean) as string[];
            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                        isDeleted: false
                    },
                    data: { isDeleted: true, updatedBy: adminId }
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
                    hostelId,
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

            // 4. Create fresh demands
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const demands: { feeHeadId: string; amount: number; label: string }[] = [];
            if (accHead && accommodationPrice > 0) demands.push({ feeHeadId: accHead.id, amount: accommodationPrice, label: 'accommodation' });
            if (messHead && messPrice > 0)         demands.push({ feeHeadId: messHead.id, amount: messPrice, label: 'mess' });
            if (laundryHead && laundryPrice > 0)   demands.push({ feeHeadId: laundryHead.id, amount: laundryPrice, label: 'laundry' });
            if (regHead && registrationFee > 0)    demands.push({ feeHeadId: regHead.id, amount: registrationFee, label: 'registration' });

            for (const d of demands) {
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: d.feeHeadId,
                        amount: d.amount,
                        netAmount: d.amount,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: FeeStatus.PENDING,
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
                        newHostelId: hostelId,
                        newHostelType: hostelType,
                        newPaymentMode: hostelPaymentMode,
                        newEffectiveTotal: effectiveTotal,
                        totalFeeDelta,
                        hostelName: hostel.name,
                        sharing,
                        roomType,
                        pricingSource,
                        customPricing: customPricing ?? null,
                        feeDemandsCreated: demands.length,
                    }
                }
            });

            return {
                hostelId,
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
        args: { cancellationFee?: number; reason: string },
        adminId?: string
    ) {
        const cancellationFee = Math.max(0, args.cancellationFee ?? 0);
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
            // Compute availableCredit INSIDE the tx (race-condition-safe).
            // availableCredit = grossPaid − sum(prior FeeCorrection refunds).
            // refundAmount uses availableCredit so prior unsettled FeeCorrection rows
            // are not double-counted into this cancellation refund.
            const credit = await getAvailableHostelCredit(studentId, tx);
            const paid = credit.grossPaid;
            const availableCredit = credit.availableCredit;
            const refundAmount = Math.max(0, availableCredit - cancellationFee);
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

            // 5. Refund -> FeeCorrection
            let feeCorrection: any = null;
            if (refundAmount > 0) {
                feeCorrection = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: refundAmount,
                        reason: `Hostel cancellation: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousHostelId,
                        referenceType: 'HOSTEL_CANCELLATION',
                        remarks: `grossPaid: ${paid}, priorRefunds: ${credit.priorRefunds}, availableCredit: ${availableCredit}, cancellationFee: ${cancellationFee}, refund: ${refundAmount}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
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
                        cancellationFee,
                        refundAmount,
                        pendingDemandRemoved: pendingDemandTotal,
                        bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                        reason,
                    },
                },
            });

            return {
                paid,
                cancellationFee,
                refundAmount,
                pendingDemandRemoved: pendingDemandTotal,
                bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                feeCorrectionId: feeCorrection?.id ?? null,
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
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
        args: { cancellationFee?: number; reason: string },
        adminId?: string
    ) {
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

        const refundAmount = Math.max(0, transportCredit.availableCredit - cancellationFee);

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

            // 3. Refund -> FeeCorrection
            let feeCorrection: any = null;
            if (refundAmount > 0) {
                feeCorrection = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: refundAmount,
                        reason: `Transport cancellation: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousRouteId,
                        referenceType: 'TRANSPORT_CANCELLATION',
                        remarks: `Paid: ${paid}, cancellationFee: ${cancellationFee}, refund: ${refundAmount}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
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
                        cancellationFee,
                        refundAmount,
                        pendingDemandRemoved: pendingDemandTotal,
                        reason,
                    },
                },
            });

            return {
                paid,
                cancellationFee,
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
     *   appliedToNew = min(refundPool, transportRoute.cost)   // covered as a discount on the new demand
     *   leftover     = refundPool − appliedToNew              // goes to FeeCorrection (refund)
     *
     * The new TRANSPORT StudentFeeDemand carries `discountAmount = appliedToNew`,
     * `netAmount = newCost − appliedToNew`. Student owes only `netAmount` (or zero
     * if the credit fully covers the new route).
     */
    async switchHostelToTransport(
        studentId: string,
        args: { chargeRetained?: number; reason: string; transportRouteId: string; customCost?: number },
        adminId?: string
    ) {
        const chargeRetained = Math.max(0, args.chargeRetained ?? 0);
        const { reason, transportRouteId } = args;

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
            // Compute availableCredit INSIDE the tx (race-condition-safe).
            // refundPool uses availableCredit (paid − prior FeeCorrection refunds), NOT gross
            // hostelPaid — otherwise prior refunds get re-counted into this one.
            const credit          = await getAvailableHostelCredit(studentId, tx);
            const hostelPaid      = credit.grossPaid;
            const availableCredit = credit.availableCredit;
            const refundPool      = Math.max(0, availableCredit - chargeRetained);
            // Custom override → admin decides the transport charge; don't auto-apply the
            // hostel refund pool as a discount. The pool is still refunded in full below.
            const appliedToNew    = args.customCost != null ? 0 : Math.min(refundPool, newCost);
            const leftover        = refundPool - appliedToNew;
            const newDemandNet    = Math.max(0, newCost - appliedToNew);

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

            // ── 3. Create new TRANSPORT demand with credit applied as discount ──
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
                        discountAmount: appliedToNew,
                        netAmount: newDemandNet,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: newDemandNet === 0 ? FeeStatus.FULL : FeeStatus.PENDING,
                        remarks:
                            appliedToNew > 0
                                ? `Transport (${route.name}). Hostel-cancellation credit applied: ${appliedToNew}. Reason: ${reason}`
                                : `Transport (${route.name}). Reason: ${reason}`,
                        createdBy: adminId,
                    },
                });
                feeDemandsCreated = 1;
                createdDemandId = demand.id;
            }

            // ── 4. Refund leftover to FeeCorrection ──
            let feeCorrectionId: string | null = null;
            if (leftover > 0) {
                const fc = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: leftover,
                        reason: `Hostel→Transport switch leftover refund: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousHostelId,
                        referenceType: 'HOSTEL_TO_TRANSPORT_SWITCH',
                        remarks: `grossPaid: ${hostelPaid}, priorRefunds: ${credit.priorRefunds}, availableCredit: ${availableCredit}, chargeRetained: ${chargeRetained}, refundPool: ${refundPool}, appliedToNewTransport: ${appliedToNew}, leftover: ${leftover}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
                feeCorrectionId = fc.id;
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
                        chargeRetained,
                        refundPool,
                        appliedToNew,
                        leftover,
                        newCost,
                        newDemandNet,
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
                    chargeRetained,
                    refundPool,
                    pendingHostelRemoved: pendingHostelTotal,
                    bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                },
                newAssignment: {
                    transportRouteId,
                    routeName: route.name,
                    cost: newCost,
                    pricingSource,
                    creditApplied: appliedToNew,
                    studentOwes: newDemandNet,
                    feeDemandsCreated,
                    demandId: createdDemandId,
                },
                refund: {
                    leftover,
                    feeCorrectionId,
                },
                missingFeeHead: !transportHead
                    ? 'No FeeHead tagged with component=TRANSPORT — fee demand was NOT created.'
                    : null,
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
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
            chargeRetained?: number;
            reason: string;
            hostelId: string;
            hostelType: HostelType;
            hostelPaymentMode: 'YEARWISE' | 'SEMWISE';
            // Admin override for the new hostel charge (replaces config tier).
            customPricing?: { accommodation: number; mess: number; laundry: number; registration: number };
        },
        adminId?: string
    ) {
        const chargeRetained = Math.max(0, args.chargeRetained ?? 0);
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

        // Validate new hostel
        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);
        await assertHostelHasCapacity(hostelId);

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

        const refundPool = Math.max(0, transportPaid - chargeRetained);
        // Custom override → admin decides the hostel charge; don't auto-apply the
        // transport refund pool as a discount. The pool is still refunded in full below.
        const appliedToNew = args.customPricing ? 0 : Math.min(refundPool, effectiveTotal);
        const leftover = refundPool - appliedToNew;

        // Distribute appliedToNew proportionally across the 4 components.
        // Last (registration) absorbs rounding so the discounts sum exactly to appliedToNew.
        const distribute = (amount: number) =>
            effectiveTotal > 0 ? Math.round((amount / effectiveTotal) * appliedToNew) : 0;
        const accDiscount = distribute(accommodationPrice);
        const messDiscount = distribute(messPrice);
        const laundryDiscount = distribute(laundryPrice);
        const regDiscount = appliedToNew - accDiscount - messDiscount - laundryDiscount;

        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true },
        });
        const previousRouteId = admissionRow?.transportRouteId ?? null;

        const result = await prisma.$transaction(async (tx) => {
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
                    hostelId,
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
                    hostelId,
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
                discount: number,
                label: string
            ) => {
                if (!head || gross <= 0) return false;
                const net = Math.max(0, gross - discount);
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: head.id,
                        amount: gross,
                        discountAmount: discount,
                        netAmount: net,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: net === 0 ? FeeStatus.FULL : FeeStatus.PENDING,
                        remarks:
                            discount > 0
                                ? `Hostel ${label} (${hostelType}, ${roomType}, ${isSemwise ? 'SEMWISE' : 'YEARWISE'}). Transport-cancellation credit applied: ${discount}. Reason: ${reason}`
                                : `Hostel ${label} (${hostelType}, ${roomType}, ${isSemwise ? 'SEMWISE' : 'YEARWISE'}). Reason: ${reason}`,
                        createdBy: adminId,
                    },
                });
                return true;
            };
            let feeDemandsCreated = 0;
            if (await buildDemand(accHead, accommodationPrice, accDiscount, 'accommodation')) feeDemandsCreated++;
            if (await buildDemand(messHead, messPrice, messDiscount, 'mess')) feeDemandsCreated++;
            if (await buildDemand(laundryHead, laundryPrice, laundryDiscount, 'laundry')) feeDemandsCreated++;
            if (await buildDemand(regHead, registrationFee, regDiscount, 'registration')) feeDemandsCreated++;

            // ── 5. Refund leftover ──
            let feeCorrectionId: string | null = null;
            if (leftover > 0) {
                const fc = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: leftover,
                        reason: `Transport→Hostel switch leftover refund: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousRouteId,
                        referenceType: 'TRANSPORT_TO_HOSTEL_SWITCH',
                        remarks: `transportPaid: ${transportPaid}, chargeRetained: ${chargeRetained}, refundPool: ${refundPool}, appliedToNewHostel: ${appliedToNew}, leftover: ${leftover}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
                feeCorrectionId = fc.id;
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
                        chargeRetained,
                        refundPool,
                        appliedToNew,
                        leftover,
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
                    chargeRetained,
                    refundPool,
                    pendingTransportRemoved: pendingTransportTotal,
                },
                newAssignment: {
                    hostelId,
                    hostelType,
                    paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                    pricing: { accommodationPrice, messPrice, laundryPrice, registrationFee, effectiveTotal },
                    creditApplied: appliedToNew,
                    creditDistribution: { accDiscount, messDiscount, laundryDiscount, regDiscount },
                    studentOwes: Math.max(0, effectiveTotal - appliedToNew),
                    feeDemandsCreated,
                },
                refund: {
                    leftover,
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
        const appliedToNew = args.customPricing ? 0 : Math.min(availableCredit, newEffectiveTotal);
        const leftoverRefund = args.customPricing ? 0 : Math.max(0, availableCredit - newEffectiveTotal);

        const distribute = (componentPrice: number) =>
            newEffectiveTotal > 0 ? Math.round((componentPrice / newEffectiveTotal) * appliedToNew) : 0;
        const accDiscount = distribute(accommodationPrice);
        const messDiscount = distribute(messPrice);
        const laundryDiscount = distribute(laundryPrice);
        const regDiscount = appliedToNew - accDiscount - messDiscount - laundryDiscount;

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
                priorRefunds: credit.priorRefunds,
                availableCredit,
                appliedToNew,
                studentOwes: Math.max(0, newEffectiveTotal - appliedToNew),
                leftoverRefund,
                creditDistribution: { accDiscount, messDiscount, laundryDiscount, regDiscount },
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
    async previewCancelHostel(studentId: string, args: { cancellationFee?: number }) {
        const cancellationFee = Math.max(0, args.cancellationFee ?? 0);

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel hostel');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }
        if (admission.accommodationType !== AccommodationType.HOSTEL) {
            throw new AppError(`Student is not on HOSTEL (currently ${admission.accommodationType}). Nothing to cancel.`, 400);
        }
        if (!admission.academicYearId) {
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
                where: { studentId, feeHeadId: { in: hostelHeadIds }, status: FeeStatus.PENDING, isDeleted: false },
                _sum: { netAmount: true },
            });
            pendingDemandTotal = pendingAgg._sum.netAmount ?? 0;
        }

        const allocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });

        const credit = await getAvailableHostelCredit(studentId);
        const paid = credit.grossPaid;
        const availableCredit = credit.availableCredit;
        const refundAmount = Math.max(0, availableCredit - cancellationFee);

        return {
            preview: true,
            paid,
            priorRefunds: credit.priorRefunds,
            availableCredit,
            cancellationFee,
            refundAmount,
            pendingDemandToRemove: pendingDemandTotal,
            bedToVacate: !!allocation,
        };
    },

    /**
     * Preview cancelTransport: compute the refundable amount and pending demand
     * that would be removed — without writing.
     */
    async previewCancelTransport(studentId: string, args: { cancellationFee?: number }) {
        const cancellationFee = Math.max(0, args.cancellationFee ?? 0);

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel transport');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }
        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(`Student is not on TRANSPORT (currently ${admission.accommodationType}). Nothing to cancel.`, 400);
        }
        if (!admission.academicYearId) {
            throw new AppError('Cannot cancel: student has no academicYearId on admission', 400);
        }

        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

        const paidAgg = await prisma.payment.aggregate({
            where: { studentId, status: PaymentStatus.SUCCESS, isDeleted: false, component: PaymentComponent.TRANSPORT },
            _sum: { amount: true },
        });
        const paid = paidAgg._sum.amount ?? 0;

        let pendingDemandTotal = 0;
        if (transportHead) {
            const pendingAgg = await prisma.studentFeeDemand.aggregate({
                where: { studentId, feeHeadId: transportHead.id, status: FeeStatus.PENDING, isDeleted: false },
                _sum: { netAmount: true },
            });
            pendingDemandTotal = pendingAgg._sum.netAmount ?? 0;
        }

        const refundAmount = Math.max(0, paid - cancellationFee);

        return {
            preview: true,
            paid,
            cancellationFee,
            refundAmount,
            pendingDemandToRemove: pendingDemandTotal,
        };
    },

    /**
     * Preview switchHostelToTransport: compute the refund pool, credit applied to
     * the new transport demand, and any leftover refund — without writing.
     */
    async previewSwitchHostelToTransport(
        studentId: string,
        args: { chargeRetained?: number; transportRouteId: string; customCost?: number }
    ) {
        const chargeRetained = Math.max(0, args.chargeRetained ?? 0);
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
                where: { studentId, feeHeadId: { in: hostelHeadIds }, status: FeeStatus.PENDING, isDeleted: false },
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

        // Custom override → admin cost verbatim; mirrors the write path.
        const newCost = args.customCost ?? await resolveTransportRouteCost(transportRouteId, academicYearId);
        const pricingSource: 'CONFIG' | 'CUSTOM' = args.customCost != null ? 'CUSTOM' : 'CONFIG';

        const credit = await getAvailableHostelCredit(studentId);
        const hostelPaid = credit.grossPaid;
        const availableCredit = credit.availableCredit;
        const refundPool = Math.max(0, availableCredit - chargeRetained);
        // Custom override → no auto-applied discount (mirrors the write path).
        const appliedToNew = args.customCost != null ? 0 : Math.min(refundPool, newCost);
        const leftover = refundPool - appliedToNew;
        const newDemandNet = Math.max(0, newCost - appliedToNew);

        return {
            preview: true,
            cancellation: {
                hostelPaid,
                priorRefunds: credit.priorRefunds,
                availableCredit,
                chargeRetained,
                refundPool,
                pendingHostelToRemove: pendingHostelTotal,
            },
            newAssignment: {
                transportRouteId,
                routeName: route.name,
                cost: newCost,
                pricingSource,
                creditApplied: appliedToNew,
                studentOwes: newDemandNet,
            },
            refund: { leftover },
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
        args: { chargeRetained?: number; hostelId: string; hostelType: HostelType; hostelPaymentMode: 'YEARWISE' | 'SEMWISE'; customPricing?: { accommodation: number; mess: number; laundry: number; registration: number } }
    ) {
        const chargeRetained = Math.max(0, args.chargeRetained ?? 0);
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

        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);
        await assertHostelHasCapacity(hostelId);

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

        const paidAgg = await prisma.payment.aggregate({
            where: { studentId, status: PaymentStatus.SUCCESS, isDeleted: false, component: PaymentComponent.TRANSPORT },
            _sum: { amount: true },
        });
        const transportPaid = paidAgg._sum.amount ?? 0;

        let pendingTransportTotal = 0;
        if (transportHead) {
            const pAgg = await prisma.studentFeeDemand.aggregate({
                where: { studentId, feeHeadId: transportHead.id, status: FeeStatus.PENDING, isDeleted: false },
                _sum: { netAmount: true },
            });
            pendingTransportTotal = pAgg._sum.netAmount ?? 0;
        }

        const refundPool = Math.max(0, transportPaid - chargeRetained);
        // Custom override → no auto-applied discount (mirrors the write path).
        const appliedToNew = args.customPricing ? 0 : Math.min(refundPool, effectiveTotal);
        const leftover = refundPool - appliedToNew;

        const distribute = (amount: number) =>
            effectiveTotal > 0 ? Math.round((amount / effectiveTotal) * appliedToNew) : 0;
        const accDiscount = distribute(accommodationPrice);
        const messDiscount = distribute(messPrice);
        const laundryDiscount = distribute(laundryPrice);
        const regDiscount = appliedToNew - accDiscount - messDiscount - laundryDiscount;

        return {
            preview: true,
            cancellation: {
                transportPaid,
                chargeRetained,
                refundPool,
                pendingTransportToRemove: pendingTransportTotal,
            },
            newAssignment: {
                hostelId,
                hostelType,
                paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                pricing: { accommodationPrice, messPrice, laundryPrice, registrationFee, effectiveTotal },
                pricingSource,
                creditApplied: appliedToNew,
                creditDistribution: { accDiscount, messDiscount, laundryDiscount, regDiscount },
                studentOwes: Math.max(0, effectiveTotal - appliedToNew),
            },
            refund: { leftover },
        };
    },
};
