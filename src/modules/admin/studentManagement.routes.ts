import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getAllApplications, uploadBulkApplications, requestCancellation, approveCancellation,
    verifyAndAllotSeat, verifyStudentDocument, requestCourseChange, approveCourseChange, getCourseChangeRequests,
    updateAdmissionDetails, getStudentCertificates, downloadStudentDocuments, updateRollNumber,
    updateStudentStatus,
    setScholarshipEligibility,
    updateStudentPersonalDetails,
    getStudentDetails,
    getStudentDetailsByApplicationId,
    updateAcademicQualification,
    deleteAcademicQualification,
    updateStudentScholarship,
    getStudentScholarships,
    getScholarshipStats,
    editStudentScholarship,
    downloadApplication,
    finalizeAdmission,
    verifyPayment,
    getAdmissionInvoice,
    sendStatusEmail,
    getApplicationsExtended,
    reverseAdmissionPayment,
    requestBranchChange,
    requestProgramChange,
    assignPro,
    updateSeatAllotedBy
} from './studentManagement.controller';
import {
    getAllApplicationsSchema, requestCancellationSchema, approveCancellationSchema,
    verifyAndAllotSeatSchema, changeCourseSchema, approveCourseChangeSchema,
    updateAdmissionDetailsSchema, studentIdParamSchema,
    setEligibleScholarshipSchema,
    updateStudentPersonalDetailsSchema,
    updateAcademicQualificationSchema,
    deleteAcademicQualificationSchema,
    finalizeAdmissionSchema,
    verifyPaymentSchema,
    getApplicationsExtendedSchema,
    assignProSchema,
    updateSeatAllotedBySchema
} from '../../validators/adminValidators';

import upload from '../../config/multer';
import {
    addRequirement,
    listRequirements,
    updateRequirement,
    removeRequirement
} from '../document/document.controller';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  APPLICATIONS
// ═══════════════════════════════════════════════════════════

/**
 * GET /admin/student/applications
 * Retrieves a paginated list of all student applications with basic details.
 * Supports filtering by status, quota type, course type, scholarship eligibility, and document presence.
 * Query: { page?, limit?, search?, status?, quotaType?, courseType?, applicationId?, isScholarshipEligible?, hasDocuments? }
 * Response: { status, data: { applications[], total, page, limit } }
 */
router.get('/applications', authenticate, authorizePermission(['student.read.all']), validateRequest(getAllApplicationsSchema), getAllApplications);

/**
 * GET /admin/student/applications-extended
 * Retrieves an extended/expanded list of student applications with additional filter dimensions.
 * Includes all basic filters plus degree, gender, preference, and payment status filters.
 * Query: { page?, limit?, search?, status?, quotaType?, courseType?, degree?, gender?, preference?, paymentStatus?, applicationId?, isScholarshipEligible?, hasDocuments? }
 * Response: { status, data: { applications[], total, page, limit } }
 */
router.get('/applications-extended', authenticate, authorizePermission(['student.read.all']), validateRequest(getApplicationsExtendedSchema), getApplicationsExtended);

/**
 * POST /admin/student/upload-applications
 * Bulk-imports student applications from an uploaded CSV file.
 * Parses CSV rows, creates student + user records for each entry, and cleans up the temp file.
 * Body: multipart/form-data with field "file" (CSV)
 * Response: { status, data: { created: number, errors: { row, error }[] } }
 */
router.post('/upload-applications', authenticate, authorizePermission(['student.create.all']), upload.single('file'), uploadBulkApplications);

// ═══════════════════════════════════════════════════════════
//  CANCELLATION
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/request-cancellation
 * Creates an admission cancellation request for a student with a specified refund amount.
 * Inserts a new CancellationRequest record in REQUESTED status.
 * Body: { studentId: uuid, reason: string, refundAmount: number }
 * Response: { status, data: CancellationRequest }
 */
router.post('/request-cancellation', authenticate, authorizePermission(['student.update.all']), validateRequest(requestCancellationSchema), requestCancellation);

/**
 * POST /admin/student/approve-cancellation
 * Approves or rejects an existing cancellation request. Restricted to SUPER_ADMIN role.
 * If approved: updates student admission status to CANCELLED and releases the allotted seat.
 * Body: { requestId: uuid, approved: boolean }
 * Response: { status, message }
 */
router.post('/approve-cancellation', authenticate, authorizePermission(['student.update.all']), validateRequest(approveCancellationSchema), approveCancellation);

// ═══════════════════════════════════════════════════════════
//  SEAT ALLOTMENT & COURSE / BRANCH / PROGRAM CHANGES
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/verify-allot
 * Verifies a student's documents and allots them a seat in the specified course.
 * If approved: updates admission status and assigns the allotted course. If rejected: marks documents as rejected.
 * Body: { studentId: uuid, approved: boolean, allottedCourseId?: uuid (required when approved=true) }
 * Response: { status, success: boolean, message }
 */
router.post('/verify-allot', authenticate, authorizePermission(['student.update.all']), validateRequest(verifyAndAllotSeatSchema), verifyAndAllotSeat);

/**
 * POST /admin/student/change-course
 * Requests a generic course change for a student (within the same degree program).
 * Creates a CourseChangeRequest record in PENDING status for super-admin approval.
 * Body: { studentId: uuid, newCourseId: uuid, reason: string }
 * Response: { status, data: CourseChangeRequest }
 */
router.post('/change-course', authenticate, authorizePermission(['student.update.all']), validateRequest(changeCourseSchema), requestCourseChange);

/**
 * POST /admin/student/change-branch
 * Requests a branch change within the same program (e.g. B.Tech CSE -> B.Tech ECE).
 * Validates that both old and new courses belong to the same degree before creating the request.
 * Body: { studentId: uuid, newCourseId: uuid, reason: string }
 * Response: { status, data: CourseChangeRequest }
 */
router.post('/change-branch', authenticate, authorizePermission(['student.update.all']), validateRequest(changeCourseSchema), requestBranchChange);

/**
 * POST /admin/student/change-program
 * Requests a cross-program transfer (e.g. B.Tech -> BBA, M.Tech -> MBA).
 * Validates against an allow-list of permitted program transitions before creating the request.
 * Body: { studentId: uuid, newCourseId: uuid, reason: string }
 * Response: { status, data: CourseChangeRequest }
 */
router.post('/change-program', authenticate, authorizePermission(['student.update.all']), validateRequest(changeCourseSchema), requestProgramChange);

/**
 * GET /admin/student/course-change-requests
 * Lists all pending and processed course/branch/program change requests.
 * Returns requests with associated student and course details.
 * Query: (standard pagination/filter params passed through to service)
 * Response: { status, data: CourseChangeRequest[] }
 */
router.get('/course-change-requests', authenticate, authorizePermission(['student.read.all']), getCourseChangeRequests);

/**
 * POST /admin/student/approve-course-change
 * Approves or rejects a course/branch/program change request. Restricted to SUPER_ADMIN role.
 * If approved: updates the student's allotted course in a transaction and marks the request APPROVED.
 * Body: { requestId: uuid, approved: boolean }
 * Response: { status, message }
 */
router.post('/approve-course-change', authenticate, authorizePermission(['student.update.all']), validateRequest(approveCourseChangeSchema), approveCourseChange);

// ═══════════════════════════════════════════════════════════
//  ADMISSION DETAILS & FINALIZATION
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/update-admission
 * Updates a student's accommodation and admission details (hostel, transport, etc.).
 * Calculates fee adjustments when accommodation type changes and updates the admission record.
 * Body: { studentId: uuid, accommodationType: AccommodationType, hostelType?, hostelId?, transportRouteId?, hostelPaymentMode?, paidAmount? }
 * Response: { status, message }
 */
router.post('/update-admission', authenticate, authorizePermission(['student.update.all']), validateRequest(updateAdmissionDetailsSchema), updateAdmissionDetails);

/**
 * POST /admin/student/finalize-admission
 * Finalizes a student's admission by processing payment, setting course allocation, and optional scholarship/accommodation.
 * Online payment: creates PENDING payment, initiates PhonePe transaction, returns redirect URL.
 * Offline/bank-transfer: creates SUCCESS payment, generates allotment order + invoice, sends confirmation email.
 * Body: { studentId: uuid, payment: { method, amount, referenceNumber?, date?, feeHeadId?, feeStructureId? }, scholarship?: { percentage, ruleId? } | null, allocation?: { type, hostelId?, transportRouteId?, hostelType?, hostelPaymentMode? }, course: { allottedCourseId: uuid } }
 * Response: { status, data: { paymentId, redirectUrl? (online) | invoiceUrl? (offline), message } }
 */
router.post('/finalize-admission', authenticate, authorizePermission(['student.update.all']), validateRequest(finalizeAdmissionSchema), finalizeAdmission);

/**
 * POST /admin/student/verify-payment
 * Verifies an online payment's status and completes admission if successful.
 * Checks the payment gateway status, updates payment record, generates invoice, and sends email on success.
 * Also processes sibling/bundled payments sharing the same provider transaction ID.
 * Body: { paymentId: uuid }
 * Response: { status, data: { paymentId, status, invoiceUrl?, message } }
 */
router.post('/verify-payment', authenticate, authorizePermission(['student.update.all']), validateRequest(verifyPaymentSchema), verifyPayment);

/**
 * GET /admin/student/admission-invoice/:studentId
 * Retrieves the admission fee invoice for a student.
 * Looks up the latest successful TUITION payment; returns existing invoice URL or generates a new one.
 * Students accessing this route are restricted to their own data via a security check.
 * Params: { studentId: uuid }
 * Response: { status, data: { invoiceUrl: string } }
 */
router.get('/admission-invoice/:studentId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentIdParamSchema), getAdmissionInvoice);

// ═══════════════════════════════════════════════════════════
//  DOCUMENTS
// ═══════════════════════════════════════════════════════════

/**
 * GET /admin/student/certificates/:studentId
 * Retrieves all uploaded certificate/document records for a student.
 * Returns document metadata including keys, URLs, and verification status.
 * Params: { studentId: uuid }
 * Response: { status, data: StudentDocument[] }
 */
router.get('/certificates/:studentId', authenticate, authorizePermission(['document.read.all']), validateRequest(studentIdParamSchema), getStudentCertificates);

/**
 * GET /admin/student/download-documents/:studentId
 * Downloads all of a student's documents as a single ZIP archive.
 * Generates a temporary ZIP file on disk, streams it to the client, then deletes the temp file.
 * Params: { studentId: uuid }
 * Response: Binary ZIP file download (Content-Disposition: attachment)
 */
router.get('/download-documents/:studentId', authenticate, authorizePermission(['document.read.all']), validateRequest(studentIdParamSchema), downloadStudentDocuments);

/**
 * GET /admin/student/application-pdf/:studentId
 * Generates and downloads the student's application form as a PDF.
 * Renders the application data into a PDF buffer and streams it to the client.
 * Params: { studentId: uuid }
 * Response: Binary PDF download (Content-Type: application/pdf)
 */
router.get('/application-pdf/:studentId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentIdParamSchema), downloadApplication);

/**
 * POST /admin/student/verify-document/:studentId
 * Verifies or rejects a specific uploaded document for a student.
 * Updates the document's verification status and optionally adds admin remarks.
 * Params: { studentId: uuid }
 * Body: { documentKey: string, status: string, remarks?: string }
 * Response: { status, data: StudentDocument }
 */
router.post('/verify-document/:studentId', authenticate, authorizePermission(['document.update.all']), verifyStudentDocument);

// ═══════════════════════════════════════════════════════════
//  DOCUMENT REQUIREMENTS MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/document-requirements
 * Creates a new document requirement definition (e.g. "10th Marksheet", "Transfer Certificate").
 * The requirement specifies which documents students of a given degree type must upload.
 * Body: { name, degreeType, isRequired, ... } (fields defined by DocumentRequirement model)
 * Response: { status, data: DocumentRequirement }
 */
router.post('/document-requirements', authenticate, authorizePermission(['document.create.all']), addRequirement);

/**
 * GET /admin/student/document-requirements
 * Lists all document requirement definitions, optionally filtered by degree type.
 * Returns the full list of required and optional documents configured in the system.
 * Query: { degreeType?: string }
 * Response: { status, data: DocumentRequirement[] }
 */
router.get('/document-requirements', authenticate, authorizePermission(['document.read.all']), listRequirements);

/**
 * PUT /admin/student/document-requirements/:id
 * Updates an existing document requirement definition.
 * Modifies properties like name, required status, or applicable degree type.
 * Params: { id: uuid }
 * Body: { name?, degreeType?, isRequired?, ... } (partial DocumentRequirement fields)
 * Response: { status, data: DocumentRequirement }
 */
router.put('/document-requirements/:id', authenticate, authorizePermission(['document.update.all']), updateRequirement);

/**
 * DELETE /admin/student/document-requirements/:id
 * Permanently deletes a document requirement definition.
 * Removes the requirement record from the database.
 * Params: { id: uuid }
 * Response: { status, message }
 */
router.delete('/document-requirements/:id', authenticate, authorizePermission(['document.delete.all']), removeRequirement);

// ═══════════════════════════════════════════════════════════
//  ENROLLMENT
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/update-roll-number
 * Assigns or updates a student's roll number, section, and academic year.
 * Upserts a StudentEnrollment record linking the student to a section and academic year.
 * Body: { studentId: uuid, rollNumber: string, sectionId: uuid, academicYearId: uuid }
 * Response: { status, data: StudentEnrollment }
 */
router.post('/update-roll-number', authenticate, authorizePermission(['student.update.all']), updateRollNumber);

// ═══════════════════════════════════════════════════════════
//  STATUS MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/update-status
 * Manually updates a student's admission status (e.g. APPLIED, VERIFIED, ADMITTED, etc.).
 * Directly sets the status on the StudentAdmission record after validating the status enum.
 * Body: { studentId: uuid, status: AdmissionStatus }
 * Response: { status, message }
 */
router.post('/update-status', authenticate, authorizePermission(['student.update.all']), updateStudentStatus);

// ═══════════════════════════════════════════════════════════
//  SCHOLARSHIP
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/scholarship-eligibility
 * Manually sets a student's eligible scholarship rule.
 * Validates that the rule exists and is active, then updates the student's eligibleScholarshipRuleId.
 * Body: { studentId: uuid, ruleId: uuid }
 * Response: { status, message }
 */
router.post('/scholarship-eligibility', authenticate, authorizePermission(['scholarship.update.all']), validateRequest(setEligibleScholarshipSchema), setScholarshipEligibility);

// ═══════════════════════════════════════════════════════════
//  PERSONAL DETAILS
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/update-personal-details
 * Updates a student's personal details (name, address, DOB, email, preferences, etc.).
 * If called by a student role, enforces ownership so they can only update their own profile. Phone updates are blocked.
 * Body: { studentId: uuid, name?, fatherName?, motherName?, gender?, dob?, email?, category?, address?, city?, state?, pincode?, country?, profilePhotoUrl?, aadharNumber?, pref1?, pref2?, pref3? }
 * Response: { status, message, data?: { profilePhotoUrl? } }
 */
router.post('/update-personal-details', authenticate, authorizePermission(['student.update.all']), validateRequest(updateStudentPersonalDetailsSchema), updateStudentPersonalDetails);

// ═══════════════════════════════════════════════════════════
//  STUDENT DETAILS
// ═══════════════════════════════════════════════════════════

/**
 * GET /admin/student/details/:studentId
 * Retrieves the complete profile for a student including personal info, admission, documents, qualifications, and scholarships.
 * Aggregates data from multiple related tables into a single response.
 * Params: { studentId: uuid }
 * Response: { status, data: { student, admission, documents, qualifications, scholarships, enrollment, ... } }
 */
router.get('/details/:studentId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentIdParamSchema), getStudentDetails);

/**
 * GET /admin/student/detailsByAppId/:applicationId
 * Retrieves complete student details by their application ID instead of student UUID.
 * Looks up the student by applicationId and returns the same comprehensive profile data.
 * Params: { applicationId: string }
 * Response: { status, data: { student, admission, documents, qualifications, scholarships, enrollment, ... } }
 */
router.get('/detailsByAppId/:applicationId', authenticate, authorizePermission(['student.read.all']), getStudentDetailsByApplicationId);

// ═══════════════════════════════════════════════════════════
//  ACADEMIC QUALIFICATIONS
// ═══════════════════════════════════════════════════════════

/**
 * PUT /admin/student/academic-qualifications/:id
 * Updates an existing academic qualification record (e.g. 10th, 12th, degree marks).
 * If called by a student role, enforces ownership check so students can only edit their own qualifications.
 * Params: { id: uuid }
 * Body: { level?, board?, yearOfPassing?, hallTicketNumber?, gpaOrMarks? }
 * Response: { status, data: AcademicQualification }
 */
router.put('/academic-qualifications/:id', authenticate, authorizePermission(['student.update.all']), validateRequest(updateAcademicQualificationSchema), updateAcademicQualification);

/**
 * DELETE /admin/student/academic-qualifications/:id
 * Permanently deletes an academic qualification record.
 * If called by a student role, enforces ownership check so students can only delete their own qualifications.
 * Params: { id: uuid }
 * Response: { status, message }
 */
router.delete('/academic-qualifications/:id', authenticate, authorizePermission(['student.update.all']), validateRequest(deleteAcademicQualificationSchema), deleteAcademicQualification);

// ═══════════════════════════════════════════════════════════
//  STUDENT SCHOLARSHIP MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/student-scholarship
 * Creates or updates a student's scholarship record with percentage, type, score, and eligibility.
 * Upserts the StudentScholarship record and optionally links it to an academic qualification.
 * Body: { studentId: uuid, type?, degreeType?, score?, remarks?, scholarshipPercentage?, qualificationId?, isEligible? }
 * Response: { status, data: StudentScholarship }
 */
router.post('/student-scholarship', authenticate, authorizePermission(['scholarship.update.all']), updateStudentScholarship);

/**
 * PUT /admin/student/student-scholarship/:id
 * Edits an existing student scholarship record by its ID.
 * Updates fields like percentage, type, score, and remarks. Recalculates fee adjustments if percentage changes.
 * Params: { id: uuid }
 * Body: { type?, degreeType?, score?, remarks?, scholarshipPercentage?, qualificationId?, isEligible? }
 * Response: { status, data: StudentScholarship }
 */
router.put('/student-scholarship/:id', authenticate, authorizePermission(['scholarship.update.all']), editStudentScholarship);

/**
 * GET /admin/student/scholarship-stats
 * Retrieves aggregate scholarship statistics grouped by degree type and scholarship percentage.
 * Only counts students who have an allotted course (i.e. confirmed admissions).
 * Response: { status, data: { degreeType, scholarshipPercentage, count }[] }
 */
router.get('/scholarship-stats', authenticate, authorizePermission(['scholarship.read.all']), getScholarshipStats);

/**
 * GET /admin/student/student-scholarship/:studentId
 * Retrieves all scholarship records associated with a specific student.
 * Returns the full list of StudentScholarship entries for the given student.
 * Params: { studentId: uuid }
 * Response: { status, data: StudentScholarship[] }
 */
router.get('/student-scholarship/:studentId', authenticate, authorizePermission(['scholarship.read.all']), getStudentScholarships);

// ═══════════════════════════════════════════════════════════
//  EMAIL & COMMUNICATION
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/send-status-email
 * Manually triggers a status update email to a student.
 * Sends an email with approved/rejected/pending item details using the configured email service.
 * Body: { studentId: uuid, updateType: string, approvedItems?: any[], rejectedItems?: any[], pendingItems?: any[] }
 * Response: { status, message }
 */
router.post('/send-status-email', authenticate, authorizePermission(['student.update.all']), sendStatusEmail);

// ═══════════════════════════════════════════════════════════
//  PAYMENT REVERSAL
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/reverse-admission-payment
 * Reverses a mistaken offline/bank-transfer payment and undoes all admission side-effects.
 * Only works on OFFLINE + SUCCESS payments. Deletes the payment, reverts admission status, and releases the seat.
 * Restricted to super-admins only (student.delete.all permission).
 * Body: { paymentId: uuid, reason?: string }
 * Response: { status, message, data: { reversed payment details } }
 */
router.post('/reverse-admission-payment', authenticate, authorizePermission(['student.delete.all']), reverseAdmissionPayment);

// ═══════════════════════════════════════════════════════════
//  PRO ASSIGNMENT
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/assign-pro
 * Assigns a PRO (Public Relations Officer) to a student by PRO number.
 * Looks up the PRO record by proNumber, validates both PRO and student exist, then links them.
 * Body: { studentId: uuid, proNumber: string }
 * Response: { status, data: { studentId, proId, proNumber } }
 */
router.post('/assign-pro', authenticate, authorizePermission(['student.update.all']), validateRequest(assignProSchema), assignPro);

router.patch('/seat-alloted-by', authenticate, authorizePermission(['student.update.all']), validateRequest(updateSeatAllotedBySchema), updateSeatAllotedBy);

export default router;
