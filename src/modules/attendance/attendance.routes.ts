import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import {
    markAttendance, markClassAttendance, markAttendanceBackfill,
    updateAttendance, deleteAttendance,
    getStudentAttendance, getClassAttendance, getAttendanceStats,
} from './attendance.controller';
import {
    markAttendanceSchemaV2, markClassAttendanceSchema, markAttendanceBackfillSchema, updateAttendanceSchema,
} from '../../validators/adminValidators';

const router = Router();

router.post('/mark',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(markAttendanceSchemaV2), markAttendance);

router.post('/mark-class',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(markClassAttendanceSchema), markClassAttendance);

router.post('/back-fill',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(markAttendanceBackfillSchema), markAttendanceBackfill);

router.put('/:id',
    authenticate, authorizePermission('academic.update.all'),
    validateRequest(updateAttendanceSchema), updateAttendance);

router.delete('/:id',
    authenticate, authorizePermission('academic.delete.all'),
    deleteAttendance);

router.get('/student/:studentId',
    authenticate, authorizePermission('academic.read.all'),
    getStudentAttendance);

router.get('/class',
    authenticate, authorizePermission('academic.read.all'),
    getClassAttendance);

router.get('/stats/:studentId',
    authenticate, authorizePermission('academic.read.all'),
    getAttendanceStats);

export default router;
