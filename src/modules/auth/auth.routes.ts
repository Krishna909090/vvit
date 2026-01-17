import { Router } from 'express';
import { sendOtp, verifyOtp, generateAadhaarOtp, submitAadhaarOtp, login } from './auth.controller';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { sendOtpSchema, verifyOtpSchema, generateAadhaarOtpSchema, submitAadhaarOtpSchema } from '../../validators/authValidators';

const router = Router();

router.post('/send-otp', validateRequest(sendOtpSchema), sendOtp);

/**
 * This API is for the Super Admin and Admin to login with EMAIL and PASSWORD
 * 
 * @param {string} email - The email of the user
 * @param {string} password - The password of the user
 * @returns {object} - The response object
 */
router.post('/login', login);


/**
 * This API is for the Super Admin and Admin to verify OTP
 * 
 * @param {string} phone - The phone number of the user
 * @param {string} otp - The OTP sent to the user
 * @returns {object} - The response object
 */
router.post('/verify-otp', validateRequest(verifyOtpSchema), verifyOtp);

/**
 * This API is for the Super Admin and Admin to generate OTP for Aadhaar
 * 
 * @param {string} phone - The phone number of the user
 * @returns {object} - The response object
 */
router.post('/aadhaar/generate-otp', validateRequest(generateAadhaarOtpSchema), generateAadhaarOtp);

/**
 * This API is for the Super Admin and Admin to submit OTP for Aadhaar
 * 
 * @param {string} phone - The phone number of the user
 * @param {string} otp - The OTP sent to the user
 * @returns {object} - The response object
 */
router.post('/aadhaar/submit-otp', validateRequest(submitAadhaarOtpSchema), submitAadhaarOtp);

export default router;
