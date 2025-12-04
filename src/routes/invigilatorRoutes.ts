import { Router } from 'express';
import { loginInvigilator, scanStudentQR } from '../controllers/invigilatorController';
import { authenticate, authorize } from '../middlewares/authMiddleware';
import { Role } from '@prisma/client';

const router = Router();

/**
 * @swagger
 * /invigilator/login:
 *   post:
 *     summary: Login for invigilator using token
 *     tags: [Invigilator]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - token
 *             properties:
 *               token:
 *                 type: string
 *           example:
 *             token: "ABC123XY"
 *     responses:
 *       200:
 *         description: Login successful
 */
router.post('/login', loginInvigilator);

/**
 * @swagger
 * /invigilator/scan-qr:
 *   post:
 *     summary: Scan student QR code for attendance
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
 *             qrHash: "uuid-hash-from-qr"
 *     responses:
 *       200:
 *         description: Attendance marked
 */
router.post('/scan-qr', authenticate, authorize([Role.INVIGILATOR]), scanStudentQR);

export default router;
