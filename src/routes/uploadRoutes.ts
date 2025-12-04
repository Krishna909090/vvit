import { Router } from 'express';
import { uploadSingleFile, uploadMultipleFiles } from '../controllers/uploadController';
import { authenticate } from '../middlewares/authMiddleware';
import upload from '../config/multer';
import { validateRequest } from '../middlewares/validationMiddleware';
import { uploadQuerySchema } from '../validators/uploadValidators';

const router = Router();

/**
 * @swagger
 * /api/upload/single:
 *   post:
 *     summary: Upload a single file to S3
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: folder
 *         schema:
 *           type: string
 *         description: S3 folder name (default 'documents')
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
 *         description: File uploaded successfully
 *       400:
 *         description: No file uploaded
 *       401:
 *         description: Unauthorized
 */
router.post('/single', authenticate, upload.single('file'), validateRequest(uploadQuerySchema), uploadSingleFile);

/**
 * @swagger
 * /api/upload/multiple:
 *   post:
 *     summary: Upload multiple files to S3
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: folder
 *         schema:
 *           type: string
 *         description: S3 folder name (default 'documents')
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *     responses:
 *       200:
 *         description: Files uploaded successfully
 *       400:
 *         description: No files uploaded
 *       401:
 *         description: Unauthorized
 */
router.post('/multiple', authenticate, upload.array('files', 10), validateRequest(uploadQuerySchema), uploadMultipleFiles);

export default router;
