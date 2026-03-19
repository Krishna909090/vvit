import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    previewAdjustment,
    requestCancellation,
    approveCancellation,
    listCancellationRequests,
    downloadCancellationInvoice,
    getCancellationById,
} from './cancellation.controller';
import {
    previewAdjustmentSchema,
    requestCancellationSchema,
    approveCancellationSchema,
    getCancellationByIdSchema,
} from '../../validators/cancellationValidators';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  CANCELLATION — PREVIEW & REQUEST
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /preview
 * @desc    Preview the fee adjustment that would result from a cancellation, without persisting anything.
 *          Useful for showing the student/admin what the refund or deduction looks like before committing.
 * @access  Requires `student.read.all` permission.
 * @body    { studentId, conditionType, ... } — validated against previewAdjustmentSchema.
 * @returns {{ success: boolean, data: { originalFee, deduction, refundAmount, breakdown } }}
 */
router.post(
    '/preview',
    authenticate,
    authorizePermission(['student.read.all']),
    validateRequest(previewAdjustmentSchema),
    previewAdjustment,
);

/**
 * @route   POST /request
 * @desc    Create a new cancellation request with the computed fee adjustment.
 * @access  Requires `student.update.all` permission.
 * @body    { studentId, conditionType, reason, ... } — validated against requestCancellationSchema.
 * @sideEffect Creates a pending CancellationRequest record in the database.
 * @returns {{ success: boolean, data: CancellationRequest }} The newly created cancellation request.
 */
router.post(
    '/request',
    authenticate,
    authorizePermission(['student.update.all']),
    validateRequest(requestCancellationSchema),
    requestCancellation,
);

// ═══════════════════════════════════════════════════════════
//  CANCELLATION — APPROVAL
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /approve
 * @desc    Approve or reject an existing cancellation request.
 * @access  Requires `student.update.all` permission.
 * @body    { cancellationId, action: "approve" | "reject", remarks?, ... } — validated against approveCancellationSchema.
 * @sideEffect Updates the request status; on approval, may trigger refund processing and invoice generation.
 * @returns {{ success: boolean, data: CancellationRequest }} The updated cancellation request.
 */
router.post(
    '/approve',
    authenticate,
    authorizePermission(['student.update.all']),
    validateRequest(approveCancellationSchema),
    approveCancellation,
);

// ═══════════════════════════════════════════════════════════
//  CANCELLATION — LIST & DETAIL
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /list
 * @desc    List all cancellation requests with optional filtering and pagination.
 * @access  Requires `student.read.all` permission.
 * @query   { status?, conditionType?, page?, limit? }
 * @returns {{ success: boolean, data: CancellationRequest[], meta: { total, page, limit } }}
 */
router.get(
    '/list',
    authenticate,
    authorizePermission(['student.read.all']),
    listCancellationRequests,
);

/**
 * @route   GET /:id/invoice
 * @desc    Download the cancellation receipt/invoice PDF via a presigned S3 URL.
 * @access  Requires `student.read.all` permission.
 * @param   {string} id — The cancellation request ID — validated against getCancellationByIdSchema.
 * @returns {{ success: boolean, data: { url: string } }} Presigned download URL for the invoice PDF.
 */
router.get(
    '/:id/invoice',
    authenticate,
    authorizePermission(['student.read.all']),
    validateRequest(getCancellationByIdSchema),
    downloadCancellationInvoice,
);

/**
 * @route   GET /:id
 * @desc    Retrieve a single cancellation request by its ID, including fee adjustment details.
 * @access  Requires `student.read.all` permission.
 * @param   {string} id — The cancellation request ID — validated against getCancellationByIdSchema.
 * @returns {{ success: boolean, data: CancellationRequest }} The full cancellation request record.
 */
router.get(
    '/:id',
    authenticate,
    authorizePermission(['student.read.all']),
    validateRequest(getCancellationByIdSchema),
    getCancellationById,
);

export default router;
