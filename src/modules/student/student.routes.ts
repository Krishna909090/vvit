import { Router } from 'express';
import {
    registerStudent,
    getHallTicket,
    uploadDocumentsAndPreferences,
    getStudentDetails,
    addAcademicDetails,
    selectExam,
    updatePersonalDetails,
    getApplicationSummary,
    requestServiceChange,
    updateProfilePhoto
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
router.post('/register', authenticate, authorizePermission(['student.create.own', 'student.create.all']), validateRequest(registerStudentSchema), registerStudent);

// Student specific
router.post('/:studentId/pay-test-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payTestFee);

router.get('/:studentId/hall-ticket', authenticate, authorizePermission(['student.read.own', 'student.read.all']), validateRequest(studentIdParamSchema), getHallTicket);

router.post('/:studentId/upload-docs', authenticate, authorizePermission(['document.create.own', 'document.create.all', 'info.update.own', 'info.update.all']), validateRequest(uploadDocumentsAndPreferencesSchema), uploadDocumentsAndPreferences); // upload docs is document.create/update or student.update? Let's use document.create + student.update. Assuming document.create covers it.

router.post('/:studentId/pay-token-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payTokenFee);

router.post('/:studentId/pay-college-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payCollegeFee);





router.post('/:studentId/academic-details', authenticate, authorizePermission(['student.update.own', 'student.update.all', 'qualification.create.own', 'qualification.create.all']), validateRequest(addAcademicDetailsSchema), addAcademicDetails);



// ... existing routes ...

// Select Exam
router.post('/:studentId/select-exam', authenticate, authorizePermission(['student.update.own', 'student.update.all', 'exam.update.own', 'exam.update.all']), validateRequest(selectExamSchema), selectExam);
router.get('/exam-slots', authenticate, authorizePermission(['exam.read.own', 'exam.read.all']), getAvailableSlots);



// Get Document Requirements
router.get('/document-requirements', authenticate, authorizePermission(['document.read.own', 'document.read.all']), getMyRequirements);



// Delete Document
router.delete('/:studentId/document', authenticate, authorizePermission(['document.delete.own', 'document.delete.all']), deleteStudentDocument);

router.get('/details', authenticate, authorizePermission(['student.read.own', 'student.read.all']), getStudentDetails);

router.post('/:studentId/personal-details', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(updatePersonalDetailsSchema), updatePersonalDetails);

router.get('/:studentId/application-summary', authenticate, authorizePermission(['student.read.own', 'student.read.all']), validateRequest(studentIdParamSchema), getApplicationSummary);

router.post('/:studentId/service-preferences', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(studentIdParamSchema), requestServiceChange);

// Update Profile Photo
router.post('/:studentId/update-photo', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(studentIdParamSchema), updateProfilePhoto);

export default router;
