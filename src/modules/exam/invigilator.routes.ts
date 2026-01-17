import { Router } from 'express';
import { scanAttendance, verifyAttendance, manualScan } from './exam.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { scanAttendanceSchema } from '../../validators/examValidators';
import { qrScanRateLimiter } from '../../middlewares/rateLimitMiddleware';

const router = Router();

router.post('/scan', qrScanRateLimiter, authenticate, authorizePermission('exam.create'), validateRequest(scanAttendanceSchema), scanAttendance);

router.post('/manual-scan', authenticate, authorizePermission('exam.create'), manualScan);

router.post('/verify', authenticate, authorizePermission('exam.create'), verifyAttendance);

export default router;

