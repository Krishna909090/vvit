import { Router } from 'express';
import { DashboardController } from './dashboard.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

const router = Router();

// Dashboard routes - Admin/SuperAdmin only
router.use(authenticate, authorizePermission('admin.read.all'));

router.get('/stats', DashboardController.getGlobalStats);
router.get('/trends', DashboardController.getRegistrationTrends);
router.get('/recent-students', DashboardController.getRecentStudents);
router.get('/seat-allocation-stats', DashboardController.getSeatAllocationStats);

export default router;
