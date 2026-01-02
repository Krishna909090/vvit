import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getAllApplications, uploadBulkApplications, requestCancellation, approveCancellation,
    verifyAndAllotSeat, verifyStudentDocument, requestCourseChange, approveCourseChange,
    updateAdmissionDetails, getStudentCertificates, downloadStudentDocuments, updateRollNumber,
    updateStudentStatus,
    setScholarshipEligibility,
    updateStudentPersonalDetails
} from './studentManagement.controller';
import {
    getAllApplicationsSchema, requestCancellationSchema, approveCancellationSchema,
    verifyAndAllotSeatSchema, changeCourseSchema, approveCourseChangeSchema,
    updateAdmissionDetailsSchema, studentIdParamSchema,
    setEligibleScholarshipSchema,
    updateStudentPersonalDetailsSchema
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
router.get('/applications', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(getAllApplicationsSchema), getAllApplications);

router.post('/upload-applications', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), upload.single('file'), uploadBulkApplications);

// Cancellation
router.post('/request-cancellation', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(requestCancellationSchema), requestCancellation);

router.post('/approve-cancellation', authenticate, authorize([Role.SUPER_ADMIN]), validateRequest(approveCancellationSchema), approveCancellation);

// Seat & Course Change
router.post('/verify-allot', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(verifyAndAllotSeatSchema), verifyAndAllotSeat);

router.post('/change-course', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(changeCourseSchema), requestCourseChange);

router.post('/approve-course-change', authenticate, authorize([Role.SUPER_ADMIN]), validateRequest(approveCourseChangeSchema), approveCourseChange);

// Admission Details
router.post('/update-admission', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateAdmissionDetailsSchema), updateAdmissionDetails);

// Documents
router.get('/certificates/:studentId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(studentIdParamSchema), getStudentCertificates);

router.get('/download-documents/:studentId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(studentIdParamSchema), downloadStudentDocuments);

router.post('/verify-document/:studentId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), verifyStudentDocument);

// Document Requirements Management (from documentController)
router.post('/document-requirements', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), addRequirement);
router.get('/document-requirements', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), listRequirements);

router.put('/document-requirements/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateRequirement);
router.delete('/document-requirements/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), removeRequirement);

// Enrollment
router.post('/update-roll-number', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateRollNumber);

// Manual Status Update
router.post('/update-status', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateStudentStatus);

// Scholarship Eligibility
router.post('/scholarship-eligibility', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(setEligibleScholarshipSchema), setScholarshipEligibility);

// Update Personal Details
router.post('/update-personal-details', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateStudentPersonalDetailsSchema), updateStudentPersonalDetails);

export default router;
