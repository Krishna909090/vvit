import { Router } from 'express';
import { sendOtp, verifyOtp, generateAadhaarOtp, submitAadhaarOtp, login, logout } from './auth.controller';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { sendOtpSchema, verifyOtpSchema, generateAadhaarOtpSchema, submitAadhaarOtpSchema } from '../../validators/authValidators';
import { authRateLimiter } from '../../middlewares/rateLimitMiddleware';
import { authenticate } from '../../middleware/rbac.middleware';

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

export default router;
