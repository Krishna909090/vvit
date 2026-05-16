import { Router } from 'express';
import {
    registerStudent,
    getHallTicket,
    getHallTicketByAppId,
    uploadDocumentsAndPreferences,
    getStudentDetails,
    addAcademicDetails,
    selectExam,
    updatePersonalDetails,
    getApplicationSummary,
    requestServiceChange,
    updateProfilePhoto,
    requestCourseChange,
    reUploadDocument
} from './student.controller';
import { changeCourseSchema } from '../../validators/adminValidators';
import {
    payTestFee,
    payCollegeFee,
    payTokenFee,
    requestDiscount
} from '../finance/payment.controller';

import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import {
    registerStudentSchema,
    studentIdParamSchema,
    uploadDocumentsAndPreferencesSchema,
    addAcademicDetailsSchema,
    selectExamSchema,
    updatePersonalDetailsSchema
} from '../../validators/studentValidators';
import { getAvailableSlots } from '../exam/exam.controller';
import { getMyRequirements, deleteStudentDocument } from '../document/document.controller';

const router = Router();

// ═══════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════

/**
 * POST /student/register
 * Registers a new student application. Creates Student record with personal details,
 * course preferences (pref1, pref2, pref3), and links to the authenticated User.
 * Auto-generates applicationId (VON-series for online, VOF-series for offline).
 * Sets initial admission status to REGISTERED.
 * Body: { name, phone, email, gender, dob, fatherName, motherName, aadharNumber, address, city, state, pincode, degreeType, pref1?, pref2?, pref3? }
 * Response: { status, data: { studentId, applicationId } }
 */
router.post('/register', authenticate, authorizePermission(['student.create.own', 'student.create.all']), validateRequest(registerStudentSchema), registerStudent);

// ═══════════════════════════════════════════════════════════
// PAYMENTS (Student-initiated)
// ═══════════════════════════════════════════════════════════

/**
 * POST /student/:studentId/pay-test-fee
 * Initiates entrance/application fee payment (₹500) via PhonePe.
 * Creates a PENDING payment record, calls PhonePe SDK, returns redirect URL.
 * If a fresh PENDING payment exists (< 20 min), reuses the same transaction.
 * Stale PENDING payments (> 20 min) are marked FAILED and a new one is created.
 * On PhonePe success callback, admission status updates to ENTRANCE_FEE_PAID.
 * Params: { studentId }
 * Response: { status, data: { redirectUrl, paymentId } }
 */
router.post('/:studentId/pay-test-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payTestFee);

/**
 * POST /student/:studentId/pay-token-fee
 * Initiates scholarship token / admission fee payment via PhonePe.
 * Amount is determined by the student's fee structure and scholarship allocation.
 * Creates PENDING payment → PhonePe redirect → callback updates status.
 * On success: admission status → ADMISSION_CONFIRMED, allotment order generated.
 * Params: { studentId }
 * Response: { status, data: { redirectUrl, paymentId } }
 */
router.post('/:studentId/pay-token-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payTokenFee);

/**
 * POST /student/:studentId/pay-college-fee
 * Initiates college fee payment (tuition, hostel, transport bundle) via PhonePe.
 * Can include multiple fee components in a single transaction.
 * On success: generates invoice, creates ledger entries, settles fee demands.
 * Params: { studentId }
 * Body: { hostelSelection?, transportSelection?, paymentDetails: { amount } }
 * Response: { status, data: { redirectUrl, paymentId } }
 */
router.post('/:studentId/pay-college-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payCollegeFee);

// ═══════════════════════════════════════════════════════════
// EXAM & HALL TICKET
// ═══════════════════════════════════════════════════════════

/**
 * GET /student/:studentId/hall-ticket
 * Generates and returns the student's hall ticket PDF.
 * If hall ticket doesn't exist, generates it (PDF with QR code, student photo, exam details).
 * Uploads to S3 and saves URL in HallTicket table.
 * Returns a presigned S3 URL for download (valid 1 hour).
 * Params: { studentId }
 * Response: { status, data: { hallTicketUrl, hallTicketNumber, qrHash } }
 */
router.get('/:studentId/hall-ticket', authenticate, authorizePermission(['student.read.own', 'student.read.all']), validateRequest(studentIdParamSchema), getHallTicket);

/**
 * GET /student/hall-ticket/application/:applicationId
 * Same as above but looks up student by applicationId instead of studentId.
 * Useful when admin searches by application number.
 * Params: { applicationId }
 * Response: { status, data: { hallTicketUrl, hallTicketNumber, qrHash } }
 */
router.get('/hall-ticket/application/:applicationId', authenticate, authorizePermission(['student.read.own', 'student.read.all']), getHallTicketByAppId);

/**
 * POST /student/:studentId/select-exam
 * Books an exam slot for the student. Updates StudentExam with test date/center.
 * Validates: slot exists, has capacity, booking is enabled, student hasn't already booked.
 * Increments slot's filled count. Sets admission status to EXAM_SCHEDULED.
 * Params: { studentId }
 * Body: { examSlotId }
 * Response: { status, message, data: { testDate, testCenter } }
 */
router.post('/:studentId/select-exam', authenticate, authorizePermission(['student.update.own', 'student.update.all', 'exam.update.own', 'exam.update.all']), validateRequest(selectExamSchema), selectExam);

/**
 * GET /student/exam-slots
 * Returns all available exam slots with center details, date, time, and remaining capacity.
 * Only returns slots where isBookingEnabled=true and filled < capacity.
 * Response: { status, data: [{ id, examCenter, date, startTime, endTime, capacity, filled }] }
 */
router.get('/exam-slots', authenticate, authorizePermission(['exam.read.own', 'exam.read.all']), getAvailableSlots);

// ═══════════════════════════════════════════════════════════
// DOCUMENTS & ACADEMIC DETAILS
// ═══════════════════════════════════════════════════════════

/**
 * POST /student/:studentId/upload-docs
 * Uploads student documents (Aadhaar, 10th marks, 12th marks, photo, etc.)
 * and updates course preferences. Documents are stored in S3.
 * Creates/updates StudentDocument records with document URL and PENDING verification status.
 * Also updates student's course preferences (pref1, pref2, pref3) if provided.
 * Sets admission status to DOCUMENTS_SUBMITTED.
 * Params: { studentId }
 * Body: { documents: [{ documentKey, url }], pref1?, pref2?, pref3? }
 * Response: { status, message }
 */
router.post('/:studentId/upload-docs', authenticate, authorizePermission(['document.create.own', 'document.create.all', 'info.update.own', 'info.update.all']), validateRequest(uploadDocumentsAndPreferencesSchema), uploadDocumentsAndPreferences);

/**
 * POST /student/:studentId/re-upload-doc
 * Re-uploads a single document for a student (replaces existing).
 * Resets the document's verification status back to PENDING and clears any rejection remarks.
 * If admission status is DOCUMENTS_PENDING (rejected), moves it back to DOCUMENTS_SUBMITTED.
 * Protected statuses (SEAT_ALLOTTED, ADMISSION_CONFIRMED, ENROLLED) are never downgraded.
 * Accessible by both the student (own) and admin/staff (all).
 * Params: { studentId }
 * Body: { documentKey: string, url: string }
 * Response: { status, data: StudentDocument }
 */
router.post('/:studentId/re-upload-doc', authenticate, authorizePermission(['document.create.own', 'document.create.all']), reUploadDocument);

/**
 * POST /student/:studentId/academic-details
 * Adds academic qualification records for the student (10th, 12th, degree, etc.).
 * Creates AcademicQualification entries with level, board, year, percentage, school name.
 * Used during the document submission step of admission.
 * Params: { studentId }
 * Body: { qualifications: [{ level, board, yearOfPassing, percentage, schoolName, hallTicketNumber? }] }
 * Response: { status, message }
 */
router.post('/:studentId/academic-details', authenticate, authorizePermission(['student.update.own', 'student.update.all', 'qualification.create.own', 'qualification.create.all']), validateRequest(addAcademicDetailsSchema), addAcademicDetails);

/**
 * GET /student/document-requirements
 * Returns the list of required documents for the student's degree type.
 * Includes document name, whether it's mandatory, accepted file types, and max size.
 * Response: { status, data: [{ id, name, description, isMandatory, fileTypes, maxSize }] }
 */
router.get('/document-requirements', authenticate, authorizePermission(['document.read.own', 'document.read.all']), getMyRequirements);

/**
 * DELETE /student/:studentId/document
 * Deletes a specific document uploaded by the student.
 * Removes the StudentDocument record and optionally the S3 file.
 * Params: { studentId }
 * Query: { documentKey: string }
 * Response: { status, message }
 */
router.delete('/:studentId/document', authenticate, authorizePermission(['document.delete.own', 'document.delete.all']), deleteStudentDocument);

// ═══════════════════════════════════════════════════════════
// STUDENT PROFILE & DETAILS
// ═══════════════════════════════════════════════════════════

/**
 * GET /student/details
 * Returns the complete profile of the currently logged-in student.
 * Includes: personal info, admission status, exam details, documents, payments,
 * fee demands, scholarship, hostel/transport allocation, course preferences.
 * Uses the userId from JWT to find the student.
 * Query: { userId } — passed by frontend from auth context
 * Response: { status, data: { student (full profile with all relations) } }
 */
router.get('/details', authenticate, authorizePermission(['student.read.own', 'student.read.all']), getStudentDetails);

/**
 * POST /student/:studentId/personal-details
 * Updates student's personal information (name, address, phone, etc.).
 * Can also update course preferences (pref1, pref2, pref3).
 * Only updates fields that are provided — missing fields are not overwritten.
 * Params: { studentId }
 * Body: { name?, phone?, email?, address?, city?, state?, pincode?, pref1?, pref2?, pref3?, ... }
 * Response: { status, message, data: { updatedStudent } }
 */
router.post('/:studentId/personal-details', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(updatePersonalDetailsSchema), updatePersonalDetails);

/**
 * GET /student/:studentId/application-summary
 * Returns a formatted summary of the student's application for review/print.
 * Includes: personal details, academic qualifications, documents, exam details,
 * fee status, course preferences, and admission status.
 * Params: { studentId }
 * Response: { status, data: { summary } }
 */
router.get('/:studentId/application-summary', authenticate, authorizePermission(['student.read.own', 'student.read.all']), validateRequest(studentIdParamSchema), getApplicationSummary);

// ═══════════════════════════════════════════════════════════
// SERVICE REQUESTS
// ═══════════════════════════════════════════════════════════

/**
 * POST /student/:studentId/service-preferences
 * Submits a request to change hostel or transport preferences.
 * Creates a ServiceChangeRequest record that requires admin approval.
 * Params: { studentId }
 * Body: { serviceType: 'HOSTEL' | 'TRANSPORT', newPreference, reason? }
 * Response: { status, message }
 */
router.post('/:studentId/service-preferences', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(studentIdParamSchema), requestServiceChange);

/**
 * POST /student/:studentId/update-photo
 * Updates the student's profile photo URL.
 * The photo should already be uploaded to S3 via /upload/single.
 * Params: { studentId }
 * Body: { profilePhotoUrl: string }
 * Response: { status, message }
 */
router.post('/:studentId/update-photo', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(studentIdParamSchema), updateProfilePhoto);

/**
 * POST /student/:studentId/course-change
 * Submits a course/branch change request. Creates a CourseChangeRequest record.
 * Requires admin approval before the course is actually changed.
 * Validates that the requested course exists and has available seats.
 * Params: { studentId }
 * Body: { newCourseId: string, reason?: string }
 * Response: { status, message, data: { requestId } }
 */
router.post('/:studentId/course-change', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(changeCourseSchema), requestCourseChange);

export default router;
