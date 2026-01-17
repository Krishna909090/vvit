import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

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
// Admin Routes
router.post('/centers', authenticate, authorizePermission('exam.create'), validateRequest(createExamCenterSchema), createExamCenter);

router.post('/slots', authenticate, authorizePermission('exam.create'), validateRequest(createExamSlotSchema), createExamSlot);

router.put('/slots/:slotId/toggle-booking', authenticate, authorizePermission('exam.update'), toggleSlotBooking);


router.get('/centers', authenticate, authorizePermission('exam.read'), getExamCenters);

router.put('/centers/:id', authenticate, authorizePermission('exam.update'), updateExamCenter);

router.delete('/centers/:id', authenticate, authorizePermission('exam.delete'), deleteExamCenter);

// Exam Slots Admin CRUD

router.get('/students/status/:status', authenticate, authorizePermission('exam.read'), getStudentsByStatus);

router.get('/all-slots', authenticate, authorizePermission('exam.read'), getExamSlots);

router.get('/centers/:centerId/slots', authenticate, authorizePermission('exam.read'), getExamSlotsByCenter);

router.get('/slots/:id', authenticate, authorizePermission('exam.read'), getExamSlot);
router.put('/slots/:id', authenticate, authorizePermission('exam.update'), updateExamSlot);
router.delete('/slots/:id', authenticate, authorizePermission('exam.delete'), deleteExamSlot);


// Invigilator / Scanning Routes - POST -> create (creates scan record/event)
router.post('/scan-qr', authenticate, authorizePermission('exam.create'), scanAttendance);
router.post('/verify-attendance', authenticate, authorizePermission('exam.create'), verifyAttendance);

// Student/Public Routes
router.get('/slots', authenticate, authorizePermission('exam.read'), getAvailableSlots);
router.post('/book-slot', authenticate, authorizePermission('exam.create'), bookExamSlot); // Booking creates a reservation


router.get('/hall-ticket/:studentId', authenticate, authorizePermission('exam.read'), getHallTicketDetails);

// Exam Results & Attendance (Admin)
router.post('/mark-attendance', authenticate, authorizePermission('exam.create'), markAttendance);
router.post('/results', authenticate, authorizePermission('exam.update'), updateExamScore); // Updates result/score
router.post('/results/bulk', authenticate, authorizePermission('exam.create'), upload.single('file'), uploadBulkResults); // Import creates results


export default router;

