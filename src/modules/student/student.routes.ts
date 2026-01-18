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

import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
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
router.post('/register', authenticate, authorizePermission(['student.create']), validateRequest(registerStudentSchema), registerStudent);

// Student specific
router.post('/:studentId/pay-test-fee', authenticate, authorizePermission('finance.fee.collect'), validateRequest(studentIdParamSchema), payTestFee);

router.get('/:studentId/hall-ticket', authenticate, authorizePermission('student.view.profile'), validateRequest(studentIdParamSchema), getHallTicket);

router.post('/:studentId/upload-docs', authenticate, authorizePermission('student.update.profile'), validateRequest(uploadDocumentsAndPreferencesSchema), uploadDocumentsAndPreferences);

router.post('/:studentId/pay-token-fee', authenticate, authorizePermission('finance.fee.collect'), validateRequest(studentIdParamSchema), payTokenFee);

router.post('/:studentId/pay-college-fee', authenticate, authorizePermission('finance.fee.collect'), validateRequest(studentIdParamSchema), payCollegeFee);





router.post('/:studentId/academic-details', authenticate, authorizePermission('student.update.profile'), validateRequest(addAcademicDetailsSchema), addAcademicDetails);



// ... existing routes ...

// Select Exam
router.post('/:studentId/select-exam', authenticate, authorizePermission('student.update.profile'), validateRequest(selectExamSchema), selectExam);
router.get('/exam-slots', authenticate, authorizePermission('exam.view.all'), getAvailableSlots);



// Get Document Requirements
router.get('/document-requirements', authenticate, authorizePermission('student.view.profile'), getMyRequirements);



// Delete Document
router.delete('/:studentId/document', authenticate, authorizePermission('student.update.profile'), deleteStudentDocument);

router.get('/details', authenticate, authorizePermission('student.view.profile'), getStudentDetails);

router.post('/:studentId/personal-details', authenticate, authorizePermission('student.update.profile'), validateRequest(updatePersonalDetailsSchema), updatePersonalDetails);

export default router;
