
import { Router } from 'express';
import { scanAttendance, verifyAttendance } from './exam.controller';
import { authenticate, authorize } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { scanAttendanceSchema } from '../../validators/examValidators';
import { qrScanRateLimiter } from '../../middlewares/rateLimitMiddleware';

const router = Router();

router.post('/scan', qrScanRateLimiter, authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.INVIGILATOR]), validateRequest(scanAttendanceSchema), scanAttendance);

router.post('/verify', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.INVIGILATOR]), verifyAttendance);

export default router;

