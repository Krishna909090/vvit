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
    uploadBulkResultsJSON,
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
router.post('/centers', authenticate, authorizePermission('exam.create.all'), validateRequest(createExamCenterSchema), createExamCenter);

router.post('/slots', authenticate, authorizePermission('exam.create.all'), validateRequest(createExamSlotSchema), createExamSlot);

router.put('/slots/:slotId/toggle-booking', authenticate, authorizePermission('exam.update.all'), toggleSlotBooking);


router.get('/centers', authenticate, authorizePermission('exam.read.all'), getExamCenters);

router.put('/centers/:id', authenticate, authorizePermission('exam.update.all'), updateExamCenter);

router.delete('/centers/:id', authenticate, authorizePermission('exam.delete.all'), deleteExamCenter);

// Exam Slots Admin CRUD

router.get('/students/status/:status', authenticate, authorizePermission('exam.read.all'), getStudentsByStatus);

router.get('/all-slots', authenticate, authorizePermission('exam.read.all'), getExamSlots);

router.get('/centers/:centerId/slots', authenticate, authorizePermission('exam.read.all'), getExamSlotsByCenter);

router.get('/slots/:id', authenticate, authorizePermission('exam.read.all'), getExamSlot);
router.put('/slots/:id', authenticate, authorizePermission('exam.update.all'), updateExamSlot);
router.delete('/slots/:id', authenticate, authorizePermission('exam.delete.all'), deleteExamSlot);


// Invigilator / Scanning Routes
router.post('/scan-qr', authenticate, authorizePermission('exam.update.all'), scanAttendance);
router.post('/verify-attendance', authenticate, authorizePermission('exam.update.all'), verifyAttendance);

// Student/Public Routes
router.get('/slots', authenticate, authorizePermission(['exam.read.all', 'exam.read.own']), getAvailableSlots);
router.post('/book-slot', authenticate, authorizePermission(['exam.create.own', 'exam.update.own']), bookExamSlot);


router.get('/hall-ticket/:studentId', authenticate, authorizePermission(['exam.read.own', 'exam.read.all']), getHallTicketDetails);

// Exam Results & Attendance (Admin)
router.post('/mark-attendance', authenticate, authorizePermission('exam.update.all'), markAttendance);
router.post('/results', authenticate, authorizePermission('exam.update.all'), updateExamScore);
router.post('/results/bulk', authenticate, authorizePermission('exam.update.all'), upload.single('file'), uploadBulkResults);
router.post('/bulk-results', authenticate, authorizePermission('exam.update.all'), uploadBulkResultsJSON);


export default router;

