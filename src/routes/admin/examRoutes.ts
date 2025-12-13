import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    markAttendance, updateExamScore, uploadBulkResults
} from '../../controllers/admin/examController';
import {
    markAttendanceSchema, updateExamScoreSchema
} from '../../validators/adminValidators';
import upload from '../../config/multer';

const router = Router();

/**
 * @swagger
 * /admin/mark-attendance:
 *   post:
 *     summary: Mark student attendance for exam
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - studentId
 *               - attended
 *             properties:
 *               studentId:
 *                 type: string
 *               attended:
 *                 type: boolean
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             attended: true
 *     responses:
 *       200:
 *         description: Attendance marked
 */
// Exam
/**
 * @swagger
 * /admin/mark-attendance:
 *   post:
 *     summary: Mark student attendance for exam
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - studentId
 *               - attended
 *             properties:
 *               studentId:
 *                 type: string
 *               attended:
 *                 type: boolean
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             attended: true
 *     responses:
 *       200:
 *         description: Attendance marked
 */
router.post('/mark-attendance', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(markAttendanceSchema), markAttendance);

/**
 * @swagger
 * /admin/update-exam-score:
 *   post:
 *     summary: Update student exam score and qualification status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - studentId
 *               - score
 *               - cutoff
 *             properties:
 *               studentId:
 *                 type: string
 *               score:
 *                 type: number
 *               cutoff:
 *                 type: number
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             score: 85
 *             cutoff: 50
 *     responses:
 *       200:
 *         description: Exam score updated
 */
router.post('/update-exam-score', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateExamScoreSchema), updateExamScore);



/**
 * @swagger
 * /admin/upload-results:
 *   post:
 *     summary: Upload bulk exam results via CSV
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Results uploaded successfully
 */
router.post('/upload-results', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), upload.single('file'), uploadBulkResults);

export default router;
