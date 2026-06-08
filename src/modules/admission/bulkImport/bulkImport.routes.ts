import express from 'express';
import multer from 'multer';
import { authenticate, authorizePermission } from '../../../middleware/rbac.middleware';
import * as bulkImportController from './bulkImport.controller';

const router = express.Router();
const storage = multer.memoryStorage();

const fileFilter = (
    _req: express.Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback
) => {
    const allowedExtensions = /\.(xlsx|xls|csv)$/i;
    const allowedMimeTypes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv',
        'application/csv',
    ];
    const extOk = allowedExtensions.test(file.originalname);
    const mimeOk = allowedMimeTypes.includes(file.mimetype);
    if (extOk && mimeOk) {
        cb(null, true);
    } else {
        cb(new Error('Only .xlsx, .xls, and .csv files are allowed'));
    }
};

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter,
});

router.use(authenticate);
router.use(authorizePermission('admin.create.all'));

router.post(
    '/offline-students',
    upload.single('file'),
    bulkImportController.importOfflineStudents
);

router.post(
    '/seat-booking-students',
    upload.single('file'),
    bulkImportController.importSeatBookingStudents
);

router.post(
    '/verify-payment',
    bulkImportController.verifyPayment
);

router.post(
    '/offline-applications/validate',
    bulkImportController.validateOfflineApplications
);

router.post(
    '/offline-applications',
    bulkImportController.importOfflineApplications
);

router.post(
    '/manual-entry/validate',
    authorizePermission(['student.create.lateral']),
    bulkImportController.validateBulkManualEntry
);

router.post(
    '/manual-entry',
    authorizePermission(['student.create.lateral']),
    bulkImportController.importBulkManualEntry
);

router.get(
    '/manual-entry/template',
    bulkImportController.downloadManualEntryTemplate
);

export default router;
