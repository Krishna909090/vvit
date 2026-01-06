import { Router } from 'express';
import {
    registerStudent,
    getHallTicket,
    uploadDocumentsAndPreferences,
    getStudentDetails,
    addAcademicDetails,
    selectExam,
    updatePersonalDetails
} from './student.controller';
import {
    payTestFee,
    payCollegeFee,
    payTokenFee,
    requestDiscount
} from '../finance/payment.controller';

import { authenticate, authorize } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
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

// Public or Agent/Student accessible
router.post('/register', authenticate, authorize([Role.AGENT, Role.STUDENT]), validateRequest(registerStudentSchema), registerStudent);

// Student specific
router.post('/:studentId/pay-test-fee', authenticate, authorize([Role.STUDENT]), validateRequest(studentIdParamSchema), payTestFee);

router.get('/:studentId/hall-ticket', authenticate, authorize([Role.STUDENT]), validateRequest(studentIdParamSchema), getHallTicket);

router.post('/:studentId/upload-docs', authenticate, authorize([Role.STUDENT]), validateRequest(uploadDocumentsAndPreferencesSchema), uploadDocumentsAndPreferences);

router.post('/:studentId/pay-token-fee', authenticate, authorize([Role.STUDENT]), validateRequest(studentIdParamSchema), payTokenFee);

router.post('/:studentId/pay-college-fee', authenticate, authorize([Role.STUDENT]), validateRequest(studentIdParamSchema), payCollegeFee);





router.post('/:studentId/academic-details', authenticate, authorize([Role.STUDENT]), validateRequest(addAcademicDetailsSchema), addAcademicDetails);



// ... existing routes ...

// Select Exam
router.post('/:studentId/select-exam', authenticate, authorize([Role.STUDENT]), validateRequest(selectExamSchema), selectExam);
router.get('/exam-slots', authenticate, authorize([Role.STUDENT]), getAvailableSlots);



// Get Document Requirements
router.get('/document-requirements', authenticate, authorize([Role.STUDENT]), getMyRequirements);



// Delete Document
router.delete('/:studentId/document', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN]), deleteStudentDocument);

router.get('/details', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getStudentDetails);

router.post('/:studentId/personal-details', authenticate, authorize([Role.STUDENT]), validateRequest(updatePersonalDetailsSchema), updatePersonalDetails);

export default router;
