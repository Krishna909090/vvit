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

// ─────────────────────────────────────────────────────────────────────────
// Subject (curriculum) — uses `academic.*` permission scope (curriculum data)
// ─────────────────────────────────────────────────────────────────────────

/**
 * POST /admin/marks/subjects
 * Create a curriculum subject under (Course, Specialization?, Semester).
 * Body: { code, name, courseId, specializationId?, semester, credits?, examType?,
 *         maxInternalMarks?, maxExternalMarks?, maxTotalMarks?, isElective? }
 * Conflict: returns 409 if (courseId, specializationId, semester, code) exists.
 */
router.post('/subjects',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(createSubjectSchema), createSubject);

/**
 * GET /admin/marks/subjects
 * List subjects. Query: { courseId?, specializationId?, semester?, examType?, isElective? }
 * Pass `specializationId=null` (string) to filter for shared-across-specializations subjects.
 */
router.get('/subjects',
    authenticate, authorizePermission('academic.read.all'),
    listSubjects);

/**
 * PUT /admin/marks/subjects/:id
 * Update a subject. Cannot change (courseId, specializationId, semester) — create a new one.
 */
router.put('/subjects/:id',
    authenticate, authorizePermission('academic.update.all'),
    validateRequest(updateSubjectSchema), updateSubject);

/**
 * DELETE /admin/marks/subjects/:id
 * Soft-deletes a subject. Blocked if any non-deleted SemesterMark references it.
 */
router.delete('/subjects/:id',
    authenticate, authorizePermission('academic.delete.all'),
    deleteSubject);

// ─────────────────────────────────────────────────────────────────────────
// SemesterMark
// ─────────────────────────────────────────────────────────────────────────

/**
 * POST /admin/marks/record
 * Record one mark for (student, subject, academicYear, attempt).
 * Validates: subject exists, enrollment exists for (student, year) (any status),
 *            non-PENDING status requires a grade, marks within subject ceilings.
 * 409 if (student, subject, year, attempt) already exists.
 * Body: { studentId, subjectId, academicYearId, internalMarks?, externalMarks?,
 *         totalMarks?, grade?, gradePoints?, status?, attemptNumber?,
 *         isSupplementary?, remarks?, isBackfilled? }
 */
router.post('/record',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(recordMarkSchema), recordMark);

/**
 * POST /admin/marks/record-bulk
 * Bulk-record marks for one student across many subjects (typical: full semester transcript).
 * Per-row failures don't kill the batch; response lists outcomes per subject.
 * Body: { studentId, academicYearId, marks: [{ subjectId, ... }] }
 */
router.post('/record-bulk',
    authenticate, authorizePermission('academic.create.all'),
    validateRequest(recordMarksBulkSchema), recordMarksBulk);

/**
 * PUT /admin/marks/:id
 * Update an existing mark (revaluation result update, status flip, etc.).
 * Cannot change (studentId, subjectId, academicYearId, attemptNumber) — create a new attempt instead.
 */
router.put('/:id',
    authenticate, authorizePermission('academic.update.all'),
    validateRequest(updateMarkSchema), updateMark);

/**
 * DELETE /admin/marks/:id
 * Soft-deletes a mark.
 */
router.delete('/:id',
    authenticate, authorizePermission('academic.delete.all'),
    deleteMark);

/**
 * GET /admin/marks/student/:studentId
 * Full transcript for a student. Returns per-semester breakdown + SGPA + overall CGPA.
 * Computes from "best attempt per subject" (highest attemptNumber wins).
 * Query: { academicYearId?, semester? }
 */
router.get('/student/:studentId',
    authenticate, authorizePermission('academic.read.all'),
    getStudentMarks);

/**
 * GET /admin/marks/semester
 * Marks roll for (academicYearId, semester) — admin view of all students.
 * Query: { academicYearId, semester, subjectId?, status?, courseId?, specializationId? }
 */
router.get('/semester',
    authenticate, authorizePermission('academic.read.all'),
    getSemesterMarks);

export default router;
