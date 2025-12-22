import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createExamCenter,
    getExamCenters,
    updateExamCenter,
    deleteExamCenter,
    createExamSlot,
    getExamSlots,
    getExamSlot,
    updateExamSlot,
    deleteExamSlot,
    getAvailableSlots,
    toggleSlotBooking,
    getExamSlotsByCenter,
    getStudentsByStatus,
    getHallTicketDetails,
    bookExamSlot,
    markAttendance,
    updateExamScore,
    uploadBulkResults,
    scanAttendance,
    verifyAttendance
} from './exam.controller';
import upload from '../../config/multer';
import {
    createExamCenterSchema,
    createExamSlotSchema,
} from '../../validators/examValidators';

const router = Router();

// Admin Routes
router.post('/centers', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createExamCenterSchema), createExamCenter);

router.post('/slots', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createExamSlotSchema), createExamSlot);

router.put('/slots/:slotId/toggle-booking', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), toggleSlotBooking);


router.get('/centers', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getExamCenters);

router.put('/centers/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateExamCenter);

router.delete('/centers/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteExamCenter);

// Exam Slots Admin CRUD

router.get('/students/status/:status', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getStudentsByStatus);

router.get('/all-slots', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getExamSlots);

router.get('/centers/:centerId/slots', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getExamSlotsByCenter);

router.get('/slots/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getExamSlot);
router.put('/slots/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateExamSlot);
router.delete('/slots/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteExamSlot);


// Invigilator / Scanning Routes
router.post('/scan-qr', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.INVIGILATOR]), scanAttendance);
router.post('/verify-attendance', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.INVIGILATOR]), verifyAttendance);

// Student/Public Routes
router.get('/slots', authenticate, getAvailableSlots);
router.post('/book-slot', authenticate, bookExamSlot);


router.get('/hall-ticket/:studentId', authenticate, getHallTicketDetails);

// Exam Results & Attendance (Admin)
router.post('/mark-attendance', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), markAttendance);
router.post('/results', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateExamScore);
router.post('/results/bulk', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), upload.single('file'), uploadBulkResults);


export default router;

