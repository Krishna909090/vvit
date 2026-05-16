import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import * as controller from './qualificationRequirement.controller';
import { createQualificationRequirementSchema, updateQualificationRequirementSchema } from '../../validators/qualificationRequirementValidators';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  QUALIFICATION REQUIREMENT — READ
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /
 * @desc    Retrieve all qualification requirements (e.g. minimum marks, required exams).
 *          Accessible by admins and students who need to see admission criteria.
 * @access  Requires `qualification.read.all`, `student.create.own`, or `student.create.all` permission.
 * @returns {{ success: boolean, data: QualificationRequirement[] }} Array of requirement records.
 */
router.get(
    '/',
    authenticate,
    authorizePermission(['qualification.read.all', 'student.create.own', 'student.create.all']), // Students need to see reqs
    controller.getQualificationRequirements
);

/**
 * @route   GET /:id
 * @desc    Retrieve a single qualification requirement by its ID.
 * @access  Requires `qualification.read.all`, `student.create.own`, or `student.create.all` permission.
 * @param   {string} id — The qualification requirement ID.
 * @returns {{ success: boolean, data: QualificationRequirement }} The matching requirement record.
 */
router.get(
    '/:id',
    authenticate,
    authorizePermission(['qualification.read.all', 'student.create.own', 'student.create.all']),
    controller.getQualificationRequirementById
);

// ═══════════════════════════════════════════════════════════
//  QUALIFICATION REQUIREMENT — ADMIN CRUD
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /
 * @desc    Create a new qualification requirement for admission eligibility.
 * @access  Requires `qualification.create.all` permission.
 * @body    { name, examType, minScore, ... } — validated against createQualificationRequirementSchema.
 * @returns {{ success: boolean, data: QualificationRequirement }} The newly created requirement.
 */
router.post(
    '/',
    authenticate,
    authorizePermission('qualification.create.all'),
    validateRequest(createQualificationRequirementSchema),
    controller.createQualificationRequirement
);

/**
 * @route   PUT /:id
 * @desc    Update an existing qualification requirement.
 * @access  Requires `qualification.update.all` permission.
 * @param   {string} id — The qualification requirement ID.
 * @body    Fields to update — validated against updateQualificationRequirementSchema.
 * @returns {{ success: boolean, data: QualificationRequirement }} The updated requirement.
 */
router.put(
    '/:id',
    authenticate,
    authorizePermission('qualification.update.all'),
    validateRequest(updateQualificationRequirementSchema),
    controller.updateQualificationRequirement
);

/**
 * @route   DELETE /:id
 * @desc    Delete a qualification requirement.
 * @access  Requires `qualification.delete.all` permission.
 * @param   {string} id — The qualification requirement ID.
 * @returns {{ success: boolean, message: string }}
 */
router.delete(
    '/:id',
    authenticate,
    authorizePermission('qualification.delete.all'),
    controller.deleteQualificationRequirement
);

// ═══════════════════════════════════════════════════════════
//  QUALIFICATION — VALIDATION
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /validate
 * @desc    Validate a student's qualifications against the configured requirements.
 *          Returns pass/fail status and details of any unmet criteria.
 * @access  Authenticated users (no specific permission guard — open to all authenticated users).
 * @body    { studentId, qualifications: [...] } — student qualification data to check.
 * @returns {{ success: boolean, data: { isEligible: boolean, results: ValidationResult[] } }}
 */
router.post(
    '/validate',
    authenticate,
    // authorizePermission(['admin.read.all', 'student.view.profile']), // All can validate
    controller.validate
);

export default router;
