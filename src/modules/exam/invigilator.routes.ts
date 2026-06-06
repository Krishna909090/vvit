
import { Router } from 'express';
import { scanAttendance, verifyAttendance, manualScan } from './exam.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import { scanAttendanceSchema } from '../../validators/examValidators';
import { qrScanRateLimiter } from '../../middleware/rateLimitMiddleware';

const router = Router();

router.post('/scan', qrScanRateLimiter, authenticate, authorizePermission('exam.update.all'), validateRequest(scanAttendanceSchema), scanAttendance);

router.post('/manual-scan', authenticate, authorizePermission('exam.update.all'), manualScan);

router.post('/verify', authenticate, authorizePermission('exam.update.all'), verifyAttendance);

export default router;
