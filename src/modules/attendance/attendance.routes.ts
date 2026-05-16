import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    markAttendance, markClassAttendance, markAttendanceBackfill,
    updateAttendance, deleteAttendance,
    getStudentAttendance, getClassAttendance, getAttendanceStats,
} from './attendance.controller';
import {
    markAttendanceSchemaV2, markClassAttendanceSchema, markAttendanceBackfillSchema, updateAttendanceSchema,
} from '../../validators/adminValidators';

const router = Router();

/**
 * POST /admin/attendance/mark
 * Record attendance for one (student, subject, date, period?).
 * Body: { studentId, subjectId, academicYearId, date, periodNumber?, status, remarks?, isBackfilled? }
 * 409 if a row already exists for the slot — use PUT to update.
 */
router.post('/mark',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(markAttendanceSchemaV2), markAttendance);

/**
 * POST /admin/attendance/mark-class
 * Bulk roll-call for one (subject, date, period?). Each row is (studentId, status).
 * Per-row failures don't kill the batch.
 * Body: { subjectId, academicYearId, date, periodNumber?, isBackfilled?, rows: [{ studentId, status, remarks? }] }
 */
router.post('/mark-class',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(markClassAttendanceSchema), markClassAttendance);

/**
 * POST /admin/attendance/back-fill
 * Bulk back-fill for one student across many (date, subject) rows.
 * All rows automatically tagged isBackfilled=true.
 * Body: { studentId, academicYearId, rows: [{ subjectId, date, periodNumber?, status, remarks? }] }
 */
router.post('/back-fill',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(markAttendanceBackfillSchema), markAttendanceBackfill);

/**
 * PUT /admin/attendance/:id
 * Update an existing attendance record's status/remarks/backfill flag.
 * Cannot change (student, subject, date, period).
 */
router.put('/:id',
    authenticate, authorizePermission('academic.update.all'),
    validateRequest(updateAttendanceSchema), updateAttendance);

/**
 * DELETE /admin/attendance/:id
 * Soft-deletes an attendance record.
 */
router.delete('/:id',
    authenticate, authorizePermission('academic.delete.all'),
    deleteAttendance);

/**
 * GET /admin/attendance/student/:studentId
 * Per-student attendance log. Query: { subjectId?, academicYearId?, semester?, from?, to? }
 */
router.get('/student/:studentId',
    authenticate, authorizePermission('academic.read.all'),
    getStudentAttendance);

/**
 * GET /admin/attendance/class
 * Class roll for one (subject, date, period?). Query: { subjectId, date, periodNumber? }
 */
router.get('/class',
    authenticate, authorizePermission('academic.read.all'),
    getClassAttendance);

/**
 * GET /admin/attendance/stats/:studentId
 * Attendance % summary per subject + overall for a student.
 * ON_DUTY / EXCUSED / LATE count as "present" in the percentage.
 * Query: { subjectId?, academicYearId?, semester? }
 */
router.get('/stats/:studentId',
    authenticate, authorizePermission('academic.read.all'),
    getAttendanceStats);

export default router;
