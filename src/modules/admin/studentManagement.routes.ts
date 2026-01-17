import { Router } from 'express';
import { authorizePermission, authenticate } from '../../middleware/rbac.middleware';

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
router.get('/applications', authenticate, authorizePermission('student.read'), validateRequest(getAllApplicationsSchema), getAllApplications);

router.post('/upload-applications', authenticate, authorizePermission('student.create'), upload.single('file'), uploadBulkApplications); // Import creates students

// Cancellation
router.post('/request-cancellation', authenticate, authorizePermission('student.update'), validateRequest(requestCancellationSchema), requestCancellation); // Updates status

router.post('/approve-cancellation', authenticate, authorizePermission('student.update'), validateRequest(approveCancellationSchema), approveCancellation);

// Seat & Course Change
router.post('/verify-allot', authenticate, authorizePermission('student.update'), validateRequest(verifyAndAllotSeatSchema), verifyAndAllotSeat); // Allotment updates student record

router.post('/change-course', authenticate, authorizePermission('student.update'), validateRequest(changeCourseSchema), requestCourseChange);

router.post('/approve-course-change', authenticate, authorizePermission('student.update'), validateRequest(approveCourseChangeSchema), approveCourseChange);

// Admission Details
router.post('/update-admission', authenticate, authorizePermission('student.update'), validateRequest(updateAdmissionDetailsSchema), updateAdmissionDetails);

// Documents
router.get('/certificates/:studentId', authenticate, authorizePermission('student.read'), validateRequest(studentIdParamSchema), getStudentCertificates);

router.get('/download-documents/:studentId', authenticate, authorizePermission('student.read'), validateRequest(studentIdParamSchema), downloadStudentDocuments);

router.post('/verify-document/:studentId', authenticate, authorizePermission('student.update'), verifyStudentDocument);

// Document Requirements Management (from documentController)
router.post('/document-requirements', authenticate, authorizePermission('document.create'), addRequirement);
router.get('/document-requirements', authenticate, authorizePermission('document.read'), listRequirements);

router.put('/document-requirements/:id', authenticate, authorizePermission('document.update'), updateRequirement);
router.delete('/document-requirements/:id', authenticate, authorizePermission('document.delete'), removeRequirement);

// Enrollment
router.post('/update-roll-number', authenticate, authorizePermission('student.update'), updateRollNumber);

// Manual Status Update
router.post('/update-status', authenticate, authorizePermission('student.update'), updateStudentStatus);

// Scholarship Eligibility
router.post('/scholarship-eligibility', authenticate, authorizePermission('student.update'), validateRequest(setEligibleScholarshipSchema), setScholarshipEligibility);

// Update Personal Details
router.post('/update-personal-details', authenticate, authorizePermission('student.update'), validateRequest(updateStudentPersonalDetailsSchema), updateStudentPersonalDetails);

// Get Complete Student Details
router.get('/details/:studentId', authenticate, authorizePermission('student.read'), validateRequest(studentIdParamSchema), getStudentDetails);

// Academic Qualifications Management
router.put('/academic-qualifications/:id', authenticate, authorizePermission('student.update'), validateRequest(updateAcademicQualificationSchema), updateAcademicQualification);
router.delete('/academic-qualifications/:id', authenticate, authorizePermission('student.delete'), validateRequest(deleteAcademicQualificationSchema), deleteAcademicQualification);

export default router;
