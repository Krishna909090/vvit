import express from 'express';
import multer from 'multer';
import { authenticate, authorize } from '../../middlewares/authMiddleware';
import * as bulkImportController from './bulkImport.controller';
import { Role } from '@prisma/client';

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.use(authenticate);
router.use(authorize([Role.ADMIN, Role.SUPER_ADMIN]));

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

export default router;
