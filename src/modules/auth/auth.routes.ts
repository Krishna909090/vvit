import { Router } from 'express';
import { sendOtp, verifyOtp, generateAadhaarOtp, submitAadhaarOtp, login } from './auth.controller';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { sendOtpSchema, verifyOtpSchema, generateAadhaarOtpSchema, submitAadhaarOtpSchema } from '../../validators/authValidators';

const router = Router();

router.post('/send-otp', validateRequest(sendOtpSchema), sendOtp);
router.post('/login', login);

router.post('/verify-otp', validateRequest(verifyOtpSchema), verifyOtp);

router.post('/aadhaar/generate-otp', validateRequest(generateAadhaarOtpSchema), generateAadhaarOtp);

router.post('/aadhaar/submit-otp', validateRequest(submitAadhaarOtpSchema), submitAadhaarOtp);

export default router;
