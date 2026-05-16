import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import * as scholarshipController from './scholarship.controller';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  SCHOLARSHIP RULES (CRUD)
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /rules
 * @desc    Creates a new scholarship rule definition.
 *          Side-effect: newly created rules become available for eligibility checks immediately.
 * @access  Requires `scholarship.create.all` permission.
 * @body    {object} Scholarship rule payload - criteria, amount, category, etc.
 * @returns {object} 201 - The newly created scholarship rule record.
 */
router.post('/rules', authenticate, authorizePermission('scholarship.create.all'), scholarshipController.createScholarshipRule);

/**
 * @route   GET /rules
 * @desc    Retrieves all scholarship rules, optionally filtered by category or status.
 *          Accessible to users with read-all or read-own permission.
 * @access  Requires `scholarship.read.all` or `scholarship.read.own` permission.
 * @returns {object} 200 - Array of scholarship rule records.
 */
router.get('/rules', authenticate, authorizePermission(['scholarship.read.all', 'scholarship.read.own']), scholarshipController.getScholarshipRules);

/**
 * @route   PUT /rules/:id
 * @desc    Updates an existing scholarship rule by ID.
 *          Side-effect: changes may affect future eligibility evaluations for students.
 * @access  Requires `scholarship.update.all` permission.
 * @params  {string} id - The scholarship rule's unique ID.
 * @body    {object} Fields to update (criteria, amount, category, etc.).
 * @returns {object} 200 - Updated scholarship rule record.
 */
router.put('/rules/:id', authenticate, authorizePermission('scholarship.update.all'), scholarshipController.updateScholarshipRule);

/**
 * @route   DELETE /rules/:id
 * @desc    Deletes a scholarship rule by ID.
 *          Side-effect: the rule will no longer be evaluated during eligibility checks.
 * @access  Requires `scholarship.delete.all` permission.
 * @params  {string} id - The scholarship rule's unique ID.
 * @returns {object} 200 - Confirmation of deletion.
 */
router.delete('/rules/:id', authenticate, authorizePermission('scholarship.delete.all'), scholarshipController.deleteScholarshipRule);

// ═══════════════════════════════════════════════════════════
//  ELIGIBILITY CHECK & VERIFICATION
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /check-eligibility/:studentId
 * @desc    Evaluates a student against all active scholarship rules and returns matching results.
 *          This is a read-only check; it does not allocate or persist any scholarship.
 * @access  Requires `scholarship.read.all` or `scholarship.read.own` permission.
 * @params  {string} studentId - The student's unique ID.
 * @returns {object} 200 - { eligible: boolean, matchedRules: [...] }.
 */
router.get('/check-eligibility/:studentId', authenticate, authorizePermission(['scholarship.read.all', 'scholarship.read.own']), scholarshipController.checkEligibility);

/**
 * @route   POST /verify-eligibility
 * @desc    Officer-level verification of a student's scholarship eligibility.
 *          Side-effect: marks the eligibility record as verified/rejected by the officer.
 * @access  Requires `scholarship.update.all` permission.
 * @body    {object} { studentId, ruleId, verified: boolean, remarks? } - verification payload.
 * @returns {object} 200 - Updated eligibility verification record.
 */
router.post('/verify-eligibility', authenticate, authorizePermission('scholarship.update.all'), scholarshipController.verifyEligibility);

// ═══════════════════════════════════════════════════════════
//  SCHOLARSHIP ALLOCATION & RECONCILIATION
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /allocate
 * @desc    Allocates a scholarship to a student based on a verified eligibility record.
 *          Side-effect: creates a scholarship allocation entry and may adjust the student's fee balance.
 * @access  Requires `scholarship.create.all` permission.
 * @body    {object} { studentId, ruleId, amount?, ... } - allocation details.
 * @returns {object} 201 - Scholarship allocation confirmation with allocated amount.
 */
router.post('/allocate', authenticate, authorizePermission('scholarship.create.all'), scholarshipController.allocateScholarship);

/**
 * @route   POST /update-student-scholarship
 * @desc    Updates or reconciles an existing scholarship allocation for a student.
 *          Used for post-allocation corrections such as amount adjustments or status changes.
 * @access  Requires `scholarship.update.all` permission.
 * @body    {object} { studentId, scholarshipId, amount?, status?, remarks? } - fields to reconcile.
 * @returns {object} 200 - Updated scholarship allocation record.
 */
router.post('/update-student-scholarship', authenticate, authorizePermission('scholarship.update.all'), scholarshipController.updateStudentScholarship);

export default router;
