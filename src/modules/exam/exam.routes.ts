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

// ═══════════════════════════════════════════════════════════
//  EXAM CENTER MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════

/**
 * POST /exam/centers
 * Creates a new exam center (venue) for conducting exams.
 * Side effects: Persists a new ExamCenter record in the database.
 * Body: { name, address, city, state, capacity, ... } (validated by createExamCenterSchema)
 * Response: { status, data: ExamCenter }
 */
router.post('/centers', authenticate, authorizePermission('exam.create.all'), validateRequest(createExamCenterSchema), createExamCenter);

/**
 * GET /exam/centers
 * Retrieves all exam centers along with their associated slots.
 * Params: none
 * Response: { status, data: ExamCenter[] }
 */
router.get('/centers', authenticate, authorizePermission('exam.read.all'), getExamCenters);

/**
 * PUT /exam/centers/:id
 * Updates an existing exam center's details (name, address, capacity, etc.).
 * Side effects: Modifies the ExamCenter record in-place.
 * Params: id - the exam center UUID
 * Body: Partial ExamCenter fields to update
 * Response: { status, data: ExamCenter }
 */
router.put('/centers/:id', authenticate, authorizePermission('exam.update.all'), updateExamCenter);

/**
 * DELETE /exam/centers/:id
 * Permanently deletes an exam center.
 * Side effects: Removes the ExamCenter record and may cascade to related slots.
 * Params: id - the exam center UUID
 * Response: { status, message }
 */
router.delete('/centers/:id', authenticate, authorizePermission('exam.delete.all'), deleteExamCenter);

// ═══════════════════════════════════════════════════════════
//  EXAM SLOT MANAGEMENT (Admin)
// ═══════════════════════════════════════════════════════════

/**
 * POST /exam/slots
 * Creates a new exam slot (date/time window) under an exam center.
 * Side effects: Persists a new ExamSlot record linked to a center.
 * Body: { centerId, date, startTime, endTime, capacity, ... } (validated by createExamSlotSchema)
 * Response: { status, data: ExamSlot }
 */
router.post('/slots', authenticate, authorizePermission('exam.create.all'), validateRequest(createExamSlotSchema), createExamSlot);

/**
 * PUT /exam/slots/:slotId/toggle-booking
 * Enables or disables student booking for a specific exam slot.
 * Side effects: Updates the isBookingEnabled flag on the ExamSlot.
 * Params: slotId - the exam slot UUID
 * Body: { isBookingEnabled: boolean }
 * Response: { status, data: ExamSlot }
 */
router.put('/slots/:slotId/toggle-booking', authenticate, authorizePermission('exam.update.all'), toggleSlotBooking);

/**
 * GET /exam/all-slots
 * Retrieves every exam slot across all centers for admin management.
 * Response: { status, data: ExamSlot[] }
 */
router.get('/all-slots', authenticate, authorizePermission('exam.read.all'), getExamSlots);

/**
 * GET /exam/centers/:centerId/slots
 * Retrieves all exam slots belonging to a specific exam center.
 * Params: centerId - the exam center UUID
 * Response: { status, data: ExamSlot[] }
 */
router.get('/centers/:centerId/slots', authenticate, authorizePermission('exam.read.all'), getExamSlotsByCenter);

/**
 * GET /exam/slots/:id
 * Retrieves a single exam slot by its ID, including center and booking details.
 * Params: id - the exam slot UUID
 * Response: { status, data: ExamSlot }
 */
router.get('/slots/:id', authenticate, authorizePermission('exam.read.all'), getExamSlot);

/**
 * PUT /exam/slots/:id
 * Updates an exam slot's timing, capacity, or other configuration.
 * Side effects: Modifies the ExamSlot record in-place.
 * Params: id - the exam slot UUID
 * Body: Partial ExamSlot fields to update
 * Response: { status, data: ExamSlot }
 */
router.put('/slots/:id', authenticate, authorizePermission('exam.update.all'), updateExamSlot);

/**
 * DELETE /exam/slots/:id
 * Deletes an exam slot. Fails if students have already booked the slot.
 * Side effects: Removes the ExamSlot record from the database.
 * Params: id - the exam slot UUID
 * Response: { status, message }
 */
router.delete('/slots/:id', authenticate, authorizePermission('exam.delete.all'), deleteExamSlot);

// ═══════════════════════════════════════════════════════════
//  STUDENT LOOKUP (Admin)
// ═══════════════════════════════════════════════════════════

/**
 * GET /exam/students/status/:status
 * Retrieves students filtered by their admission status (e.g., APPLIED, ADMITTED).
 * Validates the status against the AdmissionStatus enum; returns 400 if invalid.
 * Params: status - one of the AdmissionStatus enum values
 * Response: { status, data: Student[] }
 */
router.get('/students/status/:status', authenticate, authorizePermission('exam.read.all'), getStudentsByStatus);

// ═══════════════════════════════════════════════════════════
//  INVIGILATOR / QR SCANNING ROUTES (Admin)
// ═══════════════════════════════════════════════════════════

/**
 * POST /exam/scan-qr
 * Scans a student's QR code hash and returns their details for attendance validation.
 * Side effects: Creates a pending attendance record; writes an audit log entry.
 * Body: { qrHash: string }
 * Response: { status, data: { student, examDetails, attendanceRecordId } }
 */
router.post('/scan-qr', authenticate, authorizePermission('exam.update.all'), scanAttendance);

/**
 * POST /exam/verify-attendance
 * Confirms and finalises a student's attendance after QR scan validation.
 * Side effects: Marks the attendance record as verified; writes an audit log entry.
 * Body: { attendanceRecordId: string }
 * Response: { status, data: { studentId, studentName, applicationId, examCenter, verifiedAt } }
 */
router.post('/verify-attendance', authenticate, authorizePermission('exam.update.all'), verifyAttendance);

// ═══════════════════════════════════════════════════════════
//  STUDENT / PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * GET /exam/slots
 * Returns exam slots that are currently available for booking (future date,
 * booking enabled, and not yet at capacity).
 * Response: { status, data: ExamSlot[] }
 */
router.get('/slots', authenticate, authorizePermission(['exam.read.all', 'exam.read.own']), getAvailableSlots);

/**
 * POST /exam/book-slot
 * Books an available exam slot for the authenticated student (or a specified student if admin).
 * Side effects: Creates a slot booking record; increments the slot's booked count.
 * Body: { slotId: string, studentId?: string }
 * Response: { status, data: BookingResult }
 */
router.post('/book-slot', authenticate, authorizePermission(['exam.create.own', 'exam.update.own']), bookExamSlot);

/**
 * GET /exam/hall-ticket/:studentId
 * Retrieves hall-ticket details including QR code data for the given student.
 * Students can only access their own hall ticket; admins can access any.
 * Params: studentId - the student UUID
 * Response: { status, data: { student, examSlot, qrCode, ... } }
 */
router.get('/hall-ticket/:studentId', authenticate, authorizePermission(['exam.read.own', 'exam.read.all']), getHallTicketDetails);

// ═══════════════════════════════════════════════════════════
//  EXAM RESULTS & ATTENDANCE (Admin)
// ═══════════════════════════════════════════════════════════

/**
 * POST /exam/mark-attendance
 * Manually marks a student's exam attendance (admin override / backup method).
 * Side effects: Creates or updates the student's attendance record.
 * Body: { studentId: string, attended: boolean }
 * Response: { status, message }
 */
router.post('/mark-attendance', authenticate, authorizePermission('exam.update.all'), markAttendance);

/**
 * POST /exam/results
 * Updates the exam score for a single student and determines qualification status.
 * Side effects: Updates the student's exam score and qualification status.
 * Body: { studentId: string, score: number, cutoff: number }
 * Response: { status, data: UpdatedExamResult }
 */
router.post('/results', authenticate, authorizePermission('exam.update.all'), updateExamScore);

/**
 * POST /exam/results/bulk
 * Uploads exam results in bulk from a CSV file.
 * Side effects: Updates scores for matched students; deletes the temp file after processing.
 * Body: multipart/form-data with field "file" (CSV) and optional "cutoff" field
 * Response: { status, data: { summary: { total, successful, failed }, failedRecords, allResults } }
 */
router.post('/results/bulk', authenticate, authorizePermission('exam.update.all'), upload.single('file'), uploadBulkResults);

/**
 * POST /exam/bulk-results
 * Uploads exam scores in bulk from a JSON array.
 * Only updates students who have attended the exam (examAttended=true).
 * Also creates/updates VVITAT AcademicQualification record per student.
 * Body: { records: [{ applicationId, score, status: 'Q'|'NQ' }] }
 * Response: { status, data: { summary: { total, successful, failed }, failedRecords, successRecords } }
 */
router.post('/bulk-results', authenticate, authorizePermission('exam.update.all'), uploadBulkResultsJSON);


export default router;
