import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';

/**
 * Year Promotion Service
 * Handles student progression from one academic year to the next.
 */

interface PromotionResult {
    total: number;
    promoted: number;
    skipped: number;
    failed: number;
    details: { studentId: string; status: string; message?: string }[];
}

/**
 * Promote all active students from current academic year to new academic year.
 * Creates new StudentEnrollment records with incremented semester/year.
 */
export const promoteStudents = async (
    fromAcademicYearId: string,
    toAcademicYearId: string,
    adminId: string
): Promise<PromotionResult> => {
    logger.info(`[YearPromotion] Starting promotion from=${fromAcademicYearId} to=${toAcademicYearId} by=${adminId}`);

    // Validate academic years
    const [fromYear, toYear] = await Promise.all([
        prisma.academicYear.findUnique({ where: { id: fromAcademicYearId } }),
        prisma.academicYear.findUnique({ where: { id: toAcademicYearId } })
    ]);

    if (!fromYear) throw new AppError('Source academic year not found', 404);
    if (!toYear) throw new AppError('Target academic year not found', 404);
    if (fromAcademicYearId === toAcademicYearId) throw new AppError('Source and target academic year cannot be the same', 400);

    // Get all active enrollments in the source academic year
    const activeEnrollments = await prisma.studentEnrollment.findMany({
        where: {
            academicYearId: fromAcademicYearId,
            status: 'ACTIVE'
        },
        include: {
            student: { select: { id: true, applicationId: true, name: true } }
        }
    });

    logger.info(`[YearPromotion] Found ${activeEnrollments.length} active enrollments to promote`);

    const result: PromotionResult = {
        total: activeEnrollments.length,
        promoted: 0,
        skipped: 0,
        failed: 0,
        details: []
    };

    for (const enrollment of activeEnrollments) {
        try {
            // Check if student already has enrollment in target year
            const existingInTarget = await prisma.studentEnrollment.findUnique({
                where: {
                    studentId_academicYearId: {
                        studentId: enrollment.studentId,
                        academicYearId: toAcademicYearId
                    }
                }
            });

            if (existingInTarget) {
                result.skipped++;
                result.details.push({
                    studentId: enrollment.studentId,
                    status: 'SKIPPED',
                    message: 'Already enrolled in target academic year'
                });
                continue;
            }

            const newSemester = (enrollment.currentSemester || 1) + 2; // Advance by 2 semesters (1 year)
            const newYearOfStudy = Math.ceil(newSemester / 2);

            // Create new enrollment for target year
            await prisma.studentEnrollment.create({
                data: {
                    studentId: enrollment.studentId,
                    sectionId: enrollment.sectionId,
                    rollNumber: enrollment.rollNumber,
                    currentSemester: newSemester,
                    yearOfStudy: newYearOfStudy,
                    academicYearId: toAcademicYearId,
                    status: 'ACTIVE'
                }
            });

            // Mark old enrollment as completed
            await prisma.studentEnrollment.update({
                where: { id: enrollment.id },
                data: { status: 'COMPLETED' as any }
            });

            result.promoted++;
            result.details.push({
                studentId: enrollment.studentId,
                status: 'PROMOTED',
                message: `Year ${enrollment.yearOfStudy || Math.ceil((enrollment.currentSemester || 1) / 2)} -> Year ${newYearOfStudy}`
            });

        } catch (err: any) {
            result.failed++;
            result.details.push({
                studentId: enrollment.studentId,
                status: 'FAILED',
                message: err.message
            });
            logger.error(`[YearPromotion] Failed for student=${enrollment.studentId}: ${err.message}`);
        }
    }

    logger.info(`[YearPromotion] Complete. Promoted: ${result.promoted}, Skipped: ${result.skipped}, Failed: ${result.failed}`);
    return result;
};

/**
 * Get enrollment history for a student across all academic years.
 */
export const getStudentEnrollmentHistory = async (studentId: string) => {
    const enrollments = await prisma.studentEnrollment.findMany({
        where: { studentId },
        include: {
            academicYear: { select: { id: true, code: true, startDate: true, endDate: true } },
            section: { select: { id: true, name: true } }
        },
        orderBy: { createdAt: 'asc' }
    });

    return enrollments.map(e => ({
        id: e.id,
        academicYear: e.academicYear,
        section: e.section,
        rollNumber: e.rollNumber,
        semester: e.currentSemester,
        yearOfStudy: e.yearOfStudy || Math.ceil((e.currentSemester || 1) / 2),
        status: e.status,
        createdAt: e.createdAt
    }));
};

/**
 * Get financial summary for a student by academic year.
 */
export const getStudentYearWiseFinancials = async (studentId: string) => {
    const [payments, demands, ledger] = await Promise.all([
        prisma.payment.findMany({
            where: { studentId, status: 'SUCCESS', isDeleted: false },
            include: { academicYear: { select: { code: true } }, feeHead: { select: { name: true } } },
            orderBy: { createdAt: 'asc' }
        }),
        prisma.studentFeeDemand.findMany({
            where: { studentId, isDeleted: false },
            include: { academicYear: { select: { code: true } }, feeHead: { select: { name: true } } },
            orderBy: { createdAt: 'asc' }
        }),
        prisma.studentLedger.findMany({
            where: { studentId, isDeleted: false },
            include: { academicYear: { select: { code: true } } },
            orderBy: { date: 'asc' }
        })
    ]);

    // Group by academic year
    const yearMap = new Map<string, { year: string, demands: any[], payments: any[], ledger: any[], totalDemand: number, totalPaid: number }>();

    for (const d of demands) {
        const yearCode = d.academicYear?.code || 'UNASSIGNED';
        if (!yearMap.has(yearCode)) yearMap.set(yearCode, { year: yearCode, demands: [], payments: [], ledger: [], totalDemand: 0, totalPaid: 0 });
        const entry = yearMap.get(yearCode)!;
        entry.demands.push(d);
        entry.totalDemand += d.amount;
    }

    for (const p of payments) {
        const yearCode = p.academicYear?.code || 'UNASSIGNED';
        if (!yearMap.has(yearCode)) yearMap.set(yearCode, { year: yearCode, demands: [], payments: [], ledger: [], totalDemand: 0, totalPaid: 0 });
        const entry = yearMap.get(yearCode)!;
        entry.payments.push(p);
        entry.totalPaid += p.amount;
    }

    for (const l of ledger) {
        const yearCode = (l as any).academicYear?.code || 'UNASSIGNED';
        if (!yearMap.has(yearCode)) yearMap.set(yearCode, { year: yearCode, demands: [], payments: [], ledger: [], totalDemand: 0, totalPaid: 0 });
        yearMap.get(yearCode)!.ledger.push(l);
    }

    return Array.from(yearMap.values()).map(y => ({
        academicYear: y.year,
        totalDemand: y.totalDemand,
        totalPaid: y.totalPaid,
        balance: y.totalDemand - y.totalPaid,
        demandCount: y.demands.length,
        paymentCount: y.payments.length
    }));
};
