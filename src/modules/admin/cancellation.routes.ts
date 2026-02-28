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

// Preview fee adjustment (no DB write)
router.post(
    '/preview',
    authenticate,
    authorizePermission(['student.read.all']),
    validateRequest(previewAdjustmentSchema),
    previewAdjustment,
);

// Create a cancellation request with computed adjustment
router.post(
    '/request',
    authenticate,
    authorizePermission(['student.update.all']),
    validateRequest(requestCancellationSchema),
    requestCancellation,
);

// Approve or reject a cancellation request
router.post(
    '/approve',
    authenticate,
    authorizePermission(['student.update.all']),
    validateRequest(approveCancellationSchema),
    approveCancellation,
);

// List all cancellation requests (?status=&conditionType=&page=&limit=)
router.get(
    '/list',
    authenticate,
    authorizePermission(['student.read.all']),
    listCancellationRequests,
);

// Download cancellation receipt PDF (presigned S3 URL)
router.get(
    '/:id/invoice',
    authenticate,
    authorizePermission(['student.read.all']),
    validateRequest(getCancellationByIdSchema),
    downloadCancellationInvoice,
);

// Get a single cancellation request by ID
router.get(
    '/:id',
    authenticate,
    authorizePermission(['student.read.all']),
    validateRequest(getCancellationByIdSchema),
    getCancellationById,
);

export default router;
