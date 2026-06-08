import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import {
    createSubject, listSubjects, updateSubject, deleteSubject,
    recordMark, recordMarksBulk, updateMark, deleteMark,
    getStudentMarks, getSemesterMarks,
} from './marks.controller';
import {
    createSubjectSchema, updateSubjectSchema,
    recordMarkSchema, recordMarksBulkSchema, updateMarkSchema,
} from '../../validators/adminValidators';

const router = Router();

router.post('/subjects',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(createSubjectSchema), createSubject);

router.get('/subjects',
    authenticate, authorizePermission('academic.read.all'),
    listSubjects);

router.put('/subjects/:id',
    authenticate, authorizePermission('academic.update.all'),
    validateRequest(updateSubjectSchema), updateSubject);

router.delete('/subjects/:id',
    authenticate, authorizePermission('academic.delete.all'),
    deleteSubject);

router.post('/record',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(recordMarkSchema), recordMark);

router.post('/record-bulk',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(recordMarksBulkSchema), recordMarksBulk);

router.put('/:id',
    authenticate, authorizePermission('academic.update.all'),
    validateRequest(updateMarkSchema), updateMark);

router.delete('/:id',
    authenticate, authorizePermission('academic.delete.all'),
    deleteMark);

router.get('/student/:studentId',
    authenticate, authorizePermission('academic.read.all'),
    getStudentMarks);

router.get('/semester',
    authenticate, authorizePermission('academic.read.all'),
    getSemesterMarks);

export default router;
