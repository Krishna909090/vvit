
import { Router } from 'express';
import { scanStudentQR } from '../controllers/invigilatorController';
import { authenticate, authorize } from '../middlewares/authMiddleware';
import { Role } from '@prisma/client';

const router = Router();

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
