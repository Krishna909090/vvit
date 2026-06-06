import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
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

router.post(
    '/preview',
    authenticate,
    authorizePermission(['student.read.all']),
    validateRequest(previewAdjustmentSchema),
    previewAdjustment,
);

router.post(
    '/request',
    authenticate,
    authorizePermission(['student.update.all']),
    validateRequest(requestCancellationSchema),
    requestCancellation,
);

router.post(
    '/approve',
    authenticate,
    authorizePermission(['student.update.all']),
    validateRequest(approveCancellationSchema),
    approveCancellation,
);

router.get(
    '/list',
    authenticate,
    authorizePermission(['student.read.all']),
    listCancellationRequests,
);

router.get(
    '/:id/invoice',
    authenticate,
    authorizePermission(['student.read.all']),
    validateRequest(getCancellationByIdSchema),
    downloadCancellationInvoice,
);

router.get(
    '/:id',
    authenticate,
    authorizePermission(['student.read.all']),
    validateRequest(getCancellationByIdSchema),
    getCancellationById,
);

export default router;
