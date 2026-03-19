import { Router } from 'express';
import { uploadSingleFile, uploadMultipleFiles, getPresignedUrl } from './upload.controller';
import { authenticate } from '../../middlewares/authMiddleware';
import upload from '../../config/multer';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { uploadQuerySchema, getPresignedUrlSchema } from '../../validators/uploadValidators';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  FILE UPLOAD ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /single
 * @desc    Upload a single file (e.g. document, photo) to cloud storage.
 * @access  Authenticated users only.
 * @body    multipart/form-data — field name: `file`.
 * @query   Metadata fields — validated against uploadQuerySchema (e.g. folder, studentId).
 * @sideEffect Uploads the file to the configured storage bucket.
 * @returns {{ success: boolean, data: { url: string, key: string } }} The uploaded file URL and storage key.
 */
router.post('/single', authenticate, upload.single('file'), validateRequest(uploadQuerySchema), uploadSingleFile);

/**
 * @route   POST /multiple
 * @desc    Upload up to 10 files at once to cloud storage.
 * @access  Authenticated users only.
 * @body    multipart/form-data — field name: `files` (max 10).
 * @query   Metadata fields — validated against uploadQuerySchema.
 * @sideEffect Uploads all files to the configured storage bucket.
 * @returns {{ success: boolean, data: { url: string, key: string }[] }} Array of uploaded file URLs and keys.
 */
router.post('/multiple', authenticate, upload.array('files', 10), validateRequest(uploadQuerySchema), uploadMultipleFiles);

/**
 * @route   POST /presigned-url
 * @desc    Generate a presigned URL for direct client-side upload to S3-compatible storage.
 *          No file data is sent to the server; the client uses the returned URL to upload directly.
 * @access  Authenticated users only.
 * @body    { fileName, contentType, folder, ... } — validated against getPresignedUrlSchema.
 * @returns {{ success: boolean, data: { presignedUrl: string, key: string } }} Presigned upload URL and target key.
 */
router.post('/presigned-url', authenticate, validateRequest(getPresignedUrlSchema), getPresignedUrl);

export default router;
