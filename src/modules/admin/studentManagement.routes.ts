import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getAllApplications, uploadBulkApplications, requestCancellation, approveCancellation,
    verifyAndAllotSeat, verifyStudentDocument, requestCourseChange, approveCourseChange,
    updateAdmissionDetails, getStudentCertificates, downloadStudentDocuments, updateRollNumber,
    updateStudentStatus,
    setScholarshipEligibility,
    updateStudentPersonalDetails,
    getStudentDetails,
    updateAcademicQualification,
    deleteAcademicQualification
} from './studentManagement.controller';
import {
    getAllApplicationsSchema, requestCancellationSchema, approveCancellationSchema,
    verifyAndAllotSeatSchema, changeCourseSchema, approveCourseChangeSchema,
    updateAdmissionDetailsSchema, studentIdParamSchema,
    setEligibleScholarshipSchema,
    updateStudentPersonalDetailsSchema,
    updateAcademicQualificationSchema,
    deleteAcademicQualificationSchema
} from '../../validators/adminValidators';
import upload from '../../config/multer';
import {
    addRequirement,
    listRequirements,
    updateRequirement,
    removeRequirement
} from '../document/document.controller';

const router = Router();

// Applications
// Applications
router.get('/applications', authenticate, authorizePermission('student.approve'), validateRequest(getAllApplicationsSchema), getAllApplications);

router.post('/upload-applications', authenticate, authorizePermission('student.create'), upload.single('file'), uploadBulkApplications);

// Cancellation
router.post('/request-cancellation', authenticate, authorizePermission('student.update.profile'), validateRequest(requestCancellationSchema), requestCancellation);

router.post('/approve-cancellation', authenticate, authorizePermission('student.approve'), validateRequest(approveCancellationSchema), approveCancellation);

// Seat & Course Change
router.post('/verify-allot', authenticate, authorizePermission('student.approve'), validateRequest(verifyAndAllotSeatSchema), verifyAndAllotSeat);

router.post('/change-course', authenticate, authorizePermission('student.update.profile'), validateRequest(changeCourseSchema), requestCourseChange);

router.post('/approve-course-change', authenticate, authorizePermission('student.approve'), validateRequest(approveCourseChangeSchema), approveCourseChange);

// Admission Details
router.post('/update-admission', authenticate, authorizePermission('student.update.profile'), validateRequest(updateAdmissionDetailsSchema), updateAdmissionDetails);

// Documents
router.get('/certificates/:studentId', authenticate, authorizePermission('student.view.profile'), validateRequest(studentIdParamSchema), getStudentCertificates);

router.get('/download-documents/:studentId', authenticate, authorizePermission('student.view.profile'), validateRequest(studentIdParamSchema), downloadStudentDocuments);

router.post('/verify-document/:studentId', authenticate, authorizePermission('verify.document.approve'), verifyStudentDocument);

// Document Requirements Management (from documentController)
router.post('/document-requirements', authenticate, authorizePermission('admin.update.all'), addRequirement);
router.get('/document-requirements', authenticate, authorizePermission(['student.view.profile', 'admin.read.all']), listRequirements);

router.put('/document-requirements/:id', authenticate, authorizePermission('admin.update.all'), updateRequirement);
router.delete('/document-requirements/:id', authenticate, authorizePermission('admin.update.all'), removeRequirement);

// Enrollment
router.post('/update-roll-number', authenticate, authorizePermission('student.update.profile'), updateRollNumber);

// Manual Status Update
router.post('/update-status', authenticate, authorizePermission('student.update.profile'), updateStudentStatus);

// Scholarship Eligibility
router.post('/scholarship-eligibility', authenticate, authorizePermission('finance.scholarship.manage'), validateRequest(setEligibleScholarshipSchema), setScholarshipEligibility);

// Update Personal Details
router.post('/update-personal-details', authenticate, authorizePermission('student.update.profile'), validateRequest(updateStudentPersonalDetailsSchema), updateStudentPersonalDetails);

// Get Complete Student Details
router.get('/details/:studentId', authenticate, authorizePermission('student.view.profile'), validateRequest(studentIdParamSchema), getStudentDetails);

// Academic Qualifications Management
router.put('/academic-qualifications/:id', authenticate, authorizePermission('student.update.profile'), validateRequest(updateAcademicQualificationSchema), updateAcademicQualification);
router.delete('/academic-qualifications/:id', authenticate, authorizePermission('student.update.profile'), validateRequest(deleteAcademicQualificationSchema), deleteAcademicQualification);

export default router;
