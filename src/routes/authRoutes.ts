import { Router } from 'express';
import { sendOtp, verifyOtp, generateAadhaarOtp, submitAadhaarOtp } from '../controllers/authController';
import { validateRequest } from '../middlewares/validationMiddleware';
import { sendOtpSchema, verifyOtpSchema, generateAadhaarOtpSchema, submitAadhaarOtpSchema } from '../validators/authValidators';

const router = Router();

/**
 * @swagger
 * /auth/send-otp:
 *   post:
 *     summary: Send OTP to phone number
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *             properties:
 *               phone:
 *                 type: string
 *           example:
 *             phone: "9876543210"
 *     responses:
 *       200:
 *         description: OTP sent successfully
 */
router.post('/send-otp', validateRequest(sendOtpSchema), sendOtp);

/**
 * @swagger
 * /auth/verify-otp:
 *   post:
 *     summary: Verify OTP and login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phone
 *               - otp
 *             properties:
 *               phone:
 *                 type: string
 *               otp:
 *                 type: string
 *           example:
 *             phone: "9876543210"
 *             otp: "123456"
 *     responses:
 *       200:
 *         description: Login successful, returns token
 */
router.post('/verify-otp', validateRequest(verifyOtpSchema), verifyOtp);

/**
 * @swagger
 * /auth/aadhaar/generate-otp:
 *   post:
 *     summary: Generate Aadhaar OTP via Quick KYC
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id_number
 *             properties:
 *               id_number:
 *                 type: string
 *                 description: Aadhaar Number
 *           example:
 *             id_number: "949817517713"
 *     responses:
 *       200:
 *         description: OTP generated successfully
 */
router.post('/aadhaar/generate-otp', validateRequest(generateAadhaarOtpSchema), generateAadhaarOtp);

/**
 * @swagger
 * /auth/aadhaar/submit-otp:
 *   post:
 *     summary: Submit Aadhaar OTP via Quick KYC
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - request_id
 *               - otp
 *             properties:
 *               request_id:
 *                 type: string
 *                 description: Request ID from generate-otp response
 *               otp:
 *                 type: string
 *                 description: OTP received
 *           example:
 *             request_id: "6173562"
 *             otp: "310428"
 *     responses:
 *       200:
 *         description: OTP verified successfully
 */
router.post('/aadhaar/submit-otp', validateRequest(submitAadhaarOtpSchema), submitAadhaarOtp);

export default router;
