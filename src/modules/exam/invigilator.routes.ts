
import { Router } from 'express';
import { scanAttendance, verifyAttendance, manualScan } from './exam.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { scanAttendanceSchema } from '../../validators/examValidators';
import { qrScanRateLimiter } from '../../middlewares/rateLimitMiddleware';

const router = Router();

router.post('/scan', qrScanRateLimiter, authenticate, authorizePermission('exam.attendance.scan'), validateRequest(scanAttendanceSchema), scanAttendance);

router.post('/manual-scan', authenticate, authorizePermission('exam.attendance.scan'), manualScan);

router.post('/verify', authenticate, authorizePermission('exam.attendance.scan'), verifyAttendance);

export default router;

