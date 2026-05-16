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

/**
 * POST /auth/send-otp
 * Sends a 6-digit OTP to the provided phone number via SMS.
 * If the phone number belongs to a new user, a STUDENT account is auto-created.
 * OTP expires in 10 minutes (student) or 5 minutes (staff). Max 5 verification attempts.
 * Rate limited: 10 requests per 15 minutes per IP.
 * Body: { phone: string }
 * Response: { status, message } — OTP is sent via SMS, never returned in production response.
 */
router.post('/send-otp', authRateLimiter, validateRequest(sendOtpSchema), sendOtp);

/**
 * POST /auth/login
 * Authenticates a user using email/phone + password (for staff/admin accounts).
 * Returns a JWT token (valid 24 hours) with userId and role.
 * Rate limited: 10 requests per 15 minutes per IP.
 * Body: { identifier: string (email or phone), password: string }
 * Response: { status, token, user: { userId, role } }
 */
router.post('/login', authRateLimiter, login);

/**
 * POST /auth/verify-otp
 * Verifies the OTP sent to the user's phone number.
 * On success, returns a JWT token (valid 24 hours) with userId and role.
 * Tracks failed attempts — OTP is invalidated after 5 wrong attempts.
 * Rate limited: 10 requests per 15 minutes per IP.
 * Body: { phone: string, otp: string }
 * Response: { status, token, user: { userId, role, isNewUser } }
 */
router.post('/verify-otp', authRateLimiter, validateRequest(verifyOtpSchema), verifyOtp);

/**
 * POST /auth/aadhaar/generate-otp
 * Initiates Aadhaar KYC verification by sending an OTP to the Aadhaar-linked mobile number.
 * Uses external Aadhaar verification API. Requires student to provide their Aadhaar number.
 * Body: { aadhaarNumber: string, studentId: string }
 * Response: { status, message, transactionId } — transactionId needed for submit-otp step.
 */
router.post('/aadhaar/generate-otp', authRateLimiter, validateRequest(generateAadhaarOtpSchema), generateAadhaarOtp);

/**
 * POST /auth/aadhaar/submit-otp
 * Completes Aadhaar KYC verification by submitting the OTP received on Aadhaar-linked mobile.
 * On success, marks student as KYC verified and updates profile with Aadhaar-fetched data.
 * Body: { transactionId: string, otp: string, studentId: string }
 * Response: { status, message, kycData } — contains verified name, DOB, address from Aadhaar.
 */
router.post('/aadhaar/submit-otp', authRateLimiter, validateRequest(submitAadhaarOtpSchema), submitAadhaarOtp);

/**
 * POST /auth/logout
 * Invalidates the current JWT token by adding it to an in-memory blacklist.
 * Token remains blacklisted until its natural expiry time, then auto-cleaned.
 * Also clears the user's cached RBAC permissions.
 * Headers: Authorization: Bearer <token>
 * Response: { status, message: 'Logged out successfully' }
 */
router.post('/logout', authenticate, logout);

/**
 * POST /auth/student/login
 * Student password login by rollNumber. Resolves rollNumber via the active
 * AcademicYear and an ACTIVE StudentEnrollment. Returns JWT carrying tokenVersion.
 * If User.password is null, responds 403 directing the student to first-time setup
 * or to admin for an OTP — see /auth/student/initial-setup and /auth/student/reset-password.
 * Body: { rollNumber, password }
 */
router.post(
    '/student/login',
    authRateLimiter,
    validateRequest(studentLoginSchema),
    studentLogin
);

/**
 * POST /auth/student/initial-setup
 * One-shot self-service first-time password set. Verifies PII (DOB + Aadhaar last 4)
 * against the Student record. Only succeeds when User.password is currently null.
 * Body: { rollNumber, dob (YYYY-MM-DD), aadhaarLast4, newPassword }
 */
router.post(
    '/student/initial-setup',
    authRateLimiter,
    validateRequest(studentInitialSetupSchema),
    studentInitialSetup
);

/**
 * POST /auth/student/admin/issue-otp
 * Admin-mediated forgot-password. Generates an 8-digit OTP, valid 6 hours, with
 * issuance cooldown (10 min) and daily cap (3/student). Returns OTP plaintext to
 * admin once for in-person handoff to the student. Audit-logged.
 * Permission: student.password.reset
 * Body: { rollNumber }
 */
router.post(
    '/student/admin/issue-otp',
    authenticate,
    authorizePermission('student.password.reset'),
    validateRequest(adminIssueStudentOtpSchema),
    adminIssueStudentResetOtp
);

/**
 * POST /auth/student/reset-password
 * Student consumes an admin-issued OTP and sets a new password. Atomic attempt
 * counter; on success, password is updated and tokenVersion bumped to invalidate
 * any prior tokens. Does NOT auto-login — student must call /auth/student/login.
 * Body: { rollNumber, otp, newPassword }
 */
router.post(
    '/student/reset-password',
    authRateLimiter,
    validateRequest(studentResetPasswordSchema),
    studentResetPassword
);

export default router;
