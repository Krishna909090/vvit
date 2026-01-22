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
    deleteAcademicQualification,
    updateStudentScholarship,
    getStudentScholarships,
    getScholarshipStats,
    editStudentScholarship,
    downloadApplication,
    finalizeAdmission,
    verifyPayment
} from './studentManagement.controller';
import {
    getAllApplicationsSchema, requestCancellationSchema, approveCancellationSchema,
    verifyAndAllotSeatSchema, changeCourseSchema, approveCourseChangeSchema,
    updateAdmissionDetailsSchema, studentIdParamSchema,
    setEligibleScholarshipSchema,
    updateStudentPersonalDetailsSchema,
    updateAcademicQualificationSchema,
    deleteAcademicQualificationSchema,
    finalizeAdmissionSchema
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
router.get('/applications', authenticate, authorizePermission(['student.read.all']), validateRequest(getAllApplicationsSchema), getAllApplications);

router.post('/upload-applications', authenticate, authorizePermission(['student.create.all']), upload.single('file'), uploadBulkApplications);

// Cancellation
router.post('/request-cancellation', authenticate, authorizePermission(['student.update.all']), validateRequest(requestCancellationSchema), requestCancellation);

router.post('/approve-cancellation', authenticate, authorizePermission(['student.update.all']), validateRequest(approveCancellationSchema), approveCancellation);

// Seat & Course Change
router.post('/verify-allot', authenticate, authorizePermission(['student.update.all']), validateRequest(verifyAndAllotSeatSchema), verifyAndAllotSeat);

router.post('/change-course', authenticate, authorizePermission(['student.update.all']), validateRequest(changeCourseSchema), requestCourseChange);

router.post('/approve-course-change', authenticate, authorizePermission(['student.update.all']), validateRequest(approveCourseChangeSchema), approveCourseChange);

// Admission Details
router.post('/update-admission', authenticate, authorizePermission(['student.update.all']), validateRequest(updateAdmissionDetailsSchema), updateAdmissionDetails);

// Finalize Admission
router.post('/finalize-admission', authenticate, authorizePermission(['student.update.all']), validateRequest(finalizeAdmissionSchema), finalizeAdmission);
router.post('/verify-payment', authenticate, authorizePermission(['student.update.all']), verifyPayment);



// Documents
router.get('/certificates/:studentId', authenticate, authorizePermission(['document.read.all']), validateRequest(studentIdParamSchema), getStudentCertificates);

router.get('/download-documents/:studentId', authenticate, authorizePermission(['document.read.all']), validateRequest(studentIdParamSchema), downloadStudentDocuments);

router.get('/application-pdf/:studentId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentIdParamSchema), downloadApplication);

router.post('/verify-document/:studentId', authenticate, authorizePermission(['document.update.all']), verifyStudentDocument);

// Document Requirements Management (from documentController)
router.post('/document-requirements', authenticate, authorizePermission(['document.create.all']), addRequirement);
router.get('/document-requirements', authenticate, authorizePermission(['document.read.all']), listRequirements);

router.put('/document-requirements/:id', authenticate, authorizePermission(['document.update.all']), updateRequirement);
router.delete('/document-requirements/:id', authenticate, authorizePermission(['document.delete.all']), removeRequirement);

// Enrollment
router.post('/update-roll-number', authenticate, authorizePermission(['student.update.all']), updateRollNumber);

// Manual Status Update
router.post('/update-status', authenticate, authorizePermission(['student.update.all']), updateStudentStatus);

// Scholarship Eligibility
router.post('/scholarship-eligibility', authenticate, authorizePermission(['scholarship.update.all']), validateRequest(setEligibleScholarshipSchema), setScholarshipEligibility);

// Update Personal Details
router.post('/update-personal-details', authenticate, authorizePermission(['student.update.all']), validateRequest(updateStudentPersonalDetailsSchema), updateStudentPersonalDetails);

// Get Complete Student Details
router.get('/details/:studentId', authenticate, authorizePermission(['student.read.all']), validateRequest(studentIdParamSchema), getStudentDetails);

// Academic Qualifications Management
router.put('/academic-qualifications/:id', authenticate, authorizePermission(['student.update.all']), validateRequest(updateAcademicQualificationSchema), updateAcademicQualification);
router.delete('/academic-qualifications/:id', authenticate, authorizePermission(['student.update.all']), validateRequest(deleteAcademicQualificationSchema), deleteAcademicQualification);

// Student Scholarship Management
router.post('/student-scholarship', authenticate, authorizePermission(['scholarship.update.all']), updateStudentScholarship);
router.put('/student-scholarship/:id', authenticate, authorizePermission(['scholarship.update.all']), editStudentScholarship);
router.get('/scholarship-stats', authenticate, authorizePermission(['scholarship.read.all']), getScholarshipStats);
router.get('/student-scholarship/:studentId', authenticate, authorizePermission(['scholarship.read.all']), getStudentScholarships);

export default router;
