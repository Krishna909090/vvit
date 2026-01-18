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
router.post('/centers', authenticate, authorizePermission('exam.center.manage'), validateRequest(createExamCenterSchema), createExamCenter);

router.post('/slots', authenticate, authorizePermission('exam.slot.manage'), validateRequest(createExamSlotSchema), createExamSlot);

router.put('/slots/:slotId/toggle-booking', authenticate, authorizePermission('exam.slot.manage'), toggleSlotBooking);


router.get('/centers', authenticate, authorizePermission('exam.view.all'), getExamCenters);

router.put('/centers/:id', authenticate, authorizePermission('exam.center.manage'), updateExamCenter);

router.delete('/centers/:id', authenticate, authorizePermission('exam.center.manage'), deleteExamCenter);

// Exam Slots Admin CRUD

router.get('/students/status/:status', authenticate, authorizePermission('exam.view.all'), getStudentsByStatus);

router.get('/all-slots', authenticate, authorizePermission('exam.view.all'), getExamSlots);

router.get('/centers/:centerId/slots', authenticate, authorizePermission('exam.view.all'), getExamSlotsByCenter);

router.get('/slots/:id', authenticate, authorizePermission('exam.view.all'), getExamSlot);
router.put('/slots/:id', authenticate, authorizePermission('exam.slot.manage'), updateExamSlot);
router.delete('/slots/:id', authenticate, authorizePermission('exam.slot.manage'), deleteExamSlot);


// Invigilator / Scanning Routes
router.post('/scan-qr', authenticate, authorizePermission('exam.attendance.scan'), scanAttendance);
router.post('/verify-attendance', authenticate, authorizePermission('exam.attendance.scan'), verifyAttendance);

// Student/Public Routes
router.get('/slots', authenticate, getAvailableSlots);
router.post('/book-slot', authenticate, bookExamSlot);


router.get('/hall-ticket/:studentId', authenticate, getHallTicketDetails);

// Exam Results & Attendance (Admin)
router.post('/mark-attendance', authenticate, authorizePermission('exam.attendance.scan'), markAttendance);
router.post('/results', authenticate, authorizePermission('exam.result.update'), updateExamScore);
router.post('/results/bulk', authenticate, authorizePermission('exam.result.update'), upload.single('file'), uploadBulkResults);


export default router;

