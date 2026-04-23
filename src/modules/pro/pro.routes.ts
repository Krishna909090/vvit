import { Router } from 'express';
import { authenticate } from '../../middleware/rbac.middleware';
import { getMyProfile, getMyStudents, getMyCommissionSummary } from './pro.controller';

const router = Router();

/**
 * GET /pro/me
 * Logged-in PRO: profile info (proNumber, name, phone).
 */
router.get('/me', authenticate, getMyProfile);

/**
 * GET /pro/my-students
 * Logged-in PRO: list of students assigned to this PRO with pagination + search.
 * Query: page, limit, search (applicationId/name/phone), status (admission status)
 */
router.get('/my-students', authenticate, getMyStudents);

/**
 * GET /pro/my-commission
 * Logged-in PRO: total students + sum of commission amounts.
 */
router.get('/my-commission', authenticate, getMyCommissionSummary);

export default router;
