import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { submitVerificationSchema, setEligibleScholarshipSchema } from '../../validators/adminValidators';
import { AdminStudentService } from './adminStudent.service';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { MESSAGES } from '../../constants/messages';
import { setScholarshipEligibility, validateAcademicQualification } from './studentManagement.controller';

const router = Router();

// Submit Verification Scores
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

// Set Scholarship Eligibility (Reuse existing controller logic)
router.post('/scholarship-eligibility', 
    authenticate, 
    authorizePermission('scholarship.update.all'), 
    validateRequest(setEligibleScholarshipSchema),
    setScholarshipEligibility
);

// Validate Academic Qualification
router.post('/qualification/:id/validate', 
    authenticate, 
    authorizePermission('admission.update.all'), 
    validateAcademicQualification
);

export default router;
