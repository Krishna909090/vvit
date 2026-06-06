import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { CancellationStatus, AdmissionStatus, PaymentStatus, PaymentComponent } from '@prisma/client';
import { generateInvoicePDF } from '../../utils/invoiceGenerator';
import { uploadFileToS3, convertToPresignedUrl } from '../../utils/s3Utils';
import { sendCancellationReceipt } from '../../utils/emailService';
import { incrementCourseCapacity, decrementCourseCapacity } from '../../utils/courseCapacity';
import { getStudentYearOfStudy } from '../../utils/studentContext';

const DEFAULT_DEDUCTION = 10_000;

export type CancellationConditionType =
    | 'OTHER_COLLEGE_CANCEL'
    | 'INTERNAL_BRANCH_TRANSFER'
    | 'QUOTA_MGMT_TO_CONVENOR'
    | 'QUOTA_CONVENOR_TO_MGMT'
    | 'NORMAL_SEAT_CANCEL'
    | 'MANAGEMENT_CANCEL_FULL_REFUND';

export type FinalStatus =
    | 'REFUND_DUE'
    | 'REFUND_FULL'
    | 'TRANSFER'
    | 'BALANCE_DUE'
    | 'NO_ACTION';

export interface ComponentPaid {
    tuition:   number;
    admission: number;
    bookBank:  number;
    hostel:    number;
    transport: number;
    others:    number;
}

export interface AdjustmentInput {
    conditionType:   CancellationConditionType;
    totalPaid:       number;
    componentPaid:   ComponentPaid;
    oldQuotaFee?:    number;
    newQuotaFee?:    number;
    cancellationFee?: number;
}

export interface ComponentBreakdown {
    paid:      number;
    deducted:  number;
    refund:    number;
    transfer:  number;
}

export interface AdjustmentResult {
    conditionType:      CancellationConditionType;
    deductionAmount:    number;
    refundAmount:       number;
    transferAmount:     number;
    balanceDue:         number;
    finalStatus:        FinalStatus;
    conditionRemarks:   string;
    componentBreakdown: {
        tuition:   ComponentBreakdown;
        admission: ComponentBreakdown;
        bookBank:  ComponentBreakdown;
        hostel:    ComponentBreakdown;
        transport: ComponentBreakdown;
        others:    ComponentBreakdown;
    };
}

// ─────────────────────────────────────────────────────────────
// Pure calculation — no DB access
// ─────────────────────────────────────────────────────────────
/**
 * Pure (no DB) calculation of a cancellation's financial outcome: deduction,
 * refund, transfer, balance due, and per-component breakdown. Branches on
 * `conditionType` (quota-change vs full cancel) — this is the single source of
 * truth for "how much money moves" when a seat is cancelled.
 */
export const calculateFeeAdjustment = (input: AdjustmentInput): AdjustmentResult => {
    const { conditionType, totalPaid, componentPaid, newQuotaFee = 0, cancellationFee } = input;
    const deductionFee = cancellationFee ?? DEFAULT_DEDUCTION;

    const comp = {
        tuition:   componentPaid.tuition   ?? 0,
        admission: componentPaid.admission ?? 0,
        bookBank:  componentPaid.bookBank  ?? 0,
        hostel:    componentPaid.hostel    ?? 0,
        transport: componentPaid.transport ?? 0,
        others:    componentPaid.others    ?? 0,
    };

    // Helpers to build zero breakdown
    const zeroBreakdown = (paid: number): ComponentBreakdown =>
        ({ paid, deducted: 0, refund: 0, transfer: 0 });

    let deductionAmount = 0;
    let refundAmount    = 0;
    let transferAmount  = 0;
    let balanceDue      = 0;
    let finalStatus: FinalStatus = 'NO_ACTION';
    let conditionRemarks = '';

    const breakdown = {
        tuition:   zeroBreakdown(comp.tuition),
        admission: zeroBreakdown(comp.admission),
        bookBank:  zeroBreakdown(comp.bookBank),
        hostel:    zeroBreakdown(comp.hostel),
        transport: zeroBreakdown(comp.transport),
        others:    zeroBreakdown(comp.others),
    };

    switch (conditionType) {

        case 'OTHER_COLLEGE_CANCEL':
        case 'NORMAL_SEAT_CANCEL': {
            // Deduct cancellation fee from Tuition (capped at what was paid in Tuition)
            const tuitionDeduction = Math.min(deductionFee, comp.tuition);
            // If Tuition alone didn't cover it, take remainder from others in order
            let remainingDeduction = deductionFee - tuitionDeduction;

            breakdown.tuition.deducted = tuitionDeduction;
            deductionAmount += tuitionDeduction;

            // Spill into hostel if needed
            if (remainingDeduction > 0) {
                const hostelDeduction = Math.min(remainingDeduction, comp.hostel);
                breakdown.hostel.deducted = hostelDeduction;
                deductionAmount += hostelDeduction;
                remainingDeduction -= hostelDeduction;
            }

            // Compute per-component refund (paid - deducted)
            (['tuition', 'admission', 'bookBank', 'hostel', 'transport', 'others'] as const).forEach(k => {
                breakdown[k].refund = breakdown[k].paid - breakdown[k].deducted;
            });

            refundAmount = Math.max(0, totalPaid - deductionAmount);
            finalStatus  = refundAmount > 0 ? 'REFUND_DUE' : 'NO_ACTION';
            conditionRemarks = `${deductionAmount.toLocaleString()} deducted. ${refundAmount.toLocaleString()} refundable.`;
            break;
        }

        case 'INTERNAL_BRANCH_TRANSFER': {
            // Full component-wise transfer, no deduction
            transferAmount = totalPaid;
            (['tuition', 'admission', 'bookBank', 'hostel', 'transport', 'others'] as const).forEach(k => {
                breakdown[k].transfer = breakdown[k].paid;
            });
            finalStatus       = 'TRANSFER';
            conditionRemarks  = 'Full amount transferred component-wise to new branch. No deduction.';
            break;
        }

        case 'QUOTA_MGMT_TO_CONVENOR': {
            // Refund excess if TotalPaid > NewQuotaFee; no deduction
            const excess = totalPaid - newQuotaFee;
            if (excess > 0) {
                refundAmount = excess;
                finalStatus  = 'REFUND_DUE';
                conditionRemarks = `Quota reduced. ${refundAmount.toLocaleString()} refundable (excess over new quota ${newQuotaFee.toLocaleString()}).`;
                // Spread refund across components proportionally
                _spreadRefundProportionally(breakdown, comp, refundAmount, totalPaid);
            } else {
                finalStatus      = 'NO_ACTION';
                conditionRemarks = 'Paid amount is within new quota. No refund required.';
            }
            break;
        }

        case 'QUOTA_CONVENOR_TO_MGMT': {
            // Student owes the difference if TotalPaid < NewQuotaFee; no deduction
            const shortfall = newQuotaFee - totalPaid;
            if (shortfall > 0) {
                balanceDue   = shortfall;
                finalStatus  = 'BALANCE_DUE';
                conditionRemarks = `Quota increased. ${balanceDue.toLocaleString()} balance due (new quota ${newQuotaFee.toLocaleString()}).`;
            } else {
                finalStatus      = 'NO_ACTION';
                conditionRemarks = 'Paid amount covers new quota. No balance due.';
            }
            break;
        }

        case 'MANAGEMENT_CANCEL_FULL_REFUND': {
            // Full refund, no deduction
            refundAmount = totalPaid;
            (['tuition', 'admission', 'bookBank', 'hostel', 'transport', 'others'] as const).forEach(k => {
                breakdown[k].refund = breakdown[k].paid;
            });
            finalStatus      = 'REFUND_FULL';
            conditionRemarks = 'Full refund approved by management.';
            break;
        }
    }

    logger.info(`[calculateFeeAdjustment] Type=${conditionType}, TotalPaid=${totalPaid}, Deduction=${deductionAmount}, Refund=${refundAmount}, Transfer=${transferAmount}, BalanceDue=${balanceDue}, Status=${finalStatus}`);

    return {
        conditionType,
        deductionAmount,
        refundAmount,
        transferAmount,
        balanceDue,
        finalStatus,
        conditionRemarks,
        componentBreakdown: breakdown,
    };
};

// Proportional refund spread helper
/** Internal: distribute a refund pool across fee components proportionally to what was paid in each. */
const _spreadRefundProportionally = (
    breakdown: AdjustmentResult['componentBreakdown'],
    comp: ComponentPaid,
    refundAmount: number,
    totalPaid: number,
) => {
    if (totalPaid === 0) return;
    (['tuition', 'admission', 'bookBank', 'hostel', 'transport', 'others'] as const).forEach(k => {
        breakdown[k].refund = Math.round((comp[k] / totalPaid) * refundAmount);
    });
};

// ─────────────────────────────────────────────────────────────
// Fetch real paid amounts per component from Payment table
// ─────────────────────────────────────────────────────────────
/** Internal: aggregate a student's successful payments into per-component totals (tuition/admission/hostel/etc.) used by the adjustment calc. */
const fetchComponentPaid = async (studentId: string): Promise<{ componentPaid: ComponentPaid; totalPaid: number }> => {
    const payments = await prisma.payment.findMany({
        where: { studentId, status: PaymentStatus.SUCCESS },
        select: { component: true, amount: true },
    });

    const componentPaid: ComponentPaid = { tuition: 0, admission: 0, bookBank: 0, hostel: 0, transport: 0, others: 0 };

    for (const p of payments) {
        switch (p.component) {
            case PaymentComponent.APPLICATION_FEE:
            case PaymentComponent.COURSE_CHANGE_FEE:
                // Non-refundable — excluded from cancellation adjustment
                break;
            case PaymentComponent.TUITION:
            case PaymentComponent.SCHOLARSHIP_TOKEN:
                componentPaid.tuition += p.amount;
                break;
            case PaymentComponent.ADMISSION:
                componentPaid.admission += p.amount;
                break;
            case PaymentComponent.BOOK_BANK:
                componentPaid.bookBank += p.amount;
                break;
            case PaymentComponent.HOSTEL:
            case PaymentComponent.HOSTEL_ACCOMMODATION:
            case PaymentComponent.HOSTEL_MESS:
                componentPaid.hostel += p.amount;
                break;
            case PaymentComponent.TRANSPORT:
                componentPaid.transport += p.amount;
                break;
            default:
                componentPaid.others += p.amount;
        }
    }

    const totalPaid = componentPaid.tuition + componentPaid.admission + componentPaid.bookBank + componentPaid.hostel + componentPaid.transport + componentPaid.others;

    logger.info(`[fetchComponentPaid] Student=${studentId} Tuition=${componentPaid.tuition} Admission=${componentPaid.admission} BookBank=${componentPaid.bookBank} Hostel=${componentPaid.hostel} Transport=${componentPaid.transport} Others=${componentPaid.others} Total=${totalPaid}`);

    return { componentPaid, totalPaid };
};


// ─────────────────────────────────────────────────────────────
// Generate cancellation receipt PDF, upload to S3, send email
// ─────────────────────────────────────────────────────────────
/** Internal: render + upload the cancellation receipt PDF; returns the S3 URL (or null on failure, best-effort). */
const _generateCancellationReceipt = async (request: any, now: Date): Promise<string | null> => {
    const student = request.student;
    if (!student) return null;

    const appId = student.applicationId || request.studentId.substring(0, 8).toUpperCase();
    const year  = now.getFullYear();

    const priorApproved = await prisma.cancellationRequest.count({
        where: {
            studentId: request.studentId,
            status:    CancellationStatus.APPROVED,
            id:        { not: request.id },
        },
    });
    const receiptNo     = (priorApproved + 1).toString().padStart(3, '0');
    const invoiceNumber = `VVITU/CANCEL/${year}/${appId}/${receiptNo}`;

    const comp: any = request.componentPaid ?? {};
    const items: { description: string; amount: number }[] = [];
    if ((comp.tuition   ?? 0) > 0) items.push({ description: 'Tuition Fee Paid',   amount: comp.tuition });
    if ((comp.admission ?? 0) > 0) items.push({ description: 'Admission Fee Paid', amount: comp.admission });
    if ((comp.bookBank  ?? 0) > 0) items.push({ description: 'Book Bank Fee Paid', amount: comp.bookBank });
    if ((comp.hostel    ?? 0) > 0) items.push({ description: 'Hostel Fee Paid',    amount: comp.hostel });
    if ((comp.transport ?? 0) > 0) items.push({ description: 'Transport Fee Paid', amount: comp.transport });
    if ((comp.others    ?? 0) > 0) items.push({ description: 'Other Fees Paid',    amount: comp.others });
    if ((request.deductionAmount ?? 0) > 0)
        items.push({ description: 'Cancellation Deduction (Non-refundable)', amount: -(request.deductionAmount) });
    if ((request.refundAmount    ?? 0) > 0)
        items.push({ description: 'Refund Amount',                           amount: request.refundAmount });
    if ((request.transferAmount  ?? 0) > 0)
        items.push({ description: 'Transfer Amount (to new branch)',         amount: request.transferAmount });
    if ((request.balanceDue      ?? 0) > 0)
        items.push({ description: 'Balance Due from Student',                amount: request.balanceDue });

    const summaryAmount =
        (request.refundAmount   ?? 0) ||
        (request.transferAmount ?? 0) ||
        (request.balanceDue     ?? 0) ||
        (request.totalPaid      ?? 0);

    const invoiceData = {
        invoiceNumber,
        date:            now,
        studentName:     student.name,
        studentId:       appId,
        paymentMethod:   '',
        transactionId:   request.id,
        amount:          summaryAmount,
        description:     `Seat Cancellation — ${(request.conditionRemarks ?? request.conditionType ?? '').replace(/_/g, ' ')}`,
        isCancellation:  true,
        reason:          request.conditionType?.replace(/_/g, ' ') ?? 'CANCELLATION',
        items,
        address: {
            line1:   student.address    ?? student.addressLine1 ?? '',
            line2:   student.address2   ?? student.addressLine2 ?? '',
            city:    student.city       ?? '',
            state:   student.state      ?? '',
            pincode: student.pincode    ?? '',
        },
    };

    const pdfBuffer  = await generateInvoicePDF(invoiceData);
    const s3Key      = `student/${appId}/cancellation/${request.id}.pdf`;
    const invoiceUrl = await uploadFileToS3(pdfBuffer, s3Key, 'application/pdf');

    if (student.email) {
        try {
            await sendCancellationReceipt(student.email, {
                studentName:   student.name,
                applicationId: appId,
                conditionType: request.conditionType ?? 'CANCELLATION',
                amount:        summaryAmount,
                date:          now,
            }, pdfBuffer);
        } catch (emailErr) {
            logger.warn(`[_generateCancellationReceipt] Email failed (non-fatal): ${emailErr}`);
        }
    }

    return invoiceUrl;
};

// ─────────────────────────────────────────────────────────────
// DB Operations
// ─────────────────────────────────────────────────────────────
export const CancellationService = {

    /**
     * Create a cancellation request. Fetches per-component paid totals, runs
     * `calculateFeeAdjustment` to compute deduction/refund/transfer/balance,
     * and persists the request (year-tagged) in REQUESTED status for approval.
     */
    async createCancellationRequest(data: {
        studentId:               string;
        reason:                  string;
        remarks?:                string;
        conditionType:           CancellationConditionType;
        oldQuotaFee?:            number;
        newQuotaFee?:            number;
        fileUrl?:                string;
        recommendedByManagement?: boolean;
        cancellationFee?:        number;
    }, adminId: string) {
        const student = await prisma.student.findUnique({ where: { id: data.studentId } });
        if (!student) throw new AppError('Student not found', 404);

        const existing = await prisma.cancellationRequest.findFirst({
            where: { studentId: data.studentId, status: CancellationStatus.REQUESTED },
            select: { id: true },
        });
        if (existing) {
            throw new AppError(
                `A cancellation request is already pending for this student (ID: ${existing.id}). Approve or reject it before raising a new one.`,
                409,
            );
        }

        // Auto-fetch real paid amounts from Payment records — admin cannot manipulate these
        const { componentPaid, totalPaid } = await fetchComponentPaid(data.studentId);

        // If recommended by management, force cancellation fee to 0
        const effectiveFee = data.recommendedByManagement ? 0 : (data.cancellationFee ?? DEFAULT_DEDUCTION);

        const adjustment = calculateFeeAdjustment({ ...data, componentPaid, totalPaid, cancellationFee: effectiveFee });

        logger.info(`[CancellationService.createCancellationRequest] Student=${data.studentId}, ConditionType=${data.conditionType}, RecommendedByMgmt=${data.recommendedByManagement}, Fee=${effectiveFee}`);

        const cancelYear = await prisma.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });
        return await prisma.cancellationRequest.create({
            data: {
                studentId:        data.studentId,
                academicYearId:   cancelYear.id,
                reason:           data.reason,
                conditionType:    data.conditionType as any,
                oldQuotaFee:      data.oldQuotaFee,
                newQuotaFee:      data.newQuotaFee,
                totalPaid:        totalPaid,
                componentPaid:    componentPaid as any,
                deductionAmount:  adjustment.deductionAmount,
                refundAmount:     adjustment.refundAmount,
                transferAmount:   adjustment.transferAmount,
                balanceDue:       adjustment.balanceDue,
                finalStatus:      adjustment.finalStatus,
                conditionRemarks: adjustment.conditionRemarks,
                remarks:                 data.remarks,
                fileUrl:                 data.fileUrl,
                recommendedByManagement: data.recommendedByManagement ?? false,
                cancellationFee:         effectiveFee,
                status:                  CancellationStatus.REQUESTED,
                createdBy:               adminId,
            },
            include: { student: { select: { name: true, applicationId: true } } },
        });
    },


    /**
     * Approve/reject a cancellation. On approve (atomic): marks admission
     * CANCELLED, vacates hostel + transport allocations, soft-deletes pending
     * demands, decrements course capacity, records refund ledger entries, and
     * generates the receipt PDF. On reject: just flips status with remarks.
     */
    async approveCancellation(requestId: string, approved: boolean, adminId: string, remarks?: string, cancellationFee?: number) {
        const request = await prisma.cancellationRequest.findUnique({
            where: { id: requestId },
            include: { student: { include: { admissionDetails: true } } },
        }) as any;

        if (!request) throw new AppError('Cancellation request not found', 404);

        // academicYearId is REQUIRED on StudentLedger — derive from the student's
        // admission (fall back to the active year) so the ledger creates below don't
        // fail Prisma validation ("Argument `academicYear` is missing").
        const ledgerYearId: string | undefined =
            request.student?.admissionDetails?.academicYearId
            ?? (await prisma.academicYear.findFirst({ where: { isActive: true, isDeleted: false }, select: { id: true } }))?.id;

        const studentCancellationYear = await getStudentYearOfStudy(request.studentId);

        const currentStatus = request.status;
        const newStatus = approved ? CancellationStatus.APPROVED : CancellationStatus.REJECTED;

        // No-op: already in the desired state
        if (currentStatus === newStatus) {
            const label = approved ? 'approved' : 'rejected';
            throw new AppError(`This cancellation request is already ${label}. No changes made.`, 400);
        }

        // Fail-closed guard: transfer / quota-change condition types are NOT cancellations.
        // The approve block below un-admits the student (status=CANCELLED, totalFee/paidFee=0,
        // demands deleted, payments flagged REFUNDED). That is correct for a real cancellation
        // but catastrophic for a branch transfer (INTERNAL_BRANCH_TRANSFER) or a quota change
        // (QUOTA_*), where the student MUST stay admitted and the money should transfer/adjust.
        // Those flows compute transferAmount/balanceDue but never apply them here, so the money
        // is silently lost. Block approval until a dedicated transfer handler exists — admins
        // should use the course/branch-change flow instead.
        if (
            approved &&
            ['INTERNAL_BRANCH_TRANSFER', 'QUOTA_MGMT_TO_CONVENOR', 'QUOTA_CONVENOR_TO_MGMT'].includes(request.conditionType)
        ) {
            throw new AppError(
                `Condition type "${request.conditionType}" is a branch/quota change, not a cancellation. ` +
                `Approving it here would un-admit the student and refund every payment, losing the ` +
                `transfer/balance amount. Use the course/branch-change flow to move the student and ` +
                `their fees instead.`,
                400
            );
        }

        // Recalculate if admin changed the cancellation fee at approval time
        if (approved && cancellationFee !== undefined && cancellationFee !== request.cancellationFee) {
            const adjustment = calculateFeeAdjustment({
                conditionType:   request.conditionType,
                totalPaid:       request.totalPaid ?? 0,
                componentPaid:   request.componentPaid ?? { tuition: 0, admission: 0, bookBank: 0, hostel: 0, transport: 0, others: 0 },
                oldQuotaFee:     request.oldQuotaFee,
                newQuotaFee:     request.newQuotaFee,
                cancellationFee,
            });
            request.cancellationFee  = cancellationFee;
            request.deductionAmount  = adjustment.deductionAmount;
            request.refundAmount     = adjustment.refundAmount;
            request.transferAmount   = adjustment.transferAmount;
            request.balanceDue       = adjustment.balanceDue;
            request.finalStatus      = adjustment.finalStatus;
            request.conditionRemarks = adjustment.conditionRemarks;
        }

        const now = new Date();
        const isReversal = currentStatus !== CancellationStatus.REQUESTED; // toggling an already-processed request

        await prisma.$transaction(async (tx) => {
            // Update the request status (+ recalculated fields if fee changed)
            await tx.cancellationRequest.update({
                where: { id: requestId },
                data: {
                    status:           newStatus,
                    approvedBy:       adminId,
                    approvedAt:       approved ? now : undefined,
                    rejectedAt:       !approved ? now : undefined,
                    remarks:          remarks ?? request.remarks,
                    ...(approved && cancellationFee !== undefined ? {
                        cancellationFee:  request.cancellationFee,
                        deductionAmount:  request.deductionAmount,
                        refundAmount:     request.refundAmount,
                        transferAmount:   request.transferAmount,
                        balanceDue:       request.balanceDue,
                        finalStatus:      request.finalStatus,
                        conditionRemarks: request.conditionRemarks,
                    } : {}),
                },
            });

            if (approved) {
                // ── APPROVE (fresh or re-approve after rejection) ──────────────
                const admission = request.student.admissionDetails;

                // Cancel admission & clear seat + hostel/transport allocation
                await tx.studentAdmission.update({
                    where: { studentId: request.studentId },
                    data:  {
                        status: AdmissionStatus.CANCELLED,
                        allottedCourseId: null,
                        seatAllotedBy: null,
                        seatAllottedAt: null,
                        paidFee: 0,
                        totalFee: 0,
                        accommodationType: 'NONE',
                        hostelId: null,
                        hostelType: null,
                        transportRouteId: null,
                        roomNumber: null,
                    },
                });

                // Free up course seat (year-scoped via CourseCapacity)
                if (admission?.allottedCourseId && admission.academicYearId) {
                    await decrementCourseCapacity(tx, admission.allottedCourseId, admission.academicYearId);
                }

                // Vacate hostel allocation (hostel "filled" is computed on-demand from StudentAdmission.hostelId)
                if (admission?.hostelId) {
                    await (tx.hostelAllocation as any).updateMany({
                        where: { studentId: request.studentId, status: 'ACTIVE' },
                        data:  { status: 'VACATED' },
                    });
                }

                // Cancel transport allocation
                if (admission?.transportRouteId) {
                    await (tx.transportAllocation as any).updateMany({
                        where: { studentId: request.studentId, status: 'ACTIVE' },
                        data:  { status: 'CANCELLED' },
                    });
                }

                // Reset scholarship allocation AND return the slot to the rule pool.
                // Previously only the allocation was expired; rule.filledSlots was never
                // decremented, so cancelled students permanently consumed a scholarship slot
                // and eligible students hit "Slots full".
                const allocsToExpire = await (tx.scholarshipAllocation as any).findMany({
                    where: { studentId: request.studentId, status: { not: 'EXPIRED' } },
                    select: { ruleId: true },
                });
                await (tx.scholarshipAllocation as any).updateMany({
                    where: { studentId: request.studentId },
                    data:  { status: 'EXPIRED' },
                });
                const ruleCounts = new Map<string, number>();
                for (const a of allocsToExpire) {
                    if (a.ruleId) ruleCounts.set(a.ruleId, (ruleCounts.get(a.ruleId) ?? 0) + 1);
                }
                for (const [ruleId, n] of ruleCounts) {
                    const rule = await (tx.scholarshipRule as any).findUnique({ where: { id: ruleId }, select: { filledSlots: true } });
                    if (rule) {
                        await (tx.scholarshipRule as any).update({
                            where: { id: ruleId },
                            data:  { filledSlots: Math.max(0, (rule.filledSlots ?? 0) - n) },
                        });
                    }
                }

                // Reset student scholarship eligibility
                await (tx.studentScholarship as any).updateMany({
                    where: { studentId: request.studentId },
                    data:  { isEligible: 'NO', remarks: 'Cancelled — seat cancellation' },
                });

                // Fetch total scholarship amount before deleting fee demands
                const scholarshipAggregate = await (tx.studentFeeDemand as any).aggregate({
                    where: { studentId: request.studentId },
                    _sum: { scholarshipAmount: true },
                });
                const totalScholarshipAmount = scholarshipAggregate._sum?.scholarshipAmount ?? 0;

                // Ledger: reverse scholarship amount (DEBIT with SCHOLARSHIP type so it nets out with original SCHOLARSHIP CREDIT)
                if (totalScholarshipAmount > 0) {
                    await tx.studentLedger.create({
                        data: {
                            studentId:     request.studentId,
                            type:          'DEBIT' as any,
                            amount:        totalScholarshipAmount,
                            description:   `Scholarship Reversed - Seat Cancellation (${request.conditionType})`,
                            referenceId:   request.id,
                            referenceType: 'SCHOLARSHIP',
                            academicYearId: ledgerYearId,
                            yearOfStudy:   studentCancellationYear,
                            createdBy:     adminId,
                            date:          now,
                        } as any,
                    });
                }

                // Mark payments as REFUNDED and unlink feeDemandId (audit trail — not deleted)
                await tx.payment.updateMany({
                    where: {
                        studentId: request.studentId,
                        status: PaymentStatus.SUCCESS,
                        component: { not: PaymentComponent.APPLICATION_FEE },
                    },
                    data: { status: PaymentStatus.REFUNDED, feeDemandId: null },
                });

                // Delete fee demands (safe now — feeDemandId unlinked above)
                await (tx.studentFeeDemand as any).deleteMany({
                    where: { studentId: request.studentId },
                });

                // Remove allotment order document
                await (tx.studentDocument as any).deleteMany({
                    where: { studentId: request.studentId, documentKey: 'ALLOTMENT_ORDER' },
                });

                // Delete any existing ledger entries from a prior approval (avoid duplicates on re-approve)
                if (isReversal) {
                    await (tx.studentLedger as any).deleteMany({
                        where: { referenceId: request.id, referenceType: 'CANCELLATION' },
                    });
                }

                // Ledger: component-wise deduction (DEBIT) and refund (CREDIT) entries
                const componentBreakdown = request.componentPaid ?? {};
                const componentLabels: Record<string, string> = {
                    tuition: 'Tuition', admission: 'Admission', bookBank: 'Book Bank',
                    hostel: 'Hostel', transport: 'Transport', others: 'Others',
                };

                // Recalculate breakdown for ledger
                const ledgerAdjustment = calculateFeeAdjustment({
                    conditionType:   request.conditionType,
                    totalPaid:       request.totalPaid ?? 0,
                    componentPaid:   componentBreakdown,
                    oldQuotaFee:     request.oldQuotaFee,
                    newQuotaFee:     request.newQuotaFee,
                    cancellationFee: request.cancellationFee,
                });

                for (const [key, label] of Object.entries(componentLabels)) {
                    const bd = ledgerAdjustment.componentBreakdown[key as keyof typeof ledgerAdjustment.componentBreakdown];
                    if (!bd) continue;

                    // DEBIT: deduction per component
                    if (bd.deducted > 0) {
                        await tx.studentLedger.create({
                            data: {
                                studentId:     request.studentId,
                                type:          'DEBIT' as any,
                                amount:        bd.deducted,
                                description:   `Cancellation Deduction - ${label} (${request.conditionType})`,
                                referenceId:   request.id,
                                referenceType: 'CANCELLATION',
                                academicYearId: ledgerYearId,
                                yearOfStudy:   studentCancellationYear,
                                createdBy:     adminId,
                                date:          now,
                            } as any,
                        });
                    }

                    // CREDIT: refund per component
                    if (bd.refund > 0) {
                        await tx.studentLedger.create({
                            data: {
                                studentId:     request.studentId,
                                type:          'CREDIT' as any,
                                amount:        bd.refund,
                                description:   `Refund - ${label} (${request.conditionType})`,
                                referenceId:   request.id,
                                referenceType: 'CANCELLATION',
                                academicYearId: ledgerYearId,
                                yearOfStudy:   studentCancellationYear,
                                createdBy:     adminId,
                                date:          now,
                            } as any,
                        });
                    }
                }

            } else {
                // ── REJECT (fresh or re-reject after approval) ─────────────────
                if (isReversal) {
                    // Restore admission back to ENROLLED with original course
                    await tx.studentAdmission.update({
                        where: { studentId: request.studentId },
                        data:  { status: AdmissionStatus.ENROLLED },
                    });

                    // Give back the seat (year-scoped via CourseCapacity)
                    if (request.student.admissionDetails?.allottedCourseId && request.student.admissionDetails.academicYearId) {
                        await incrementCourseCapacity(
                            tx,
                            request.student.admissionDetails.allottedCourseId,
                            request.student.admissionDetails.academicYearId,
                        );
                    }

                    // Restore payments back to SUCCESS
                    await tx.payment.updateMany({
                        where: {
                            studentId: request.studentId,
                            status: PaymentStatus.REFUNDED,
                            component: { not: PaymentComponent.APPLICATION_FEE },
                        },
                        data: { status: PaymentStatus.SUCCESS },
                    });

                    // Remove ledger entries that were created during approval
                    await (tx.studentLedger as any).deleteMany({
                        where: { referenceId: request.id, referenceType: 'CANCELLATION' },
                    });

                    // Reset all computed financial fields to 0
                    await (tx.cancellationRequest as any).update({
                        where: { id: requestId },
                        data: {
                            deductionAmount:  0,
                            refundAmount:     0,
                            transferAmount:   0,
                            balanceDue:       0,
                            finalStatus:      'NO_ACTION',
                            conditionRemarks: 'Reversed — cancellation rejected after prior approval.',
                        },
                    });
                }
            }
        });

        // Generate receipt PDF, upload to S3, email student on approval
        let generatedUrl: string | null = null;
        if (approved) {
            try {
                generatedUrl = await _generateCancellationReceipt(request, now);
                if (generatedUrl) {
                    await (prisma.cancellationRequest as any).update({
                        where: { id: requestId },
                        data:  { invoiceUrl: generatedUrl },
                    });
                    logger.info(`[approveCancellation] Receipt generated: ${generatedUrl}`);
                }
            } catch (e) {
                logger.error(`[approveCancellation] Receipt generation failed (non-fatal): ${e}`);
            }
        }

        const action = isReversal
            ? `Re-${approved ? 'approved' : 'rejected'} (was ${currentStatus})`
            : (approved ? 'Approved' : 'Rejected');
        logger.info(`[CancellationService.approveCancellation] RequestId=${requestId}, Action=${action}, AdminId=${adminId}`);

        const presignedUrl = generatedUrl ? await convertToPresignedUrl(generatedUrl) : null;
        return { status: newStatus, approvedAt: approved ? now : null, invoiceUrl: presignedUrl };
    },

    /** List cancellation requests with filters (status / dateRange / search). Powers the approval queue. */
    async listCancellationRequests(filters: {
        status?: CancellationStatus;
        conditionType?: string;
        applicationId?: string;
        page?: number;
        limit?: number;
    } = {}) {
        const page  = Math.max(1, filters.page  ?? 1);
        const limit = Math.min(100, filters.limit ?? 20);
        const skip  = (page - 1) * limit;

        const where: any = {};
        if (filters.status)        where.status        = filters.status;
        if (filters.conditionType) where.conditionType = filters.conditionType;
        if (filters.applicationId) {
            where.student = {
                applicationId: { contains: filters.applicationId, mode: 'insensitive' }
            };
        }

        const [data, total] = await Promise.all([
            prisma.cancellationRequest.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    student: {
                        select: { 
                            name: true, 
                            applicationId: true, 
                            phone: true, 
                            email: true,
                            degreeType: true,
                            admissionDetails: {
                                select: { 
                                    allottedCourseId: true,
                                    allottedCourse: { select: { name: true } }
                                }
                            }
                        },
                    },
                },
            }),
            prisma.cancellationRequest.count({ where }),
        ]);

        const mappedData = await Promise.all(data.map(async req => {
            const { admissionDetails, ...studentRest } = req.student;
            return {
                ...req,
                fileUrl: await convertToPresignedUrl(req.fileUrl),
                invoiceUrl: await convertToPresignedUrl(req.invoiceUrl),
                student: {
                    ...studentRest,
                    allottedCourseId: admissionDetails?.allottedCourseId || null,
                    allottedCourseName: admissionDetails?.allottedCourse?.name || null,
                }
            };
        }));

        return { data: mappedData, total, page, limit, totalPages: Math.ceil(total / limit) };
    },

    /** Fetch one cancellation request with full financial breakdown + student context. */
    async getCancellationById(id: string) {
        const request = await prisma.cancellationRequest.findUnique({
            where: { id },
            include: {
                student: {
                    select: { 
                        name: true, 
                        applicationId: true, 
                        phone: true, 
                        email: true,
                        degreeType: true,
                        admissionDetails: {
                            select: { 
                                allottedCourseId: true,
                                allottedCourse: { select: { name: true } }
                            }
                        }
                    },
                },
            },
        });
        if (!request) throw new AppError('Cancellation request not found', 404);

        const { admissionDetails, ...studentRest } = request.student;
        return {
            ...request,
            fileUrl: await convertToPresignedUrl(request.fileUrl),
            invoiceUrl: await convertToPresignedUrl(request.invoiceUrl),
            student: {
                ...studentRest,
                allottedCourseId: admissionDetails?.allottedCourseId || null,
                allottedCourseName: admissionDetails?.allottedCourse?.name || null,
            }
        };
    },

    /** Return a presigned URL for a cancellation's receipt PDF (regenerates if missing). */
    async getInvoiceUrl(id: string): Promise<string> {
        const request = await (prisma.cancellationRequest as any).findUnique({
            where:  { id },
            select: { id: true, invoiceUrl: true, status: true, student: { select: { email: true } } },
        });

        if (!request) throw new AppError('Cancellation request not found', 404);
        if (request.status !== CancellationStatus.APPROVED) {
            throw new AppError('Invoice is only available for approved cancellations', 400);
        }
        if (!request.invoiceUrl) {
            throw new AppError('Invoice not yet generated for this cancellation', 404);
        }

        const presigned = await convertToPresignedUrl(request.invoiceUrl);
        if (!presigned) throw new AppError('Could not generate download link', 500);
        return presigned;
    },
};
