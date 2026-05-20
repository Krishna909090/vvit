import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import { submitVerificationSchema, setEligibleScholarshipSchema } from '../../validators/adminValidators';
import { AdminStudentService } from './adminStudent.service';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { setScholarshipEligibility, validateAcademicQualification } from './studentManagement.controller';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  SCORE VERIFICATION
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /submit-scores
 * @desc    Submits or updates verified exam/entrance scores for a student.
 *          Side-effect: persists the scores and marks them as admin-verified,
 *          which may trigger downstream eligibility recalculations.
 * @access  Requires `admission.update.all` permission.
 * @body    {object} Validated against `submitVerificationSchema` -
 *          { studentId: string, ...scores } where scores are key-value pairs of score fields.
 * @returns {object} 200 - { success: true, message, data: updatedScoresRecord }.
 */
router.post('/submit-scores',
    authenticate,
    authorizePermission('admission.update.all'),
    validateRequest(submitVerificationSchema),
    catchAsync(async (req, res) => {
        const { studentId, ...scores } = req.body;
        const result = await AdminStudentService.updateStudentScores(studentId, scores, req.user!.userId);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: 'Student scores verification updated successfully',
            data: result
        });
    })
);

// ═══════════════════════════════════════════════════════════
//  SCHOLARSHIP ELIGIBILITY
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /scholarship-eligibility
 * @desc    Sets or updates the scholarship eligibility flag for a student.
 *          Side-effect: marks the student as eligible/ineligible, affecting
 *          downstream scholarship allocation workflows.
 * @access  Requires `scholarship.update.all` permission.
 * @body    {object} Validated against `setEligibleScholarshipSchema` -
 *          { studentId: string, eligible: boolean, scholarshipType?, remarks? }.
 * @returns {object} 200 - Updated eligibility status for the student.
 */
router.post('/scholarship-eligibility',
    authenticate,
    authorizePermission('scholarship.update.all'),
    validateRequest(setEligibleScholarshipSchema),
    setScholarshipEligibility
);

// ═══════════════════════════════════════════════════════════
//  ACADEMIC QUALIFICATION VALIDATION
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /qualification/:id/validate
 * @desc    Validates a student's academic qualification record (e.g., degree, marks, board).
 *          Side-effect: updates the qualification's validation status, which may
 *          gate admission or seat-allocation steps.
 * @access  Requires `admission.update.all` permission.
 * @params  {string} id - The academic qualification record's unique ID.
 * @body    {object} Optional validation payload (remarks, override flags, etc.).
 * @returns {object} 200 - Validation result with updated qualification record.
 */
router.post('/qualification/:id/validate',
    authenticate,
    authorizePermission('admission.update.all'),
    validateAcademicQualification
);

export default router;
