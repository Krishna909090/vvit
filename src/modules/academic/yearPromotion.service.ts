import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { assertAcademicYearWritable } from '../../utils/studentContext';
import { FeeService } from '../finance/fee.service';

/**
 * Year Promotion Service
 * Handles student progression from one academic year to the next.
 */

interface PromotionResult {
    total: number;
    promoted: number;
    skipped: number;
    failed: number;
    creditsCarriedForward: number;     // count of FeeCorrection rows carried
    creditAmountCarriedForward: number; // ₹ total of carried credit
    demandsSeeded: number;             // count of new-year demands created
    details: { studentId: string; status: string; message?: string }[];
}

/**
 * Promote all active students from current academic year to new academic year.
 * Creates new StudentEnrollment records with incremented semester/year.
 *
 * For each promoted student, this also (when options enabled — default ON):
 *   - Validates the target academic year is writable (not isLocked)
 *   - Seeds next-year fee demands via FeeService.generateFeeDemands (if FeeStructure rows exist)
 *   - Carries forward unsettled FeeCorrection refunds:
 *       * applies the credit as discount across new-year PENDING demands (largest first)
 *       * marks each carried correction isSettled=true with carriedForwardToYearId
 */
export const promoteStudents = async (
    fromAcademicYearId: string,
    toAcademicYearId: string,
    adminId: string,
    options: { seedFeeDemands?: boolean; carryForwardCredits?: boolean } = {}
): Promise<PromotionResult> => {
    const seedFeeDemands       = options.seedFeeDemands       ?? true;
    const carryForwardCredits  = options.carryForwardCredits  ?? true;

    logger.info(`[YearPromotion] Starting promotion from=${fromAcademicYearId} to=${toAcademicYearId} by=${adminId} seed=${seedFeeDemands} carry=${carryForwardCredits}`);

    // Validate academic years
    const [fromYear, toYear] = await Promise.all([
        prisma.academicYear.findUnique({ where: { id: fromAcademicYearId } }),
        prisma.academicYear.findUnique({ where: { id: toAcademicYearId } })
    ]);

    if (!fromYear) throw new AppError('Source academic year not found', 404);
    if (!toYear) throw new AppError('Target academic year not found', 404);
    if (fromAcademicYearId === toAcademicYearId) throw new AppError('Source and target academic year cannot be the same', 400);
    // Target year must be writable. Source year may be locked — that's fine because
    // we don't write to source-year records; we only read enrollment.
    await assertAcademicYearWritable(toAcademicYearId);

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
        creditsCarriedForward: 0,
        creditAmountCarriedForward: 0,
        demandsSeeded: 0,
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

            // Advance the admission's "current year" pointer too. entryAcademicYearId
            // stays frozen for cohort reporting.
            const admission = await prisma.studentAdmission.findUnique({
                where: { studentId: enrollment.studentId },
                select: { id: true, allottedCourseId: true, academicYearId: true }
            });
            if (admission) {
                await prisma.studentAdmission.update({
                    where: { studentId: enrollment.studentId },
                    data: { academicYearId: toAcademicYearId }
                });
            }

            // Optional: seed next-year fee demands. Quietly skip if course missing
            // (manual entries that didn't go through normal admission).
            let seededCount = 0;
            if (seedFeeDemands && admission?.allottedCourseId) {
                try {
                    const fsCount = await prisma.feeStructure.count({
                        where: {
                            courseId: admission.allottedCourseId,
                            academicYearId: toAcademicYearId,
                            isDeleted: false
                        }
                    });
                    if (fsCount === 0) {
                        logger.warn(`[YearPromotion] No FeeStructure for course=${admission.allottedCourseId} in ${toYear.code}; demands NOT seeded for student=${enrollment.studentId}. Clone fee structures first.`);
                    } else {
                        const seeded = await FeeService.generateFeeDemands(
                            enrollment.studentId,
                            admission.allottedCourseId,
                            toAcademicYearId,
                            adminId,
                            false
                            // allowLegacyFallback defaults to true → preserves legacy promotion behavior
                        );
                        seededCount = seeded?.generated ?? 0;
                        result.demandsSeeded += seededCount;
                    }
                } catch (err: any) {
                    logger.error(`[YearPromotion] generateFeeDemands failed for student=${enrollment.studentId}: ${err.message}`);
                }
            }

            // Optional: carry forward unsettled FeeCorrection credits as discount on
            // the new year's largest PENDING demands. Settles each correction with
            // carriedForwardToYearId set so audit trail links source → target.
            let carriedAmount = 0;
            if (carryForwardCredits) {
                try {
                    const unsettled = await (prisma as any).feeCorrection.findMany({
                        where: {
                            studentId: enrollment.studentId,
                            isSettled: false,
                            carryForward: true,
                        },
                        orderBy: { createdAt: 'asc' }
                    });
                    if (unsettled.length > 0) {
                        const totalCredit = unsettled.reduce((s: number, c: any) => s + (c.amount ?? 0), 0);
                        // Apply credit across PENDING/PARTIAL demands in the new year, largest first
                        const targets = await prisma.studentFeeDemand.findMany({
                            where: {
                                studentId: enrollment.studentId,
                                academicYearId: toAcademicYearId,
                                isDeleted: false,
                                status: { in: ['PENDING', 'PARTIAL'] }
                            },
                            orderBy: { amount: 'desc' }
                        });

                        let remaining = totalCredit;
                        for (const d of targets) {
                            if (remaining <= 0) break;
                            const open = Math.max(0, (d.netAmount ?? d.amount) - 0);
                            if (open <= 0) continue;
                            const apply = Math.min(remaining, open);
                            const newDiscount = (d.discountAmount ?? 0) + apply;
                            const newNet = Math.max(0, d.amount - newDiscount);
                            await prisma.studentFeeDemand.update({
                                where: { id: d.id },
                                data: {
                                    discountAmount: newDiscount,
                                    netAmount: newNet,
                                    status: newNet === 0 ? 'FULL' : 'PARTIAL',
                                    remarks: (d.remarks ?? '') +
                                        ` | Carried-forward credit applied from ${fromYear.code}: ₹${apply}`,
                                    updatedBy: adminId,
                                }
                            });
                            remaining -= apply;
                        }

                        // Mark all carried corrections settled. If `remaining > 0` (no eligible
                        // demand to absorb full credit), the leftover stays in the response so
                        // admin knows to issue a cash refund manually.
                        carriedAmount = totalCredit - remaining;
                        for (const c of unsettled) {
                            await (prisma as any).feeCorrection.update({
                                where: { id: c.id },
                                data: {
                                    isSettled: true,
                                    settledAt: new Date(),
                                    settledBy: adminId,
                                    carriedForwardToYearId: toAcademicYearId,
                                    remarks: (c.remarks ?? '') +
                                        ` | Carried forward to ${toYear.code} during year promotion`,
                                    updatedBy: adminId,
                                }
                            });
                        }
                        result.creditsCarriedForward += unsettled.length;
                        result.creditAmountCarriedForward += carriedAmount;

                        if (remaining > 0) {
                            logger.warn(`[YearPromotion] Credit ₹${remaining} could not be applied to demands for student=${enrollment.studentId} (no eligible PENDING demands). Manual refund needed.`);
                        }
                    }
                } catch (err: any) {
                    logger.error(`[YearPromotion] Carry-forward failed for student=${enrollment.studentId}: ${err.message}`);
                }
            }

            result.promoted++;
            result.details.push({
                studentId: enrollment.studentId,
                status: 'PROMOTED',
                message: `Year ${enrollment.yearOfStudy || Math.ceil((enrollment.currentSemester || 1) / 2)} -> Year ${newYearOfStudy}` +
                    (seededCount > 0 ? `, ${seededCount} demand(s) seeded` : '') +
                    (carriedAmount > 0 ? `, ₹${carriedAmount} credit carried forward` : '')
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

    logger.info(`[YearPromotion] Complete. Promoted: ${result.promoted}, Skipped: ${result.skipped}, Failed: ${result.failed}, Demands seeded: ${result.demandsSeeded}, Credits carried: ${result.creditsCarriedForward} (₹${result.creditAmountCarriedForward})`);
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
