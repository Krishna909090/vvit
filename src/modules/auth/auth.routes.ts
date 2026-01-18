import { Router } from 'express';
import { sendOtp, verifyOtp, generateAadhaarOtp, submitAadhaarOtp, login } from './auth.controller';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { sendOtpSchema, verifyOtpSchema, generateAadhaarOtpSchema, submitAadhaarOtpSchema } from '../../validators/authValidators';

const router = Router();


/**
 * This API related to authentication of users
 */
router.post('/send-otp', validateRequest(sendOtpSchema), sendOtp);

/**
 *  This API related to authentication of users
 */
router.post('/login', login);

/**
 * This API related to authentication of users
 */
router.post('/verify-otp', validateRequest(verifyOtpSchema), verifyOtp);

/**
 * This API related to authentication of users
 */
router.post('/aadhaar/generate-otp', validateRequest(generateAadhaarOtpSchema), generateAadhaarOtp);

router.post('/aadhaar/submit-otp', validateRequest(submitAadhaarOtpSchema), submitAadhaarOtp);

export default router;
