import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { submitVerificationSchema, setEligibleScholarshipSchema } from '../../validators/adminValidators';
import { AdminStudentService } from './adminStudent.service';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { MESSAGES } from '../../constants/messages';
import { setScholarshipEligibility } from './studentManagement.controller';

const router = Router();

// Submit Verification Scores
router.post('/submit-scores', 
    authenticate, 
    authorizePermission('student.update'), 
    validateRequest(submitVerificationSchema),
    catchAsync(async (req, res) => {
        const { studentId, ...scores } = req.body;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
    authorizePermission('student.update'), 
    validateRequest(setEligibleScholarshipSchema),
    setScholarshipEligibility
);

export default router;
