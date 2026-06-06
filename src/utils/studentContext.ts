import prisma from '../config/prisma';
import { AppError } from './AppError';
import logger from './logger';
import {
    AccommodationType,
    AdmissionStatus,
    HostelPaymentMode,
    HostelType,
    PaymentComponent,
    QuotaType
} from '@prisma/client';

export interface StudentContext {
    studentId: string;
    name: string;
    applicationId: string | null;

    admission: {
        id: string;
        status: AdmissionStatus | null;
        accommodationType: AccommodationType | null;
        hostelId: string | null;
        hostelType: HostelType | null;
        hostelPaymentMode: HostelPaymentMode | null;
        roomNumber: string | null;
        academicYearId: string;
        allottedCourseId: string | null;
        totalFee: number | null;
        paidFee: number | null;
    } | null;

    enrollment: {
        id: string;
        sectionId: string;
        rollNumber: string;
        currentSemester: number | null;
        yearOfStudy: number | null;
        academicYearId: string;
        status: string | null;
    } | null;

    accommodationPricing: any | null;

    hostel: {
        id: string;
        name: string;
        type: string | null;
        accommodationBank: string | null;
        messBank: string | null;
        laundryBank: string | null;
        registrationBank: string | null;
        isDeleted: boolean | null;
    } | null;

    yearOfStudy: number;
    currentSemester: number;
    academicYearId: string | null;
    quotaType: QuotaType | null;
    courseType: string | null;
    proId: string | null;
}

export const getStudentContext = async (studentId: string, tx?: any): Promise<StudentContext> => {
    const client = tx || prisma;

    const student = await client.student.findUnique({
        where: { id: studentId },
        include: {
            admissionDetails: true,
            enrollments: {
                where: { status: 'ACTIVE' },
                orderBy: { createdAt: 'desc' },
                take: 1
            },
            accommodationPricing: {
                where: { isActive: true },
                take: 1
            }
        }
    });
    if (!student) throw new AppError('Student not found', 404);

    const admission = student.admissionDetails ?? null;
    const enrollment = student.enrollments?.[0] ?? null;

    let hostel: any = null;
    if (admission?.hostelId) {
        hostel = await client.hostel.findUnique({
            where: { id: admission.hostelId },
            select: {
                id: true, name: true, type: true,
                accommodationBank: true, messBank: true,
                laundryBank: true, registrationBank: true,
                isDeleted: true
            }
        });
    }

    const yearOfStudy = enrollment?.yearOfStudy
        ?? (enrollment?.currentSemester ? Math.ceil(enrollment.currentSemester / 2) : null)
        ?? (admission as any)?.entryYearOfStudy
        ?? 1;

    const currentSemester = enrollment?.currentSemester ?? 1;

    const academicYearId =
        admission?.academicYearId
        ?? enrollment?.academicYearId
        ?? null;

    return {
        studentId: student.id,
        name: student.name,
        applicationId: student.applicationId,
        admission: admission ? {
            id: admission.id,
            status: admission.status,
            accommodationType: admission.accommodationType,
            hostelId: admission.hostelId,
            hostelType: admission.hostelType,
            hostelPaymentMode: admission.hostelPaymentMode,
            roomNumber: admission.roomNumber,
            academicYearId: admission.academicYearId,
            allottedCourseId: admission.allottedCourseId,
            totalFee: admission.totalFee,
            paidFee: admission.paidFee,
        } : null,
        enrollment: enrollment ? {
            id: enrollment.id,
            sectionId: enrollment.sectionId,
            rollNumber: enrollment.rollNumber,
            currentSemester: enrollment.currentSemester,
            yearOfStudy: enrollment.yearOfStudy,
            academicYearId: enrollment.academicYearId,
            status: enrollment.status,
        } : null,
        accommodationPricing: student.accommodationPricing?.[0] ?? null,
        hostel,
        yearOfStudy,
        currentSemester,
        academicYearId,
        quotaType: student.quotaType ?? null,
        courseType: student.courseType ?? null,
        proId: student.proId ?? null,
    };
};

export const getStudentYearOfStudy = async (studentId: string, tx?: any): Promise<number> => {
    const client = tx || prisma;
    const [enrollment, admission] = await Promise.all([
        client.studentEnrollment.findFirst({
            where: { studentId, status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            select: { yearOfStudy: true, currentSemester: true }
        }),
        client.studentAdmission.findUnique({
            where: { studentId },
            select: { entryYearOfStudy: true }
        }),
    ]);
    if (enrollment?.yearOfStudy) return enrollment.yearOfStudy;
    if (enrollment?.currentSemester) return Math.ceil(enrollment.currentSemester / 2);
    if (admission?.entryYearOfStudy) return admission.entryYearOfStudy;
    return 1;
};

export const resolveFeeDemandContext = async (
    feeDemandId: string | null | undefined,
    tx?: any
): Promise<{ academicYearId: string; yearOfStudy: number | undefined }> => {
    const client = tx || prisma;
    if (feeDemandId) {
        const demand = await client.studentFeeDemand.findUnique({
            where: { id: feeDemandId },
            select: { academicYearId: true, yearOfStudy: true }
        });
        if (demand) {
            return {
                academicYearId: demand.academicYearId,
                yearOfStudy: demand.yearOfStudy ?? undefined,
            };
        }
    }

    const active = await getActiveAcademicYear(tx);
    return { academicYearId: active.id, yearOfStudy: undefined };
};

export const assertAcademicYearWritable = async (academicYearId: string, tx?: any): Promise<{
    id: string;
    code: string;
    startDate: Date;
    endDate: Date;
}> => {
    const client = tx || prisma;
    const ay = await client.academicYear.findUnique({
        where: { id: academicYearId },
        select: { id: true, code: true, startDate: true, endDate: true, isActive: true, isLocked: true, isDeleted: true },
    });
    if (!ay) {
        throw new AppError(`Academic year ${academicYearId} not found`, 404);
    }
    if (ay.isDeleted) {
        throw new AppError(`Academic year ${ay.code} has been deleted`, 410);
    }
    if (ay.isLocked) {

        throw new AppError(`Academic year ${ay.code} is locked; financial / enrollment writes are not permitted`, 423);
    }
    return { id: ay.id, code: ay.code, startDate: ay.startDate, endDate: ay.endDate };
};

export const getActiveAcademicYear = async (tx?: any): Promise<{
    id: string;
    code: string;
    startDate: Date;
    endDate: Date;
}> => {
    const client = tx || prisma;
    const candidates = await client.academicYear.findMany({
        where: { isActive: true, isDeleted: false },
        orderBy: { startDate: 'desc' },
        select: { id: true, code: true, startDate: true, endDate: true },
    });
    if (candidates.length === 0) {
        throw new AppError('No active academic year configured. Create one and mark isActive=true.', 500);
    }
    if (candidates.length > 1) {

        logger.warn(
            `[getActiveAcademicYear] Multiple active academic years detected (${candidates.map((c: any) => c.code).join(', ')}). ` +
            `Returning the most recent (${candidates[0].code}). Fix data so only one year is isActive=true.`
        );
    }
    return candidates[0];
};

const HOSTEL_REFERENCE_TYPES = [
    'HOSTEL_REASSIGNMENT',
    'HOSTEL_CANCELLATION',
    'HOSTEL_TO_TRANSPORT_SWITCH',
];

const TRANSPORT_REFERENCE_TYPES = [
    'TRANSPORT_CANCELLATION',
    'TRANSPORT_TO_HOSTEL_SWITCH',
];

export const getAvailableHostelCredit = async (studentId: string, tx?: any): Promise<{
    grossPaid: number;
    priorRefunded: number;
    priorRetained: number;
    availableCredit: number;
}> => {
    const client = tx || prisma;

    const [paidAgg, priorAgg] = await Promise.all([
        client.payment.aggregate({
            where: {
                studentId,
                status: 'SUCCESS',
                isDeleted: false,
                component: { in: [
                    'HOSTEL',
                    'HOSTEL_ACCOMMODATION',
                    'HOSTEL_MESS',
                    'HOSTEL_LAUNDRY',
                    'HOSTEL_REGISTRATION',
                ]},
            },
            _sum: { amount: true },
        }),
        client.feeCorrection.aggregate({
            where: { studentId, referenceType: { in: HOSTEL_REFERENCE_TYPES } },
            _sum: { amount: true, retainedAmount: true },
        }),
    ]);

    const grossPaid       = paidAgg._sum.amount ?? 0;
    const priorRefunded   = priorAgg._sum.amount ?? 0;
    const priorRetained   = priorAgg._sum.retainedAmount ?? 0;
    const availableCredit = Math.max(0, grossPaid - priorRefunded - priorRetained);

    return { grossPaid, priorRefunded, priorRetained, availableCredit };
};

export const getAvailableTransportCredit = async (studentId: string, tx?: any): Promise<{
    grossPaid: number;
    priorRefunded: number;
    priorRetained: number;
    availableCredit: number;
}> => {
    const client = tx || prisma;

    const [paidAgg, priorAgg] = await Promise.all([
        client.payment.aggregate({
            where: { studentId, status: 'SUCCESS', isDeleted: false, component: 'TRANSPORT' },
            _sum: { amount: true },
        }),
        client.feeCorrection.aggregate({
            where: { studentId, referenceType: { in: TRANSPORT_REFERENCE_TYPES } },
            _sum: { amount: true, retainedAmount: true },
        }),
    ]);

    const grossPaid       = paidAgg._sum.amount ?? 0;
    const priorRefunded   = priorAgg._sum.amount ?? 0;
    const priorRetained   = priorAgg._sum.retainedAmount ?? 0;
    const availableCredit = Math.max(0, grossPaid - priorRefunded - priorRetained);

    return { grossPaid, priorRefunded, priorRetained, availableCredit };
};

export const recomputeStudentTotals = async (
    studentId: string,
    tx?: any
): Promise<{ totalFee: number; paidFee: number }> => {
    const client = tx || prisma;

    const [demandAgg, paidAgg, transferAgg] = await Promise.all([
        client.studentFeeDemand.aggregate({
            where: { studentId, isDeleted: false },
            _sum: { amount: true },
        }),
        client.payment.aggregate({
            where: { studentId, status: 'SUCCESS', isDeleted: false, component: { not: 'APPLICATION_FEE' } },
            _sum: { amount: true },
        }),

        client.payment.aggregate({
            where: {
                studentId, status: 'SUCCESS', isDeleted: false,
                metadata: { path: ['kind'], equals: 'FEE_CORRECTION_TRANSFER' },
            },
            _sum: { amount: true },
        }),
    ]);

    const totalFee     = demandAgg._sum.amount ?? 0;
    const transferPaid = transferAgg._sum.amount ?? 0;
    const paidFee      = (paidAgg._sum.amount ?? 0) - transferPaid;

    await client.studentAdmission.update({
        where: { studentId },
        data: { totalFee, paidFee },
    });

    return { totalFee, paidFee };
};

export const resolveHostelPriceCategory = async (
    args: { sharing: number; roomType: string; academicYearId: string },
    tx?: any
): Promise<any | null> => {
    const client = tx || prisma;
    const { sharing, roomType, academicYearId } = args;
    return await client.hostelPriceCategory.findFirst({
        where: { sharing, roomType, isActive: true, academicYearId }
    }) ?? null;
};

export const resolveTransportRouteCost = async (
    routeId: string,
    academicYearId: string | null | undefined,
    tx?: any
): Promise<number> => {
    const client = tx || prisma;
    if (academicYearId) {
        const override = await client.transportRouteYearlyPrice.findFirst({
            where: { routeId, academicYearId }
        });
        if (override) return override.cost;
    }
    const route = await client.transportRoute.findUnique({
        where: { id: routeId },
        select: { cost: true }
    });
    return route?.cost ?? 0;
};

export const getOrCreateAccommodationPricing = async (studentId: string, tx?: any): Promise<any | null> => {
    const client = tx || prisma;

    const existing = await client.studentAccommodationPricing.findFirst({
        where: { studentId, isActive: true }
    });
    if (existing) return existing;

    const admission = await client.studentAdmission.findUnique({
        where: { studentId },
        select: {
            studentId: true,
            accommodationType: true,
            hostelId: true,
            hostelType: true,
            roomNumber: true,
            hostelPaymentMode: true,
            academicYearId: true
        }
    });

    if (!admission
        || admission.accommodationType !== AccommodationType.HOSTEL
        || !admission.hostelId
        || !admission.hostelType
        || !admission.roomNumber) {

        return null;
    }

    const room = await client.hostelRoom.findFirst({
        where: { hostelId: admission.hostelId, number: admission.roomNumber, isDeleted: false },
        select: { capacity: true, type: true }
    });
    if (!room) {
        logger.warn(`[getOrCreateAccommodationPricing] Room "${admission.roomNumber}" not found in hostel ${admission.hostelId} for student ${studentId} — cannot create snapshot`);
        return null;
    }

    const sharing = room.capacity;
    const roomType = room.type;

    const priceCategory = await resolveHostelPriceCategory(
        { sharing, roomType, academicYearId: admission.academicYearId },
        client
    );
    if (!priceCategory) {
        logger.warn(`[getOrCreateAccommodationPricing] No active price tier for sharing=${sharing}, roomType=${roomType}, academicYearId=${admission.academicYearId ?? '<null>'} — cannot create snapshot for student ${studentId}`);
        return null;
    }

    const isSemwise = admission.hostelPaymentMode === 'SEMWISE';
    const accommodationPrice = (isSemwise ? priceCategory.accommodationSemwise : priceCategory.accommodationYearwise) ?? 0;
    const messPrice          = (isSemwise ? priceCategory.messSemwise          : priceCategory.messYearwise)          ?? 0;
    const laundryPrice       = (isSemwise ? priceCategory.laundrySemwise       : priceCategory.laundryYearwise)       ?? 0;
    const registrationFee    = priceCategory.registrationFee ?? 0;
    const effectiveTotal     = accommodationPrice + messPrice + laundryPrice + registrationFee;

    try {
        const snapshot = await client.studentAccommodationPricing.create({
            data: {
                studentId,
                academicYearId: admission.academicYearId,
                sharing,
                roomType,
                paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                hostelId: admission.hostelId,
                accommodationPrice,
                messPrice,
                laundryPrice,
                registrationFee,
                effectiveTotal,
                pricingSource: 'AUTO_BACKFILL',
                isActive: true,
                createdBy: 'system'
            }
        });
        logger.info(`[getOrCreateAccommodationPricing] Auto-backfilled snapshot for student ${studentId} (mode=${isSemwise ? 'SEMWISE' : 'YEARWISE'}, total=₹${effectiveTotal})`);
        return snapshot;
    } catch (err: any) {

        if (err?.code === 'P2002') {
            return await client.studentAccommodationPricing.findFirst({
                where: { studentId, isActive: true }
            });
        }
        throw err;
    }
};

export type FeeHeadByComponent = Map<PaymentComponent, { id: string; name: string } | null>;

export const resolveFeeHeadsByComponent = async (
    components: PaymentComponent[],
    tx?: any
): Promise<FeeHeadByComponent> => {
    const client = tx || prisma;
    const allHeads = await client.feeHead.findMany({
        where: { isDeleted: false, component: { in: components } },
        select: { id: true, name: true, component: true }
    });

    const result: FeeHeadByComponent = new Map();
    for (const c of components) {
        const head = allHeads.find((h: any) => h.component === c);
        result.set(c, head ? { id: head.id, name: head.name } : null);
    }
    return result;
};

export const assertActiveAdmission = (
    admission: { status: AdmissionStatus | null } | null | undefined,
    actionLabel: string = 'perform this action'
): void => {
    if (!admission) {
        throw new AppError('Student has no admission record', 404);
    }
    if (admission.status === AdmissionStatus.CANCELLED) {
        throw new AppError(`Cannot ${actionLabel} — admission is cancelled`, 400);
    }
};

export const assertHostelAccommodation = (
    admission: { accommodationType: AccommodationType | null } | null | undefined,
    extraHint: string = 'Run assign-hostel first.'
): void => {
    if (!admission || admission.accommodationType !== AccommodationType.HOSTEL) {
        throw new AppError(`Student does not have HOSTEL accommodation. ${extraHint}`, 400);
    }
};

export const assertNoBedAllocated = (
    accommodationPricing: any | null | undefined,
    extraHint: string = 'Use the re-assignment flow instead.'
): void => {
    if (accommodationPricing) {
        throw new AppError(`Student already has a bed allocated. ${extraHint}`, 409);
    }
};
