import express from 'express';
import multer from 'multer';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import * as bulkImportController from './bulkImport.controller';

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.use(authenticate);

router.post(
    '/offline-students', 
    authorizePermission('admin.create'),
    upload.single('file'), 
    bulkImportController.importOfflineStudents
);

router.post(
    '/seat-booking-students',
    authorizePermission('admin.create'),
    upload.single('file'),
    bulkImportController.importSeatBookingStudents
);

router.post(
    '/verify-payment',
    authorizePermission('admin.update'),
    bulkImportController.verifyPayment
);

export default router;
