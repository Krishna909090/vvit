import { Router } from 'express';
import {
    registerStudent,
    getHallTicket,
    getHallTicketByAppId,
    uploadDocumentsAndPreferences,
    getStudentDetails,
    addAcademicDetails,
    selectExam,
    updatePersonalDetails,
    getApplicationSummary,
    requestServiceChange,
    updateProfilePhoto,
    requestCourseChange,
    reUploadDocument
} from './student.controller';
import { changeCourseSchema } from '../../validators/adminValidators';
import {
    payTestFee,
    payCollegeFee,
    payTokenFee,
} from '../finance/payment.controller';

import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
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

router.post('/register', authenticate, authorizePermission(['student.create.own', 'student.create.all']), validateRequest(registerStudentSchema), registerStudent);

router.post('/:studentId/pay-test-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payTestFee);

router.post('/:studentId/pay-token-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payTokenFee);

router.post('/:studentId/pay-college-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), validateRequest(studentIdParamSchema), payCollegeFee);

router.get('/:studentId/hall-ticket', authenticate, authorizePermission(['student.read.own', 'student.read.all']), validateRequest(studentIdParamSchema), getHallTicket);

router.get('/hall-ticket/application/:applicationId', authenticate, authorizePermission(['student.read.own', 'student.read.all']), getHallTicketByAppId);

router.post('/:studentId/select-exam', authenticate, authorizePermission(['student.update.own', 'student.update.all', 'exam.update.own', 'exam.update.all']), validateRequest(selectExamSchema), selectExam);

router.get('/exam-slots', authenticate, authorizePermission(['exam.read.own', 'exam.read.all']), getAvailableSlots);

router.post('/:studentId/upload-docs', authenticate, authorizePermission(['document.create.own', 'document.create.all', 'info.update.own', 'info.update.all']), validateRequest(uploadDocumentsAndPreferencesSchema), uploadDocumentsAndPreferences);

router.post('/:studentId/re-upload-doc', authenticate, authorizePermission(['document.create.own', 'document.create.all']), reUploadDocument);

router.post('/:studentId/academic-details', authenticate, authorizePermission(['student.update.own', 'student.update.all', 'qualification.create.own', 'qualification.create.all']), validateRequest(addAcademicDetailsSchema), addAcademicDetails);

router.get('/document-requirements', authenticate, authorizePermission(['document.read.own', 'document.read.all']), getMyRequirements);

router.delete('/:studentId/document', authenticate, authorizePermission(['document.delete.own', 'document.delete.all']), deleteStudentDocument);

router.get('/details', authenticate, authorizePermission(['student.read.own', 'student.read.all']), getStudentDetails);

router.post('/:studentId/personal-details', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(updatePersonalDetailsSchema), updatePersonalDetails);

router.get('/:studentId/application-summary', authenticate, authorizePermission(['student.read.own', 'student.read.all']), validateRequest(studentIdParamSchema), getApplicationSummary);

router.post('/:studentId/service-preferences', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(studentIdParamSchema), requestServiceChange);

router.post('/:studentId/update-photo', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(studentIdParamSchema), updateProfilePhoto);

router.post('/:studentId/course-change', authenticate, authorizePermission(['student.update.own', 'student.update.all']), validateRequest(changeCourseSchema), requestCourseChange);

export default router;
