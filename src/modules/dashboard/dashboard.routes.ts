import { Router } from 'express';
import { DashboardController } from './dashboard.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

const router = Router();

router.use(authenticate, authorizePermission('admin.read.all'));

router.get('/application-stats', DashboardController.getApplicationStats);

router.get('/admission-stats', DashboardController.getAdmissionStats);

router.get('/scholarship-stats', DashboardController.getScholarshipStats);

router.get('/financial-stats', DashboardController.getFinancialStats);

router.get('/exam-stats', DashboardController.getExamStats);

router.get('/verification-stats', DashboardController.getVerificationStats);

router.get('/degree-seat-stats', DashboardController.getDegreeSeatAllocatedStats);

router.get('/gender-seat-stats', DashboardController.getGenderSeatAllocatedStats);

router.get('/seat-allocation-stats', DashboardController.getSeatAllocationStats);

router.get('/seat-allocation-counts', DashboardController.getSeatAllocationCounts);

router.get('/course-codes', DashboardController.getCourseCodes);

router.get('/course-stats', DashboardController.getCourseStats);

router.get('/trends', DashboardController.getRegistrationTrends);

router.get('/recent-students', DashboardController.getRecentStudents);

export default router;
