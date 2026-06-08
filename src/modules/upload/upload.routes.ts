import { Router } from 'express';
import { uploadSingleFile, uploadMultipleFiles, getPresignedUrl } from './upload.controller';
import { authenticate } from '../../middleware/rbac.middleware';
import upload from '../../config/multer';
import { validateRequest } from '../../middleware/validationMiddleware';
import { uploadQuerySchema, getPresignedUrlSchema } from '../../validators/uploadValidators';

const router = Router();

router.post('/single', authenticate, upload.single('file'), validateRequest(uploadQuerySchema), uploadSingleFile);

router.post('/multiple', authenticate, upload.array('files', 10), validateRequest(uploadQuerySchema), uploadMultipleFiles);

router.post('/presigned-url', authenticate, validateRequest(getPresignedUrlSchema), getPresignedUrl);

export default router;
