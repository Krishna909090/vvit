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

import { authorizePermission, authenticate } from '../../middleware/rbac.middleware';

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
// Public or Agent/Student accessible
router.post('/register', authenticate, authorizePermission('student.create.own'), validateRequest(registerStudentSchema), registerStudent);

// Student specific
router.post('/:studentId/pay-test-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payTestFee); // Payment creates transaction

router.get('/:studentId/hall-ticket', authenticate, authorizePermission(['exam.read.own', 'exam.read.all']), validateRequest(studentIdParamSchema), getHallTicket); // Hall Ticket is Exam module

router.post('/:studentId/upload-docs', authenticate, authorizePermission(['document.create.own', 'document.create.all']), validateRequest(uploadDocumentsAndPreferencesSchema), uploadDocumentsAndPreferences); // Upload creates docs

router.post('/:studentId/pay-token-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payTokenFee);

router.post('/:studentId/pay-college-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payCollegeFee);





router.post('/:studentId/academic-details', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(addAcademicDetailsSchema), addAcademicDetails); // Adds details to existing student



// ... existing routes ...

// Select Exam
router.post('/:studentId/select-exam', authenticate, authorizePermission(['exam.create.own', 'exam.create.all']), validateRequest(selectExamSchema), selectExam); // Creates exam selection
router.get('/exam-slots', authenticate, authorizePermission(['exam.read.own', 'exam.read.all']), getAvailableSlots);



// Get Document Requirements
router.get('/document-requirements', authenticate, authorizePermission(['document.read.own', 'document.read.all']), getMyRequirements);



// Delete Document
router.delete('/:studentId/document', authenticate, authorizePermission(['document.delete.own', 'document.delete.all']), deleteStudentDocument);

router.get('/details', authenticate, authorizePermission(['student.read.own', 'student.read.all']), getStudentDetails);

router.post('/:studentId/personal-details', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(updatePersonalDetailsSchema), updatePersonalDetails); // Updates personal details

export default router;
