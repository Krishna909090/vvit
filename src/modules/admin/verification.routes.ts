import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
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
    authorize([Role.VERIFICATION_OFFICER, Role.ADMIN, Role.SUPER_ADMIN]), 
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
    authorize([Role.VERIFICATION_OFFICER, Role.ADMIN, Role.SUPER_ADMIN]), 
    validateRequest(setEligibleScholarshipSchema),
    setScholarshipEligibility
);

export default router;
