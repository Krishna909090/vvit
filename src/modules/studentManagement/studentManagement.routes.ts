import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import {
    getAllApplications, uploadBulkApplications, requestCancellation, approveCancellation,
    verifyAndAllotSeat, verifyStudentDocument, reUploadDocument, requestCourseChange, approveCourseChange, getCourseChangeRequests, debugCourseAllotments,
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
    manualEntryAdmission,
    verifyPayment,
    getAdmissionInvoice,
    sendStatusEmail,
    getApplicationsExtended,
    reverseAdmissionPayment,
    requestBranchChange,
    requestProgramChange,
    assignPro,
    editPro,
    updateSeatAllotedBy,
    getFinancialApplications,
    exportApplicationsCsv,
    addToWaitingList,
    getWaitingList,
    exportWaitingListExcel,
    getWaitingListEntry,
    getStudentWaitingList,
    allotFromWaitingList,
    removeFromWaitingList,
    assignHostel,
    assignTransport,
    allocateBed,
    cancelHostel,
    cancelTransport,
    getAvailableBeds,
    getBedAllocatedStudents,
    getHostelPaidStudents,
    getPendingHostelAllocations,
    getStudentsByHostel,
    getTransportAllocatedStudents,
    getTransportPaidStudents,
    reassignHostel,
    reassignTransport,
    switchHostelToTransport,
    switchTransportToHostel,
    previewReassignHostel,
    previewCancelHostel,
    previewCancelTransport,
    previewSwitchHostelToTransport,
    previewSwitchTransportToHostel,
    bulkAllocateRoomBeds,
    assignEnrollment
} from './studentManagement.controller';
import {
    getAllApplicationsSchema, requestCancellationSchema, approveCancellationSchema,
    verifyAndAllotSeatSchema, changeCourseSchema, branchChangeSchema, approveCourseChangeSchema,
    updateAdmissionDetailsSchema, studentIdParamSchema,
    setEligibleScholarshipSchema,
    updateStudentPersonalDetailsSchema,
    updateAcademicQualificationSchema,
    deleteAcademicQualificationSchema,
    finalizeAdmissionSchema,
    manualEntryAdmissionSchema,
    assignEnrollmentSchema,
    verifyPaymentSchema,
    getApplicationsExtendedSchema,
    assignProSchema,
    editProSchema,
    updateSeatAllotedBySchema
} from '../../validators/adminValidators';
import { assignHostelSchema, assignTransportSchema, allocateBedSchema, availableBedsQuerySchema, bedAllocatedStudentsQuerySchema, cancelHostelSchema, cancelTransportSchema, hostelPaidStudentsQuerySchema, pendingHostelAllocationsQuerySchema, studentsByHostelSchema, switchHostelToTransportSchema, switchTransportToHostelSchema, transportAllocatedStudentsQuerySchema, transportPaidStudentsQuerySchema, reassignHostelSchema, reassignTransportSchema, bulkAllocateRoomSchema, reassignHostelPreviewSchema, cancelHostelPreviewSchema, cancelTransportPreviewSchema, switchHostelToTransportPreviewSchema, switchTransportToHostelPreviewSchema } from '../../validators/studentActionValidators';

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
 * GET /admin/student/applications/export-csv
 * Exports filtered student applications as a CSV file.
 * Accepts the same query filters as GET /applications.
 */
router.get('/applications/export-csv', authenticate, authorizePermission(['student.read.all']), validateRequest(getAllApplicationsSchema), exportApplicationsCsv);

/**
 * GET /admin/student/applications
 * Retrieves a paginated list of all student applications with basic details.
 * Supports filtering by status, quota type, course type, scholarship eligibility, and document presence.
 * Query: { page?, limit?, search?, status?, quotaType?, courseType?, applicationId?, isScholarshipEligible?, hasDocuments? }
 * Response: { status, data: { applications[], total, page, limit } }
 */
router.get('/applications', authenticate, authorizePermission(['student.read.all']), validateRequest(getAllApplicationsSchema), getAllApplications);

/**
 * GET /admin/student/applications/financials
 * Returns paginated student cards with financial breakdown per student.
 * Includes application fee, tuition, admission, book bank, hostel (paid/total) and transport (yes/no).
 * Query: { page?, limit?, search? }
 */
router.get('/applications/financials', authenticate, authorizePermission(['student.read.all']), getFinancialApplications);

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
router.post('/change-branch', authenticate, authorizePermission(['student.update.all']), validateRequest(branchChangeSchema), requestBranchChange);

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
 * GET /admin/student/debug/course-allotments/:courseId
 * Debug helper — returns ALL StudentAdmission records for a course (no filters),
 * the cached Course.filledSeats counter, and a status breakdown.
 * Use this to diagnose seat count discrepancies.
 */
router.get('/debug/course-allotments/:courseId', authenticate, authorizePermission(['student.read.all']), debugCourseAllotments);

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
 * POST /admin/student/:studentId/assign-hostel
 * Flips student's accommodationType from NONE to HOSTEL.
 * Captures hostelId + hostelPaymentMode. Bed allocation + price snapshot
 * happen separately (downstream).
 * Body: { hostelId: uuid, hostelPaymentMode: 'YEARWISE' | 'SEMWISE' }
 * Response: { status, message, data: StudentAdmission }
 */
router.post('/:studentId/assign-hostel', authenticate, authorizePermission(['student.update.all']), validateRequest(assignHostelSchema), assignHostel);

/**
 * POST /admin/student/:studentId/assign-transport
 * Flips student's accommodationType from NONE to TRANSPORT and sets transportRouteId.
 * Creates a single TRANSPORT StudentFeeDemand using route.cost; increments totalFee.
 * Idempotent: re-running before any TransportAllocation row exists replaces the demand
 * (soft-deletes old PENDING demand) and adjusts totalFee by the delta.
 * Body: { transportRouteId: uuid }
 * Response: { status, data: { transportRouteId, routeName, cost, feeDemandsCreated, totalFeeDelta } }
 */
router.post('/:studentId/assign-transport', authenticate, authorizePermission(['student.update.all']), validateRequest(assignTransportSchema), assignTransport);

/**
 * POST /admin/student/:studentId/reassign-transport
 * Re-assigns a TRANSPORT student to a different route.
 * Soft-deletes the prior PENDING TRANSPORT demand, creates a fresh one with the new
 * route's cost, and adjusts totalFee by the delta.
 * Body: { transportRouteId: uuid, reason: string }
 * Response: { status, data: { transportRouteId, routeName, cost, feeDemandsCreated, totalFeeDelta } }
 */
router.post('/:studentId/reassign-transport', authenticate, authorizePermission(['student.update.all']), validateRequest(reassignTransportSchema), reassignTransport);

/**
 * POST /admin/student/:studentId/cancel-hostel
 * Cancels a HOSTEL student: flips accommodationType to NONE, vacates bed, soft-deletes
 * pending hostel demands, drops pricing snapshot, and creates a FeeCorrection refund
 * (type=ACCOMMODATION_CHANGE_REFUND, amount = max(0, paid − cancellationFee)).
 * Body: { cancellationFee?: number (default 0), reason: string }
 * Response: { status, data: { paid, cancellationFee, refundAmount, pendingDemandRemoved, bedVacated, feeCorrectionId } }
 */
router.post('/:studentId/cancel-hostel', authenticate, authorizePermission(['student.update.all']), validateRequest(cancelHostelSchema), cancelHostel);

/**
 * POST /admin/student/:studentId/cancel-hostel/preview
 * Dry-run of cancel-hostel: returns the refundable amount and what would be removed/vacated.
 * No writes. Body: { cancellationFee?: number (default 0) }
 * Response: { status, data: { preview, paid, availableCredit, cancellationFee, refundAmount, pendingDemandToRemove, bedToVacate } }
 */
router.post('/:studentId/cancel-hostel/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(cancelHostelPreviewSchema), previewCancelHostel);

/**
 * POST /admin/student/:studentId/cancel-transport
 * Cancels a TRANSPORT student: flips accommodationType to NONE, soft-deletes pending
 * transport demand, and creates a FeeCorrection refund (type=ACCOMMODATION_CHANGE_REFUND,
 * amount = max(0, paid − cancellationFee)).
 * Body: { cancellationFee?: number (default 0), reason: string }
 * Response: { status, data: { paid, cancellationFee, refundAmount, pendingDemandRemoved, feeCorrectionId } }
 */
router.post('/:studentId/cancel-transport', authenticate, authorizePermission(['student.update.all']), validateRequest(cancelTransportSchema), cancelTransport);

/**
 * POST /admin/student/:studentId/cancel-transport/preview
 * Dry-run of cancel-transport: returns the refundable amount and pending demand that would be removed.
 * No writes. Body: { cancellationFee?: number (default 0) }
 * Response: { status, data: { preview, paid, cancellationFee, refundAmount, pendingDemandToRemove } }
 */
router.post('/:studentId/cancel-transport/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(cancelTransportPreviewSchema), previewCancelTransport);

/**
 * POST /admin/student/:studentId/switch-hostel-to-transport
 * Cancels HOSTEL and assigns a TRANSPORT route in one call. Refund pool from prorated
 * cancellation is applied as a discount on the new transport demand; any leftover
 * goes to FeeCorrection (refund).
 * Body: { chargeRetained?: number (default 0), reason: string, transportRouteId: uuid }
 * Response: { status, data: { cancellation, newAssignment, refund } }
 */
router.post('/:studentId/switch-hostel-to-transport', authenticate, authorizePermission(['student.update.all']), validateRequest(switchHostelToTransportSchema), switchHostelToTransport);

/**
 * POST /admin/student/:studentId/switch-hostel-to-transport/preview
 * Dry-run of switch-hostel-to-transport: returns refund pool, credit applied to the new
 * transport demand, leftover refund, and what the student would owe. No writes.
 * Body: { chargeRetained?: number (default 0), transportRouteId: uuid }
 * Response: { status, data: { preview, cancellation, newAssignment, refund } }
 */
router.post('/:studentId/switch-hostel-to-transport/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(switchHostelToTransportPreviewSchema), previewSwitchHostelToTransport);

/**
 * POST /admin/student/:studentId/switch-transport-to-hostel
 * Cancels TRANSPORT and assigns a HOSTEL in one call. Refund pool from prorated
 * cancellation is split proportionally across the 4 new hostel demands as discounts;
 * any leftover goes to FeeCorrection (refund).
 * Body: { chargeRetained?: number (default 0), reason: string, hostelId: uuid, hostelType: SHARING_*, hostelPaymentMode: YEARWISE|SEMWISE }
 * Response: { status, data: { cancellation, newAssignment, refund } }
 */
router.post('/:studentId/switch-transport-to-hostel', authenticate, authorizePermission(['student.update.all']), validateRequest(switchTransportToHostelSchema), switchTransportToHostel);

/**
 * POST /admin/student/:studentId/switch-transport-to-hostel/preview
 * Dry-run of switch-transport-to-hostel: returns refund pool, proportional credit
 * distribution across the 4 hostel demands, leftover refund, and student-owes. No writes.
 * Body: { chargeRetained?: number (default 0), hostelId: uuid, hostelType: SHARING_*, hostelPaymentMode: YEARWISE|SEMWISE }
 * Response: { status, data: { preview, cancellation, newAssignment, refund } }
 */
router.post('/:studentId/switch-transport-to-hostel/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(switchTransportToHostelPreviewSchema), previewSwitchTransportToHostel);

/**
 * POST /admin/student/:studentId/allocate-bed
 * Allocates a specific bed to a student already assigned to a hostel.
 * Snapshots pricing, creates HostelAllocation row, fee demands, and updates totalFee.
 * Body: { bedId: uuid, academicYearId?: uuid }
 * Response: { status, data: { allocation, pricing, feeDemandsCreated, skippedComponents } }
 */
router.post('/:studentId/allocate-bed', authenticate, authorizePermission(['student.update.all']), validateRequest(allocateBedSchema), allocateBed);

/**
 * POST /admin/student/:studentId/reassign-hostel
 * Re-assigns a student to a different hostel/bed AFTER initial bed allocation.
 * Vacates old bed, soft-deletes outstanding old demands, snapshots new pricing,
 * creates new demands, writes audit ledger entry. All atomic.
 * Body: { hostelId: uuid, bedId: uuid, hostelPaymentMode: 'YEARWISE'|'SEMWISE', reason: string }
 * Response: { status, data: { previous, current, feeDelta, supersededDemands, newDemandsCreated, ... } }
 */
router.post('/:studentId/reassign-hostel', authenticate, authorizePermission(['student.update.all']), validateRequest(reassignHostelSchema), reassignHostel);

/**
 * POST /admin/student/:studentId/reassign-hostel/preview
 * Dry-run of reassign-hostel: returns previous vs new pricing, fee delta, credit
 * distribution, and counts of demands that would be superseded/created. No writes.
 * Body: { hostelId: uuid, bedId: uuid, hostelPaymentMode: 'YEARWISE'|'SEMWISE' }
 * Response: { status, data: { preview, previous, current, feeDelta, financialAdjustment, supersededDemands, newDemandsCreated, skippedComponents } }
 */
router.post('/:studentId/reassign-hostel/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(reassignHostelPreviewSchema), previewReassignHostel);

/**
 * POST /admin/student/bulk-allocate-room
 * Bulk-allocates vacant beds in a single room to a list of students.
 * Each student must already be on accommodationType=HOSTEL with the target hostelId
 * and a hostelPaymentMode set (i.e. they must have gone through assign-hostel first).
 * Pre-validates everyone first; if any student fails validation, NONE are allocated.
 * Body: { roomId: uuid, studentIds: uuid[], academicYearId?: uuid }
 * Response: { success, allocated, requested, allocations[], pricing, skippedComponents }
 */
router.post('/bulk-allocate-room', authenticate, authorizePermission(['student.update.all']), validateRequest(bulkAllocateRoomSchema), bulkAllocateRoomBeds);

/**
 * GET /admin/student/available-beds/:hostelId
 * Lists vacant beds in a hostel (filterable by sharing/roomType/floor) for assignment-UI dropdown.
 * Query: ?sharing=4&roomType=AC&floor=1
 * Response: { status, data: { hostelId, count, beds: [{ bedId, bedNumber, roomNumber, floor, capacity, roomType }] } }
 */
router.get('/available-beds/:hostelId', authenticate, authorizePermission(['student.read.all']), validateRequest(availableBedsQuerySchema), getAvailableBeds);

/**
 * GET /admin/student/hostel-pending-allocation
 * Lists students who opted for hostel (have a hostelId set) but have no active bed allocation.
 * Query: { page?, limit?, search?, hostelId?, hostelType? (SHARING_2|4|6|8|10), gender? }
 * Response: { status, data: { students[], pagination: { total, page, limit, totalPages } } }
 */
router.get('/hostel-pending-allocation', authenticate, authorizePermission(['student.read.all']), validateRequest(pendingHostelAllocationsQuerySchema), getPendingHostelAllocations);

/**
 * GET /admin/student/by-hostel/:hostelId
 * Lists every student assigned to a hostel with their roster info (allocated and unallocated).
 * Query: { page?, limit?, search? (matches name/phone/applicationId), hostelType?, gender?, allottedCourseId?, allocationStatus? (ALLOCATED|NOT_ALLOCATED) }
 * Response: { status, data: { hostel: { id, name, type }, students[], pagination } }
 */
router.get('/by-hostel/:hostelId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentsByHostelSchema), getStudentsByHostel);

/**
 * GET /admin/student/hostel-paid
 * Lists students with accommodationType=HOSTEL who have at least one SUCCESS payment
 * (amount > 0) tagged with any hostel component (HOSTEL/HOSTEL_ACCOMMODATION/MESS/LAUNDRY/REGISTRATION).
 * No hostelId filter — spans all hostels.
 * Query: { page?, limit?, search? (name/phone/applicationId), gender?, all? (true|1) }
 * Response: { status, data: { students[], pagination } }
 */
router.get('/hostel-paid', authenticate, authorizePermission(['student.read.all']), validateRequest(hostelPaidStudentsQuerySchema), getHostelPaidStudents);

/**
 * GET /admin/student/bed-allocated
 * Lists every student with an active bed allocation (across all hostels).
 * Returns: applicationId, name, fatherName, phone, courseType, gender.
 * Query: { page?, limit?, search? (name/phone/applicationId), gender?, all? (true|1 — return all rows, no pagination) }
 * Response: { status, data: { students[], pagination } }
 */
router.get('/bed-allocated', authenticate, authorizePermission(['student.read.all']), validateRequest(bedAllocatedStudentsQuerySchema), getBedAllocatedStudents);

/**
 * GET /admin/student/transport-allocated
 * Lists every student whose admissionDetails.transportRouteId is set, with
 * route fee + paid breakdown. Pulled fields: applicationId, name, fatherName,
 * phone, gender, courseName, degreeType, routeName, transportRouteFee,
 * transportFeePaid, balance.
 * Query: { page?, limit?, search? (name/phone/applicationId), gender?, routeId?, all? (true|1) }
 * Response: { status, data: { students[], pagination } }
 */
router.get('/transport-allocated', authenticate, authorizePermission(['student.read.all']), validateRequest(transportAllocatedStudentsQuerySchema), getTransportAllocatedStudents);

/**
 * GET /admin/student/transport-paid
 * Lists students with accommodationType=TRANSPORT who have at least one SUCCESS
 * TRANSPORT payment (amount > 0). Optional routeId filters to a single route.
 * Query: { page?, limit?, search? (name/phone/applicationId), gender?, routeId?, all? (true|1) }
 * Response: { status, data: { students[], pagination } }
 */
router.get('/transport-paid', authenticate, authorizePermission(['student.read.all']), validateRequest(transportPaidStudentsQuerySchema), getTransportPaidStudents);

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
 * POST /admin/student/manual-entry
 * Manually create a student admission outside the normal application/entrance/seat-allotment flow.
 * Used for: lateral entry, transfer students, back-dated cohort entries.
 *
 * Permission: `student.create.lateral` — restricted to admins authorised to create direct admissions.
 * Body: see manualEntryAdmissionSchema in adminValidators.ts.
 */
router.post('/manual-entry', authenticate, authorizePermission(['student.create.lateral']), validateRequest(manualEntryAdmissionSchema), manualEntryAdmission);

/**
 * POST /admin/student/:studentId/assign-enrollment
 * Step 2 of the two-step admission flow: assigns rollNumber + section to a
 * previously-registered student (after counseling / seat allotment). Creates
 * the StudentEnrollment row that backs roll-number-based login and fee billing.
 * Works for both fresh and lateral students — entry data was captured during /student/register.
 *
 * Permission: `student.update.all` — restricted to admins running seat allotment.
 * Body: { rollNumber, sectionId, currentSemester?, yearOfStudy?, seedFeeDemands? }
 */
router.post(
    '/:studentId/assign-enrollment',
    authenticate,
    authorizePermission(['student.update.all']),
    validateRequest(assignEnrollmentSchema),
    assignEnrollment
);

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

/**
 * POST /admin/student/re-upload-doc/:studentId
 * Admin re-uploads a single document on behalf of a student.
 * Resets document status to PENDING and clears rejection remarks.
 * If admission status is DOCUMENTS_PENDING, moves it back to DOCUMENTS_SUBMITTED.
 * Protected statuses (SEAT_ALLOTTED, ADMISSION_CONFIRMED, ENROLLED) are never downgraded.
 * Params: { studentId }
 * Body: { documentKey: string, url: string }
 * Response: { status, data: StudentDocument }
 */
router.post('/re-upload-doc/:studentId', authenticate, authorizePermission(['document.create.all']), reUploadDocument);

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

/**
 * PATCH /admin/student/edit-pro
 * Edits or removes the PRO assignment for a student.
 * Send proNumber to change PRO, omit it to remove the current PRO.
 * Body: { studentId: uuid, proNumber?: string }
 * Response: { status, data: { studentId, proId, proNumber } }
 */
router.patch('/edit-pro', authenticate, authorizePermission(['pro.update.all']), validateRequest(editProSchema), editPro);

router.patch('/seat-alloted-by', authenticate, authorizePermission(['student.update.all']), validateRequest(updateSeatAllotedBySchema), updateSeatAllotedBy);

// ═══════════════════════════════════════════════════════════
//  WAITING LIST
// ═══════════════════════════════════════════════════════════

/**
 * POST /admin/student/waiting-list
 * Add a student to the waiting list for a single course (first-year REGULAR
 * admissions only; one course per student per year). Assigns a fixed waitingNumber
 * and seeds fee demands for the course.
 * Body: { studentId, courseId, category: MANAGEMENT|POLICE|GENERAL, remarks? }
 */
router.post('/waiting-list', authenticate, authorizePermission(['student.update.all']), addToWaitingList);

/**
 * GET /admin/student/waiting-list
 * Get waiting list entries. Filter by courseId, status, category.
 * amountSort: 'high' (paid desc) | 'low' (paid asc) | 'all' (FIFO by createdAt).
 * Default: MANAGEMENT → 'high'; POLICE/GENERAL → 'all' (createdAt order).
 * Query: { courseId?, status?, category?, amountSort?, page?, limit? }
 */
router.get('/waiting-list', authenticate, authorizePermission(['student.read.all']), getWaitingList);

/**
 * GET /admin/student/waiting-list/export
 * Export the waiting list to Excel (.xlsx) using the SAME filters/ordering as the list:
 * courseId, status, category, amountSort. MUST be declared before /waiting-list/:studentId.
 */
router.get('/waiting-list/export', authenticate, authorizePermission(['student.read.all']), exportWaitingListExcel);

/**
 * GET /admin/student/waiting-list/entry/:waitingListId
 * Get a single waiting-list entry's full details by its id.
 * (Two-segment path — won't collide with /waiting-list/:studentId.)
 */
router.get('/waiting-list/entry/:waitingListId', authenticate, authorizePermission(['student.read.all']), getWaitingListEntry);

/**
 * GET /admin/student/waiting-list/:studentId
 * Get waiting list entries for a specific student.
 */
router.get('/waiting-list/:studentId', authenticate, authorizePermission(['student.read.all']), getStudentWaitingList);

/**
 * POST /admin/student/waiting-list/allot
 * Allot a seat from the waiting list. Moves WAITING → ALLOTTED, sets SEAT_ALLOTTED,
 * and applies the chosen accommodation.
 * Body: {
 *   waitingListId,
 *   allocation: { type: 'HOSTEL'|'TRANSPORT'|'NONE',
 *                 hostelType, hostelPaymentMode, hostelId?,     // HOSTEL (hostelId optional — assigned later)
 *                 transportRouteId? }                            // TRANSPORT
 * }
 */
router.post('/waiting-list/allot', authenticate, authorizePermission(['student.update.all']), allotFromWaitingList);

/**
 * POST /admin/student/waiting-list/remove
 * Remove entries from waiting list (cancel).
 * Body: { waitingListId? } or { studentId?, courseId? }
 */
router.post('/waiting-list/remove', authenticate, authorizePermission(['student.update.all']), removeFromWaitingList);

export default router;
