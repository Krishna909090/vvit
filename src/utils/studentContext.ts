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

/**
 * Fully-loaded student context — everything our services need to make decisions
 * about a student in one shot. Replaces the duplicated `findUnique + derive year +
 * fetch enrollment + check status` pattern scattered across the codebase.
 *
 * Pass `tx` when calling inside a Prisma transaction.
 */
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

    // Derived fields — already resolved with sensible fallbacks
    yearOfStudy: number;          // never null: enrollment.yearOfStudy → derived from semester → 1
    currentSemester: number;      // never null: enrollment.currentSemester → 1
    academicYearId: string | null; // admission.academicYearId → enrollment.academicYearId → null (kept nullable for callers that lack admission)
    quotaType: QuotaType | null;
    courseType: string | null;
    proId: string | null;
}

/**
 * Load full student context. Throws 404 if the student doesn't exist.
 */
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

    // Year-of-study fallback chain: explicit enrollment value → derived from semester → 1
    const yearOfStudy = enrollment?.yearOfStudy
        ?? (enrollment?.currentSemester ? Math.ceil(enrollment.currentSemester / 2) : null)
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

/**
 * Resolve only the student's year-of-study (lighter call when full context isn't needed).
 */
export const getStudentYearOfStudy = async (studentId: string, tx?: any): Promise<number> => {
    const client = tx || prisma;
    const enrollment = await client.studentEnrollment.findFirst({
        where: { studentId, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        select: { yearOfStudy: true, currentSemester: true }
    });
    if (!enrollment) return 1;
    if (enrollment.yearOfStudy) return enrollment.yearOfStudy;
    if (enrollment.currentSemester) return Math.ceil(enrollment.currentSemester / 2);
    return 1;
};

/* ──────────────── Payment context resolution from fee demand ─────────────── */

/**
 * Resolve `{ academicYearId, yearOfStudy }` from a fee demand.
 *
 * Used at Payment.create time to denormalize these onto the Payment row, so reports
 * filtered by year/academic-year don't need a JOIN through the demand every read.
 *
 * Returns `{ academicYearId: undefined, yearOfStudy: undefined }` if `feeDemandId`
 * is missing, the demand doesn't exist, or its values are null. Callers should
 * spread this result into the Payment data object.
 */
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
    // No demand → fall back to the active academic year so Payment.academicYearId is always set.
    const active = await getActiveAcademicYear(tx);
    return { academicYearId: active.id, yearOfStudy: undefined };
};

/* ──────────────────── Academic year guards (write-path safety) ───────────────────── */

/**
 * Assert the academic year is writable: exists, not soft-deleted, not locked.
 *
 * Use this in any flow that writes financial or enrollment data tied to a specific
 * academic year — admissions, fee demands, payments, ledger entries, reassign /
 * switch / cancel flows. Locking a year (via AcademicYear.isLocked=true) is the
 * year-end "books closed" signal — once locked, no further writes against that
 * year's records should be allowed.
 *
 * Use 423 Locked (HTTP) for the lock case so the client UI can render a clear
 * "this year is closed" message instead of a generic 400.
 *
 * Pass `tx` when calling inside a transaction so the read sees pending changes.
 */
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
        // 423 Locked — client should render "this year is closed" rather than retry
        throw new AppError(`Academic year ${ay.code} is locked; financial / enrollment writes are not permitted`, 423);
    }
    return { id: ay.id, code: ay.code, startDate: ay.startDate, endDate: ay.endDate };
};

/**
 * Returns the current active academic year. Throws if none configured or multiple
 * are flagged active (which is a data-integrity error — at most one year should be
 * isActive=true at a time).
 *
 * Use this whenever a flow needs to default to "the year we're currently in" —
 * for example, when an admin creates an admission without specifying a year.
 *
 * For back-dated admissions, callers should NOT use this — they should accept an
 * explicit `academicYearId` from the caller (since "current year" wouldn't apply).
 */
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
        // Data-integrity warning, not a fatal — pick the most recent and log
        logger.warn(
            `[getActiveAcademicYear] Multiple active academic years detected (${candidates.map((c: any) => c.code).join(', ')}). ` +
            `Returning the most recent (${candidates[0].code}). Fix data so only one year is isActive=true.`
        );
    }
    return candidates[0];
};

/* ─────────────────── Hostel credit accounting (idempotent) ───────────────────── */

/**
 * Available hostel credit = paid-in cash minus already-promised refunds.
 *
 * Returns the amount of student-paid hostel money that is still "in" the college's
 * hostel ledger and available to be applied as a discount on a NEW hostel demand
 * during reassign / switch / cancel flows.
 *
 *   availableCredit = max(0, gross_hostel_payments
 *                          − sum(FeeCorrection.amount for accommodation/branch refunds))
 *
 * Why subtract FeeCorrection rows (settled AND unsettled): each row represents
 * cash that is either already disbursed back to the student (settled), or
 * earmarked for disbursement (unsettled). In both cases the cash is no longer
 * available to credit against new demands.
 *
 * Without this clamp, the same paid-in money gets reused as discount across
 * multiple reassign cycles (SHARING_4 → SHARING_8 → SHARING_4 → SHARING_8),
 * creating phantom refund rows and over-stating what the college owes back.
 *
 * Pass `tx` when calling inside a Prisma transaction.
 */
export const getAvailableHostelCredit = async (studentId: string, tx?: any): Promise<{
    grossPaid: number;
    priorRefunds: number;
    availableCredit: number;
}> => {
    const client = tx || prisma;

    const [paidAgg, refundAgg] = await Promise.all([
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
            where: {
                studentId,
                type: { in: ['ACCOMMODATION_CHANGE_REFUND', 'BRANCH_CHANGE_REFUND'] },
            },
            _sum: { amount: true },
        }),
    ]);

    const grossPaid     = paidAgg._sum.amount ?? 0;
    const priorRefunds  = refundAgg._sum.amount ?? 0;
    const availableCredit = Math.max(0, grossPaid - priorRefunds);

    return { grossPaid, priorRefunds, availableCredit };
};

/**
 * Transport analogue of getAvailableHostelCredit. Available transport credit =
 * gross TRANSPORT payments − transport refunds already issued (FeeCorrection rows
 * from a prior transport cancellation or transport→hostel switch). Without this
 * netting, a cancel/switch cycle re-refunds the same transport rupees (double refund).
 *
 * Scoped precisely to transport refund referenceTypes so it never double-subtracts
 * hostel refunds. Pass `tx` when inside a Prisma transaction.
 */
export const getAvailableTransportCredit = async (studentId: string, tx?: any): Promise<{
    grossPaid: number;
    priorRefunds: number;
    availableCredit: number;
}> => {
    const client = tx || prisma;

    const [paidAgg, refundAgg] = await Promise.all([
        client.payment.aggregate({
            where: { studentId, status: 'SUCCESS', isDeleted: false, component: 'TRANSPORT' },
            _sum: { amount: true },
        }),
        client.feeCorrection.aggregate({
            where: {
                studentId,
                type: 'ACCOMMODATION_CHANGE_REFUND',
                referenceType: { in: ['TRANSPORT_CANCELLATION', 'TRANSPORT_TO_HOSTEL_SWITCH'] },
            },
            _sum: { amount: true },
        }),
    ]);

    const grossPaid     = paidAgg._sum.amount ?? 0;
    const priorRefunds  = refundAgg._sum.amount ?? 0;
    const availableCredit = Math.max(0, grossPaid - priorRefunds);

    return { grossPaid, priorRefunds, availableCredit };
};

/**
 * Recompute and persist a student's `totalFee` and `paidFee` from the source-of-truth
 * rows instead of relying on running increment/decrement deltas (which drift over time
 * — see the year-long audit: re-assign/switch/cancel flows left paid demands behind and
 * over/under-counted totals).
 *
 *   totalFee = Σ `amount` of active (non-deleted) StudentFeeDemand rows.
 *              Gross, matching the historical "sum of base amounts" semantic; callers
 *              that need net-of-scholarship aggregate from `netAmount` directly.
 *   paidFee  = Σ `amount` of SUCCESS, non-deleted Payment rows EXCLUDING APPLICATION_FEE
 *              (the application fee is tracked separately and was never part of paidFee).
 *
 * Idempotent and self-healing — safe to call at the end of ANY money-mutating flow, and
 * safe to re-run. Pass `tx` to participate in an open transaction.
 */
export const recomputeStudentTotals = async (
    studentId: string,
    tx?: any
): Promise<{ totalFee: number; paidFee: number }> => {
    const client = tx || prisma;

    const [demandAgg, paidAgg] = await Promise.all([
        client.studentFeeDemand.aggregate({
            where: { studentId, isDeleted: false },
            _sum: { amount: true },
        }),
        client.payment.aggregate({
            where: { studentId, status: 'SUCCESS', isDeleted: false, component: { not: 'APPLICATION_FEE' } },
            _sum: { amount: true },
        }),
    ]);

    const totalFee = demandAgg._sum.amount ?? 0;
    const paidFee  = paidAgg._sum.amount ?? 0;

    await client.studentAdmission.update({
        where: { studentId },
        data: { totalFee, paidFee },
    });

    return { totalFee, paidFee };
};

/**
 * Resolve the active HostelPriceCategory for a (sharing, roomType, academicYearId)
 * tuple. academicYearId is required since the year-tag migration — every price row
 * is now bound to a specific academic year.
 *
 * Returns null if no matching active price exists — caller should treat as
 * "no pricing configured for this year."
 *
 * Pass `tx` when calling inside a Prisma transaction.
 */
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

/**
 * Resolve transport route cost for a given academic year. Prefers the year-specific
 * override in TransportRouteYearlyPrice; falls back to TransportRoute.cost.
 *
 * Useful for back-dated / lateral admissions billed against a past year's route fee.
 *
 * Pass `tx` when calling inside a Prisma transaction.
 */
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

/* ────────────── Self-healing accommodation pricing snapshot ──────────────── */

/**
 * Returns the student's frozen accommodation pricing snapshot.
 *
 * Behaviour (single source of truth — no fallback paths in callers):
 *   1. Snapshot exists → return it.
 *   2. No snapshot AND student is FULLY bed-allocated
 *      (accommodationType=HOSTEL + hostelId + hostelType + roomNumber):
 *      → auto-create one from current config (self-healing for legacy data).
 *   3. No snapshot AND student is NOT fully allocated
 *      (e.g. between assign-hostel and allocate-bed, or pure NONE/TRANSPORT):
 *      → return null. Caller should show ₹0 hostel demand — student isn't yet
 *      eligible to be billed for accommodation.
 *
 * This eliminates divergent code paths in financial-history/summary readers.
 *
 * Why auto-create: ensures snapshot is the *only* source of truth at read time.
 * Legacy or manually-inserted allocations get a snapshot on first read; future
 * config edits never affect them again. No future code changes needed.
 *
 * Pass `tx` when calling inside a Prisma transaction.
 */
export const getOrCreateAccommodationPricing = async (studentId: string, tx?: any): Promise<any | null> => {
    const client = tx || prisma;

    // 1. Existing active snapshot — return as-is.
    // Supersede semantics: at most one row per studentId has isActive=true at any time.
    // Older rows (isActive=false) are kept for audit/refund history but never read here.
    const existing = await client.studentAccommodationPricing.findFirst({
        where: { studentId, isActive: true }
    });
    if (existing) return existing;

    // 2. No snapshot — see if we have enough info to create one
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
        // Student is not fully bed-allocated — caller should show 0 for hostel demand
        return null;
    }

    // 3. Resolve sharing/roomType from the room (single source of truth on dimensions)
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

    // 4. Resolve active price tier (year-scoped, falls back to legacy year-null row).
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

    // 5. Self-healing create. Race-condition safe via the partial unique index
    // (studentId) WHERE isActive=true — see migration SQL.
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
        // P2002 = unique constraint violation; another concurrent request created it first.
        if (err?.code === 'P2002') {
            return await client.studentAccommodationPricing.findFirst({
                where: { studentId, isActive: true }
            });
        }
        throw err;
    }
};

/* ──────────────────────────── FeeHead resolution ─────────────────────────── */

/**
 * Cached map of `PaymentComponent` → matching FeeHead row.
 *
 * Strict mode (no fallback): every FeeHead must have an explicit `component` column set.
 * Run the backfill SQL provided in the migration docs to tag legacy heads. Untagged heads
 * will return `null` here, and any flow depending on that component will skip cleanly.
 */
export type FeeHeadByComponent = Map<PaymentComponent, { id: string; name: string } | null>;

/**
 * Build a `PaymentComponent → FeeHead` lookup map by reading the explicit `component` column.
 * No name-keyword fallback. If a FeeHead doesn't have its `component` set, it won't be matched.
 *
 * Pass `tx` when calling inside a Prisma transaction.
 */
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

/* ──────────────────────────── Status assertions ──────────────────────────── */

/**
 * Throws 400 if the admission is cancelled. Use as the first guard in any
 * write-flow that touches a student's admission/hostel/fees.
 */
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

/**
 * Throws 400 if the student is not currently in HOSTEL accommodation.
 */
export const assertHostelAccommodation = (
    admission: { accommodationType: AccommodationType | null } | null | undefined,
    extraHint: string = 'Run assign-hostel first.'
): void => {
    if (!admission || admission.accommodationType !== AccommodationType.HOSTEL) {
        throw new AppError(`Student does not have HOSTEL accommodation. ${extraHint}`, 400);
    }
};

/**
 * Throws 400 if the student already has a frozen pricing snapshot
 * (i.e. a bed has already been allocated).
 */
export const assertNoBedAllocated = (
    accommodationPricing: any | null | undefined,
    extraHint: string = 'Use the re-assignment flow instead.'
): void => {
    if (accommodationPricing) {
        throw new AppError(`Student already has a bed allocated. ${extraHint}`, 409);
    }
};
