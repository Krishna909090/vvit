import { Router } from 'express';
import { sendOtp, verifyOtp } from '../controllers/authController';
import { validateRequest } from '../middlewares/validationMiddleware';
import { sendOtpSchema, verifyOtpSchema } from '../validators/authValidators';

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

export default router;
