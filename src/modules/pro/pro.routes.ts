import { Router } from 'express';
import { authenticate } from '../../middleware/rbac.middleware';
import { getMyProfile, getMyStudents, getMyCommissionSummary } from './pro.controller';

const router = Router();

router.get('/me', authenticate, getMyProfile);

router.get('/my-students', authenticate, getMyStudents);

router.get('/my-commission', authenticate, getMyCommissionSummary);

export default router;
