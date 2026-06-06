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
    updateHostelId,
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
    assignEnrollment,
    reconcileStudentFees
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
import { assignHostelSchema, assignTransportSchema, allocateBedSchema, updateHostelIdSchema, availableBedsQuerySchema, bedAllocatedStudentsQuerySchema, cancelHostelSchema, cancelTransportSchema, hostelPaidStudentsQuerySchema, pendingHostelAllocationsQuerySchema, studentsByHostelSchema, switchHostelToTransportSchema, switchTransportToHostelSchema, transportAllocatedStudentsQuerySchema, transportPaidStudentsQuerySchema, reassignHostelSchema, reassignTransportSchema, bulkAllocateRoomSchema, reassignHostelPreviewSchema, cancelHostelPreviewSchema, cancelTransportPreviewSchema, switchHostelToTransportPreviewSchema, switchTransportToHostelPreviewSchema } from '../../validators/studentActionValidators';

import upload from '../../config/multer';
import {
    addRequirement,
    listRequirements,
    updateRequirement,
    removeRequirement
} from '../document/document.controller';

const router = Router();

router.get('/applications/export-csv', authenticate, authorizePermission(['student.read.all']), validateRequest(getAllApplicationsSchema), exportApplicationsCsv);

router.get('/applications', authenticate, authorizePermission(['student.read.all']), validateRequest(getAllApplicationsSchema), getAllApplications);

router.get('/applications/financials', authenticate, authorizePermission(['student.read.all']), getFinancialApplications);

router.get('/applications-extended', authenticate, authorizePermission(['student.read.all']), validateRequest(getApplicationsExtendedSchema), getApplicationsExtended);

router.post('/upload-applications', authenticate, authorizePermission(['student.create.all']), upload.single('file'), uploadBulkApplications);

router.post('/request-cancellation', authenticate, authorizePermission(['student.update.all']), validateRequest(requestCancellationSchema), requestCancellation);

router.post('/approve-cancellation', authenticate, authorizePermission(['student.update.all']), validateRequest(approveCancellationSchema), approveCancellation);

router.post('/verify-allot', authenticate, authorizePermission(['student.update.all']), validateRequest(verifyAndAllotSeatSchema), verifyAndAllotSeat);

router.post('/change-course', authenticate, authorizePermission(['student.update.all']), validateRequest(changeCourseSchema), requestCourseChange);

router.post('/change-branch', authenticate, authorizePermission(['student.update.all']), validateRequest(branchChangeSchema), requestBranchChange);

router.post('/change-program', authenticate, authorizePermission(['student.update.all']), validateRequest(changeCourseSchema), requestProgramChange);

router.get('/course-change-requests', authenticate, authorizePermission(['student.read.all']), getCourseChangeRequests);

router.get('/debug/course-allotments/:courseId', authenticate, authorizePermission(['student.read.all']), debugCourseAllotments);

router.post('/approve-course-change', authenticate, authorizePermission(['student.update.all']), validateRequest(approveCourseChangeSchema), approveCourseChange);

router.post('/update-admission', authenticate, authorizePermission(['student.update.all']), validateRequest(updateAdmissionDetailsSchema), updateAdmissionDetails);

router.post('/:studentId/assign-hostel', authenticate, authorizePermission(['student.update.all']), validateRequest(assignHostelSchema), assignHostel);

router.post('/:studentId/assign-transport', authenticate, authorizePermission(['student.update.all']), validateRequest(assignTransportSchema), assignTransport);

router.post('/:studentId/reassign-transport', authenticate, authorizePermission(['student.update.all']), validateRequest(reassignTransportSchema), reassignTransport);

router.post('/:studentId/cancel-hostel', authenticate, authorizePermission(['student.update.all']), validateRequest(cancelHostelSchema), cancelHostel);

router.post('/:studentId/cancel-hostel/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(cancelHostelPreviewSchema), previewCancelHostel);

router.post('/:studentId/cancel-transport', authenticate, authorizePermission(['student.update.all']), validateRequest(cancelTransportSchema), cancelTransport);

router.post('/:studentId/cancel-transport/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(cancelTransportPreviewSchema), previewCancelTransport);

router.post('/:studentId/switch-hostel-to-transport', authenticate, authorizePermission(['student.update.all']), validateRequest(switchHostelToTransportSchema), switchHostelToTransport);

router.post('/:studentId/switch-hostel-to-transport/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(switchHostelToTransportPreviewSchema), previewSwitchHostelToTransport);

router.post('/:studentId/switch-transport-to-hostel', authenticate, authorizePermission(['student.update.all']), validateRequest(switchTransportToHostelSchema), switchTransportToHostel);

router.post('/:studentId/switch-transport-to-hostel/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(switchTransportToHostelPreviewSchema), previewSwitchTransportToHostel);

router.post('/:studentId/allocate-bed', authenticate, authorizePermission(['student.update.all']), validateRequest(allocateBedSchema), allocateBed);
router.patch('/:studentId/update-hostel-id', authenticate, authorizePermission(['student.update.all']), validateRequest(updateHostelIdSchema), updateHostelId);

router.post('/:studentId/reassign-hostel', authenticate, authorizePermission(['student.update.all']), validateRequest(reassignHostelSchema), reassignHostel);

router.post('/:studentId/reassign-hostel/preview', authenticate, authorizePermission(['student.update.all']), validateRequest(reassignHostelPreviewSchema), previewReassignHostel);

router.post('/bulk-allocate-room', authenticate, authorizePermission(['student.update.all']), validateRequest(bulkAllocateRoomSchema), bulkAllocateRoomBeds);

router.get('/available-beds/:hostelId', authenticate, authorizePermission(['student.read.all']), validateRequest(availableBedsQuerySchema), getAvailableBeds);

router.get('/hostel-pending-allocation', authenticate, authorizePermission(['student.read.all']), validateRequest(pendingHostelAllocationsQuerySchema), getPendingHostelAllocations);

router.get('/by-hostel/:hostelId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentsByHostelSchema), getStudentsByHostel);

router.get('/hostel-paid', authenticate, authorizePermission(['student.read.all']), validateRequest(hostelPaidStudentsQuerySchema), getHostelPaidStudents);

router.get('/bed-allocated', authenticate, authorizePermission(['student.read.all']), validateRequest(bedAllocatedStudentsQuerySchema), getBedAllocatedStudents);

router.get('/transport-allocated', authenticate, authorizePermission(['student.read.all']), validateRequest(transportAllocatedStudentsQuerySchema), getTransportAllocatedStudents);

router.get('/transport-paid', authenticate, authorizePermission(['student.read.all']), validateRequest(transportPaidStudentsQuerySchema), getTransportPaidStudents);

router.post('/finalize-admission', authenticate, authorizePermission(['student.update.all']), validateRequest(finalizeAdmissionSchema), finalizeAdmission);

router.post('/manual-entry', authenticate, authorizePermission(['student.create.lateral']), validateRequest(manualEntryAdmissionSchema), manualEntryAdmission);

router.post(
    '/:studentId/assign-enrollment',
    authenticate,
    authorizePermission(['student.update.all']),
    validateRequest(assignEnrollmentSchema),
    assignEnrollment
);

router.post('/verify-payment', authenticate, authorizePermission(['student.update.all']), validateRequest(verifyPaymentSchema), verifyPayment);

router.get('/admission-invoice/:studentId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentIdParamSchema), getAdmissionInvoice);

router.get('/certificates/:studentId', authenticate, authorizePermission(['document.read.all']), validateRequest(studentIdParamSchema), getStudentCertificates);

router.get('/download-documents/:studentId', authenticate, authorizePermission(['document.read.all']), validateRequest(studentIdParamSchema), downloadStudentDocuments);

router.get('/application-pdf/:studentId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentIdParamSchema), downloadApplication);

router.post('/verify-document/:studentId', authenticate, authorizePermission(['document.update.all']), verifyStudentDocument);

router.post('/re-upload-doc/:studentId', authenticate, authorizePermission(['document.create.all']), reUploadDocument);

router.post('/document-requirements', authenticate, authorizePermission(['document.create.all']), addRequirement);

router.get('/document-requirements', authenticate, authorizePermission(['document.read.all']), listRequirements);

router.put('/document-requirements/:id', authenticate, authorizePermission(['document.update.all']), updateRequirement);

router.delete('/document-requirements/:id', authenticate, authorizePermission(['document.delete.all']), removeRequirement);

router.post('/update-roll-number', authenticate, authorizePermission(['student.update.all']), updateRollNumber);

router.post('/update-status', authenticate, authorizePermission(['student.update.all']), updateStudentStatus);

router.post('/scholarship-eligibility', authenticate, authorizePermission(['scholarship.update.all']), validateRequest(setEligibleScholarshipSchema), setScholarshipEligibility);

router.post('/update-personal-details', authenticate, authorizePermission(['student.update.all']), validateRequest(updateStudentPersonalDetailsSchema), updateStudentPersonalDetails);

router.get('/details/:studentId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentIdParamSchema), getStudentDetails);

router.get('/detailsByAppId/:applicationId', authenticate, authorizePermission(['student.read.all']), getStudentDetailsByApplicationId);

router.put('/academic-qualifications/:id', authenticate, authorizePermission(['student.update.all']), validateRequest(updateAcademicQualificationSchema), updateAcademicQualification);

router.delete('/academic-qualifications/:id', authenticate, authorizePermission(['student.update.all']), validateRequest(deleteAcademicQualificationSchema), deleteAcademicQualification);

router.post('/student-scholarship', authenticate, authorizePermission(['scholarship.update.all']), updateStudentScholarship);

router.put('/student-scholarship/:id', authenticate, authorizePermission(['scholarship.update.all']), editStudentScholarship);

router.get('/scholarship-stats', authenticate, authorizePermission(['scholarship.read.all']), getScholarshipStats);

router.get('/student-scholarship/:studentId', authenticate, authorizePermission(['scholarship.read.all']), getStudentScholarships);

router.post('/send-status-email', authenticate, authorizePermission(['student.update.all']), sendStatusEmail);

router.post('/reverse-admission-payment', authenticate, authorizePermission(['student.delete.all']), reverseAdmissionPayment);

router.post('/assign-pro', authenticate, authorizePermission(['student.update.all']), validateRequest(assignProSchema), assignPro);

router.patch('/edit-pro', authenticate, authorizePermission(['pro.update.all']), validateRequest(editProSchema), editPro);

router.patch('/seat-alloted-by', authenticate, authorizePermission(['student.update.all']), validateRequest(updateSeatAllotedBySchema), updateSeatAllotedBy);

router.post('/waiting-list', authenticate, authorizePermission(['student.update.all']), addToWaitingList);

router.get('/waiting-list', authenticate, authorizePermission(['student.read.all']), getWaitingList);

router.get('/waiting-list/export', authenticate, authorizePermission(['student.read.all']), exportWaitingListExcel);

router.get('/waiting-list/entry/:waitingListId', authenticate, authorizePermission(['student.read.all']), getWaitingListEntry);

router.get('/waiting-list/:studentId', authenticate, authorizePermission(['student.read.all']), getStudentWaitingList);

router.post('/waiting-list/allot', authenticate, authorizePermission(['student.update.all']), allotFromWaitingList);

router.post('/waiting-list/remove', authenticate, authorizePermission(['student.update.all']), removeFromWaitingList);

router.post('/:studentId/reconcile-fees', authenticate, authorizePermission(['student.update.all']), reconcileStudentFees);

export default router;
