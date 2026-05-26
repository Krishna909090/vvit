import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import {
    createFeeHead, getFeeHeads, updateFeeHead, deleteFeeHead,
    createFeeStructure, createBulkFeeStructure, bulkHeadsFeeStructure, cloneFeeStructures, getFeeStructures, updateFeeStructure, deleteFeeStructure,
    getFeeStatistics,
    createDiscountRequest, updateDiscountRequest, deleteDiscountRequest, approveDiscount,
    getApplicationFee, updateApplicationFee,
    collectFee, getStudentLedger, downloadAllotmentOrder, generateFeeDemands, generateFeeDemandsBulk, getStudentFeeDemands, getPaymentHistory,
    addStudentDiscount,
    getDiscountRequests,
    getCourseFeeHeads,
    changeAccommodationType,
    getFeeCorrections,
    applyFeeCorrection,
    getCancellationMetrics
} from './fee.controller';

import {
    createFeeHeadSchema, updateFeeHeadSchema, createFeeStructureSchema, createBulkFeeStructureSchema,
    bulkHeadsFeeStructureSchema,
    cloneFeeStructuresSchema,
    createDiscountRequestSchema, updateDiscountRequestSchema, approveDiscountSchema, generateFeeDemandsSchema,
    generateFeeDemandsBulkSchema, applyFeeCorrectionSchema
} from '../../validators/adminValidators';
import {
    setApplicationFeeSchema, collectFeeSchema, addStudentDiscountSchema, changeAccommodationSchema
} from '../../validators/paymentValidators';

const router = Router();

// ═══════════════════════════════════════════════════════════
// FEE HEADS (Categories like Tuition, Hostel, Transport, Lab, etc.)
// ═══════════════════════════════════════════════════════════

/**
 * POST /finance/fees/fee-head
 * Creates a new fee head (category). Fee heads define what types of fees can be charged.
 * Examples: Tuition Fee, Hostel Accommodation, Transport, Lab Fee, Book Bank.
 * Fee heads are linked to courses and used in fee structures.
 * Body: { name, description?, courseId? }
 * Response: { status, data: { id, name } }
 */
router.post('/fee-head', authenticate, authorizePermission('finance.create.all'), validateRequest(createFeeHeadSchema), createFeeHead);

/**
 * GET /finance/fees/fee-head
 * Returns all fee heads. Used in dropdowns when creating fee structures or recording payments.
 * Response: { status, data: [{ id, name, description, courseId }] }
 */
router.get('/fee-head', authenticate, authorizePermission('finance.read.all'), getFeeHeads);

/**
 * PUT /finance/fees/fee-head/:id
 * Updates a fee head's name or description.
 * Params: { id }
 * Body: { name?, description? }
 */
router.put('/fee-head/:id', authenticate, authorizePermission('finance.update.all'), validateRequest(updateFeeHeadSchema), updateFeeHead);

/**
 * DELETE /finance/fees/fee-head/:id
 * Deletes a fee head. Fails if fee structures or payments reference it.
 * Params: { id }
 */
router.delete('/fee-head/:id', authenticate, authorizePermission('finance.delete.all'), deleteFeeHead);

/**
 * GET /finance/fees/course-fee-heads/:courseId
 * Returns fee heads applicable to a specific course.
 * Used when admin selects a course to see which fees can be charged.
 * Params: { courseId }
 * Response: { status, data: [{ id, name }] }
 */
router.get('/course-fee-heads/:courseId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getCourseFeeHeads);

// ═══════════════════════════════════════════════════════════
// FEE STRUCTURES (Amount mapping: course + year + quota → fee amount)
// ═══════════════════════════════════════════════════════════

/**
 * POST /finance/fees/fee-structure/bulk
 * Creates multiple fee structures in one request.
 * A fee structure defines: "For course X, year Y, quota Z, the tuition fee is ₹50,000".
 * Body: { structures: [{ courseId, feeHeadId, amount, academicYearId, yearOfStudy?, quotaType?, courseType? }] }
 * Response: { status, message, count }
 */
router.post('/fee-structure/bulk', authenticate, authorizePermission('finance.create.all'), validateRequest(createBulkFeeStructureSchema), createBulkFeeStructure);

/**
 * POST /finance/fees/fee-structure/bulk-heads
 * Creates many fee structures in one call — same (course, year, entryType, quota, ...)
 * combination, multiple fee heads each with their own amount.
 * Body: {
 *   courseId, academicYearId, entryAcademicYearId?, entryType?, instituteCode?, quotaType?, yearOfStudy?,
 *   feeHeads: [ { feeHeadId, amount }, ... ]
 * }
 * Response: { status, message, data: { createdCount, skippedCount, created, skipped } }
 */
router.post('/fee-structure/bulk-heads',
    authenticate,
    authorizePermission('finance.create.all'),
    validateRequest(bulkHeadsFeeStructureSchema),
    bulkHeadsFeeStructure,
);

/**
 * POST /finance/fees/fee-structure
 * Creates a single fee structure entry.
 * Body: { courseId, feeHeadId, amount, academicYearId, yearOfStudy?, quotaType?, courseType? }
 * Response: { status, data: { id } }
 */
router.post('/fee-structure', authenticate, authorizePermission('finance.create.all'), validateRequest(createFeeStructureSchema), createFeeStructure);

/**
 * POST /finance/fees/fee-structure/clone-academic-year
 * Clone all (non-deleted) fee structures from one academic year to another.
 * Used to seed a NEW academic year (clone prior year, then edit), or to BACK-FILL
 * a past year for lateral / back-dated admissions so generateFeeDemands has rows
 * to seed against.
 * Body: { sourceAcademicYearId, targetAcademicYearId, multiplier?, courseIds? }
 * Response: { status, data: { cloned, skipped, total, source, target, multiplier? } }
 */
router.post('/fee-structure/clone-academic-year',
    authenticate,
    authorizePermission('finance.create.all'),
    validateRequest(cloneFeeStructuresSchema),
    cloneFeeStructures
);

/**
 * GET /finance/fees/fee-structure
 * Returns all fee structures with course, fee head, and academic year details.
 * Query: { courseId?, academicYearId?, yearOfStudy? }
 * Response: { status, data: [{ id, course, feeHead, amount, yearOfStudy, quotaType }] }
 */
router.get('/fee-structure', authenticate, authorizePermission('finance.read.all'), getFeeStructures);

/**
 * GET /finance/fees/fee-corrections (also mounted at /admin/fee/fee-corrections)
 * Lists fee corrections (credits/refunds) with filters + pagination. Each row includes
 * `applied` and `remaining` so the UI knows how much credit is left to transfer.
 * Query: { studentId?, academicYearId?, type?, isSettled?, carryForward?, referenceType?, applicationId?, page?, limit? }
 */
router.get('/fee-corrections', authenticate, authorizePermission('finance.read.all'), getFeeCorrections);

/**
 * GET /finance/fees/cancellation-metrics (also at /admin/fee/cancellation-metrics)
 * Revenue retained (kept) vs refunded across cancellations/switches, split by accommodation
 * (hostel/transport) and by referenceType. Query: { academicYearId?, from?, to?, referenceType? }
 */
router.get('/cancellation-metrics', authenticate, authorizePermission('finance.read.all'), getCancellationMetrics);

/**
 * POST /finance/fees/fee-corrections/:id/apply (also at /admin/fee/fee-corrections/:id/apply)
 * Transfer (apply) part or all of a correction's remaining credit onto a specific fee demand.
 * Body: { feeDemandId, amount, remarks? }. Records a tagged transfer Payment (excluded from
 * paidFee), transitions the demand status, and marks the correction settled when fully consumed.
 */
router.post('/fee-corrections/:id/apply', authenticate, authorizePermission('finance.update.all'), validateRequest(applyFeeCorrectionSchema), applyFeeCorrection);

/**
 * PUT /finance/fees/fee-structure/:id
 * Updates a fee structure's amount or configuration.
 * Params: { id }
 * Body: { amount?, yearOfStudy?, quotaType? }
 */
router.put('/fee-structure/:id', authenticate, authorizePermission('finance.update.all'), updateFeeStructure);

/**
 * DELETE /finance/fees/fee-structure/:id
 * Deletes a fee structure. Does not affect already-generated fee demands.
 * Params: { id }
 */
router.delete('/fee-structure/:id', authenticate, authorizePermission('finance.delete.all'), deleteFeeStructure);

// ═══════════════════════════════════════════════════════════
// FEE DEMAND GENERATION
// ═══════════════════════════════════════════════════════════

/**
 * POST /finance/fees/generate-demands
 * Generates fee demands for a single student based on their course, year, quota, and academic year.
 * Looks up applicable fee structures via admission cohort tags (entryAcademicYearId/entryType/instituteCode),
 * applies scholarship discounts (only when isEligible='YES' AND FeeHead.component='TUITION'),
 * and skips fee heads where a demand already exists (idempotent).
 * Body: {
 *   studentId, courseId, academicYearId,
 *   deleteExisting?:      boolean (default false — wipes & re-seeds this course/year),
 *   allowLegacyFallback?: boolean (default true  — falls back to NULL-tagged structures when strict pass returns 0),
 *   requireEnrollment?:   boolean (default false — when true, errors if student isn't enrolled in that year),
 *   dueDateFallbackDays?: number  (default 30   — days past AcademicYear.startDate for dueDate)
 * }
 * Response: { status, message, data: { generated, skipped, considered, fallbackUsed, scholarshipApplied, structuresStrict, structuresFallback, demands } }
 */
router.post('/generate-demands', authenticate, authorizePermission('finance.create.all'), validateRequest(generateFeeDemandsSchema), generateFeeDemands);

/**
 * POST /finance/fees/generate-demands-bulk
 * Generates fee demands for EVERY active enrollment in the target academic year that
 * matches the cohort filter. Designed for end-of-year promotion runs covering freshers
 * + seniors + laterals in one operation. Strict by default (allowLegacyFallback=false,
 * requireEnrollment=true) — flip the flags in runOptions for legacy semantics.
 * Body: {
 *   academicYearId,
 *   filters?: { courseIds?, entryTypes?, instituteCodes?, entryAcademicYearIds?, quotaTypes?, studentIds? },
 *   runOptions?: { allowLegacyFallback?, requireEnrollment?, deleteExisting?, dueDateFallbackDays? }
 * }
 * Response: { status, data: { summary: { studentsProcessed, studentsOk, studentsFailed, demandsGenerated, demandsSkipped, fallbackHits, scholarshipsApplied }, perStudent: [...] } }
 */
router.post('/generate-demands-bulk', authenticate, authorizePermission('finance.create.all'), validateRequest(generateFeeDemandsBulkSchema), generateFeeDemandsBulk);

// ═══════════════════════════════════════════════════════════
// FEE STATISTICS & REPORTS
// ═══════════════════════════════════════════════════════════

/**
 * GET /finance/fees/fee-stats
 * Returns aggregated fee statistics for the admin dashboard.
 * Includes: total collected, pending, overdue, by component, by payment method.
 * Query: { academicYearId?, courseId? }
 * Response: { status, data: { totalCollected, totalPending, byComponent: {}, byMethod: {} } }
 */
router.get('/fee-stats', authenticate, authorizePermission('finance.read.all'), getFeeStatistics);

// ═══════════════════════════════════════════════════════════
// DISCOUNT REQUESTS (Approval workflow)
// ═══════════════════════════════════════════════════════════

/**
 * GET /finance/fees/discounts
 * Returns all discount requests with their approval status.
 * Query: { status?: 'PENDING' | 'APPROVED' | 'REJECTED' }
 * Response: { status, data: [{ id, studentId, amount, reason, status, approvedBy?, createdAt }] }
 */
router.get('/discounts', authenticate, authorizePermission('finance.read.all'), getDiscountRequests);

/**
 * POST /finance/fees/create-discount
 * Creates a new discount request for a student's fee demand.
 * Requires approval from super admin before it takes effect.
 * Body: { studentId, amount, reason, feeHeadId?, feeDemandId? }
 * Response: { status, data: { requestId } }
 */
router.post('/create-discount', authenticate, authorizePermission(['finance.create.all', 'finance.create.own']), validateRequest(createDiscountRequestSchema), createDiscountRequest);

/**
 * PUT /finance/fees/update-discount/:id
 * Updates a pending discount request (amount, reason).
 * Can only be updated while status is PENDING.
 * Params: { id }
 * Body: { amount?, reason? }
 */
router.put('/update-discount/:id', authenticate, authorizePermission(['finance.update.all', 'finance.update.own']), validateRequest(updateDiscountRequestSchema), updateDiscountRequest);

/**
 * DELETE /finance/fees/delete-discount/:id
 * Deletes a pending discount request.
 * Params: { id }
 */
router.delete('/delete-discount/:id', authenticate, authorizePermission(['finance.delete.all', 'finance.delete.own']), deleteDiscountRequest);

/**
 * POST /finance/fees/approve-discount
 * Approves a discount request. Updates the fee demand with the discount amount.
 * Creates a CREDIT ledger entry for the discount.
 * Body: { requestId, approvedAmount?, remarks? }
 * Response: { status, message }
 */
router.post('/approve-discount', authenticate, authorizePermission('finance.update.all'), validateRequest(approveDiscountSchema), approveDiscount);

// ═══════════════════════════════════════════════════════════
// APPLICATION FEE CONFIGURATION
// ═══════════════════════════════════════════════════════════

/**
 * GET /finance/fees/application-fee
 * Returns the current application/entrance fee amount (stored in SystemSetting).
 * Response: { status, data: { amount: number } }
 */
router.get('/application-fee', authenticate, authorizePermission('finance.read.all'), getApplicationFee);

/**
 * POST /finance/fees/application-fee
 * Updates the application/entrance fee amount in SystemSetting.
 * Body: { amount: number }
 * Response: { status, message }
 */
router.post('/application-fee', authenticate, authorizePermission('finance.update.all'), validateRequest(setApplicationFeeSchema), updateApplicationFee);

// ═══════════════════════════════════════════════════════════
// DIRECT FEE COLLECTION (Admin offline entry)
// ═══════════════════════════════════════════════════════════

/**
 * POST /finance/fees/collect-fee
 * Admin records an offline fee payment directly.
 * Creates payment record, generates invoice, settles fee demand, creates ledger entry.
 * Body: { studentId, amount, component, method, referenceNumber?, remarks?, feeHeadId? }
 * Response: { status, data: { paymentId, invoiceUrl } }
 */
router.post('/collect-fee', authenticate, authorizePermission('finance.create.all'), validateRequest(collectFeeSchema), collectFee);

// ═══════════════════════════════════════════════════════════
// STUDENT FINANCIAL DATA
// ═══════════════════════════════════════════════════════════

/**
 * GET /finance/fees/ledger/:studentId
 * Returns the student's complete financial ledger.
 * Shows all CREDIT (payments, discounts) and DEBIT (fee demands, fines) entries chronologically.
 * Includes running balance calculation.
 * Params: { studentId }
 * Response: { status, data: [{ id, type, amount, description, referenceId, date, runningBalance }] }
 */
router.get('/ledger/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getStudentLedger);

/**
 * GET /finance/fees/student-demands/:studentId
 * Returns all fee demands for a student with payment status.
 * Shows: fee head, demanded amount, paid amount, pending amount, due date, status.
 * Params: { studentId }
 * Response: { status, data: [{ id, feeHead, amount, paidAmount, pendingAmount, status, dueDate }] }
 */
router.get('/student-demands/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getStudentFeeDemands);

/**
 * GET /finance/fees/allotment-order/:studentId
 * Downloads the student's allotment order PDF (seat allotment + fee breakdown).
 * Returns presigned S3 URL. Generates the PDF if it doesn't exist yet.
 * Params: { studentId }
 * Response: { status, data: { url (presigned S3 URL) } }
 */
router.get('/allotment-order/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), downloadAllotmentOrder);

/**
 * POST /finance/fees/student-discount
 * Directly applies a discount or fine to a student's fee demand (no approval workflow).
 * Used for admin-level adjustments. Creates a ledger entry.
 * Body: { studentId, feeDemandId, type: 'DISCOUNT' | 'FINE', amount, reason }
 * Response: { status, message }
 */
router.post('/student-discount', authenticate, authorizePermission('finance.create.all'), validateRequest(addStudentDiscountSchema), addStudentDiscount);

/**
 * GET /finance/fees/payment-history/:studentId
 * Returns detailed payment history for a student.
 * Includes all successful and failed payments with method, date, invoice links.
 * Params: { studentId }
 * Response: { status, data: [{ id, amount, method, component, status, invoiceUrl, createdAt }] }
 */
router.get('/payment-history/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getPaymentHistory);

/**
 * POST /finance/fees/change-accommodation
 * Changes a student's accommodation type (Transport → Hostel, Hostel → Transport, any → None).
 * Releases old allocation, assigns new, adjusts fees, creates ledger entries.
 * Body: { studentId, newType: 'HOSTEL'|'TRANSPORT'|'NONE', hostelId?, hostelType?, transportRouteId?, reason? }
 * Response: { status, data: { oldType, newType, oldCost, newCost, feeAdjustment } }
 */
router.post('/change-accommodation', authenticate, authorizePermission('finance.update.all'), validateRequest(changeAccommodationSchema), changeAccommodationType);

export default router;
