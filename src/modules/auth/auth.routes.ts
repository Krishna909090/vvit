import { Router } from 'express';
import { sendOtp, verifyOtp, generateAadhaarOtp, submitAadhaarOtp, login, logout } from './auth.controller';
import {
    studentLogin,
    studentInitialSetup,
    adminIssueStudentResetOtp,
    studentResetPassword,
} from './student-auth.controller';
import { validateRequest } from '../../middleware/validationMiddleware';
import {
    sendOtpSchema,
    verifyOtpSchema,
    generateAadhaarOtpSchema,
    submitAadhaarOtpSchema,
    studentLoginSchema,
    studentInitialSetupSchema,
    adminIssueStudentOtpSchema,
    studentResetPasswordSchema,
} from '../../validators/authValidators';
import { authRateLimiter } from '../../middleware/rateLimitMiddleware';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

const router = Router();

router.post('/send-otp', authRateLimiter, validateRequest(sendOtpSchema), sendOtp);

router.post('/login', authRateLimiter, login);

router.post('/verify-otp', authRateLimiter, validateRequest(verifyOtpSchema), verifyOtp);

router.post('/aadhaar/generate-otp', authRateLimiter, authenticate, validateRequest(generateAadhaarOtpSchema), generateAadhaarOtp);

router.post('/aadhaar/submit-otp', authRateLimiter, authenticate, validateRequest(submitAadhaarOtpSchema), submitAadhaarOtp);

router.post('/logout', authenticate, logout);

router.post(
    '/student/login',
    authRateLimiter,
    validateRequest(studentLoginSchema),
    studentLogin
);

router.post(
    '/student/initial-setup',
    authRateLimiter,
    validateRequest(studentInitialSetupSchema),
    studentInitialSetup
);

router.post(
    '/student/admin/issue-otp',
    authenticate,
    authorizePermission('student.password.reset'),
    validateRequest(adminIssueStudentOtpSchema),
    adminIssueStudentResetOtp
);

router.post(
    '/student/reset-password',
    authRateLimiter,
    validateRequest(studentResetPasswordSchema),
    studentResetPassword
);

export default router;
