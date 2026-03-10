import express from 'express';
import multer from 'multer';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import * as bulkImportController from './bulkImport.controller';

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

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

export default router;
