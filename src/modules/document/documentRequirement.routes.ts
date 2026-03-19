import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getDocumentRequirements,
    getDocumentRequirementById,
    createDocumentRequirement,
    updateDocumentRequirement,
    deleteDocumentRequirement,
    getStudentDocumentRequirements
} from './documentRequirement.controller';
import {
    createDocumentRequirementSchema,
    updateDocumentRequirementSchema
} from '../../validators/documentRequirementValidators';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  DOCUMENT REQUIREMENT — READ
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /
 * @desc    Retrieve all document requirements (e.g. ID proof, marksheet). Used by admins and students.
 * @access  Requires `document.read.all`, `student.create.own`, or `student.create.all` permission.
 * @returns {{ success: boolean, data: DocumentRequirement[] }} Array of requirement records.
 */
router.get(
    '/',
    authenticate,
    authorizePermission(['document.read.all', 'student.create.own', 'student.create.all']),
    getDocumentRequirements
);

/**
 * @route   GET /:id
 * @desc    Retrieve a single document requirement by its ID.
 * @access  Requires `document.read.all`, `student.create.own`, or `student.create.all` permission.
 * @param   {string} id — The document requirement ID.
 * @returns {{ success: boolean, data: DocumentRequirement }} The matching requirement record.
 */
router.get(
    '/:id',
    authenticate,
    authorizePermission(['document.read.all', 'student.create.own', 'student.create.all']),
    getDocumentRequirementById
);

// ═══════════════════════════════════════════════════════════
//  DOCUMENT REQUIREMENT — ADMIN CRUD
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /
 * @desc    Create a new document requirement that students must fulfil during admission.
 * @access  Requires `document.create.all` permission.
 * @body    { name, description, isRequired, ... } — validated against createDocumentRequirementSchema.
 * @returns {{ success: boolean, data: DocumentRequirement }} The newly created requirement.
 */
router.post(
    '/',
    authenticate,
    authorizePermission('document.create.all'),
    validateRequest(createDocumentRequirementSchema),
    createDocumentRequirement
);

/**
 * @route   PUT /:id
 * @desc    Update an existing document requirement.
 * @access  Requires `document.update.all` permission.
 * @param   {string} id — The document requirement ID.
 * @body    Fields to update — validated against updateDocumentRequirementSchema.
 * @returns {{ success: boolean, data: DocumentRequirement }} The updated requirement.
 */
router.put(
    '/:id',
    authenticate,
    authorizePermission('document.update.all'),
    validateRequest(updateDocumentRequirementSchema),
    updateDocumentRequirement
);

/**
 * @route   DELETE /:id
 * @desc    Delete a document requirement.
 * @access  Requires `document.delete.all` permission.
 * @param   {string} id — The document requirement ID.
 * @returns {{ success: boolean, message: string }}
 */
router.delete(
    '/:id',
    authenticate,
    authorizePermission('document.delete.all'),
    deleteDocumentRequirement
);

// ═══════════════════════════════════════════════════════════
//  STUDENT-SPECIFIC DOCUMENT REQUIREMENTS
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /students/:studentId
 * @desc    Retrieve document requirements applicable to a specific student, including upload status.
 * @access  Requires `document.read.all`, `student.create.own`, or `student.create.all` permission.
 * @param   {string} studentId — The student ID.
 * @returns {{ success: boolean, data: StudentDocumentRequirement[] }} Per-student requirement statuses.
 */
router.get(
    '/students/:studentId',
    authenticate,
    authorizePermission(['document.read.all', 'student.create.own', 'student.create.all']),
    getStudentDocumentRequirements
);

export default router;
