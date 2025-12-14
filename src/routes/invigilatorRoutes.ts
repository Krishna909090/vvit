
import { Router } from 'express';
import { scanAttendance, verifyAttendance } from '../controllers/examController';
import { authenticate, authorize } from '../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../middlewares/validationMiddleware';
import { scanAttendanceSchema } from '../validators/examValidators';
import { qrScanRateLimiter } from '../middlewares/rateLimitMiddleware';

const router = Router();

/**
 * @swagger
 * /invigilator/scan:
 *   post:
 *     summary: Scan student QR code and get details for validation
 *     tags: [Invigilator]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - qrHash
 *             properties:
 *               qrHash:
 *                 type: string
 *           example:
 *             qrHash: "encrypted-qr-hash"
 *     responses:
 *       200:
 *         description: Student details retrieved for validation
 */
router.post('/scan', qrScanRateLimiter, authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.INVIGILATOR]), validateRequest(scanAttendanceSchema), scanAttendance);

/**
 * @swagger
 * /invigilator/verify:
 *   post:
 *     summary: Verify and mark student attendance after validation
 *     tags: [Invigilator]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - attendanceRecordId
 *             properties:
 *               attendanceRecordId:
 *                 type: string
 *           example:
 *             attendanceRecordId: "uuid-from-scan-response"
 *     responses:
 *       200:
 *         description: Attendance verified and marked
 */
router.post('/verify', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.INVIGILATOR]), verifyAttendance);

export default router;

