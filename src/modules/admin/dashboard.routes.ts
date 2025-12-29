import { Router } from 'express';
import { DashboardController } from './dashboard.controller';
import { authenticate, authorize } from '../../middlewares/authMiddleware';

const router = Router();

// Dashboard routes - Admin/SuperAdmin only
router.use(authenticate, authorize(['ADMIN', 'SUPER_ADMIN']));

router.get('/stats', DashboardController.getGlobalStats);
router.get('/trends', DashboardController.getRegistrationTrends);
router.get('/recent-students', DashboardController.getRecentStudents);

export default router;
