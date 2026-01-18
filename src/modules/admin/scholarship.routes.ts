import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import * as scholarshipController from './scholarship.controller';

const router = Router();

// Routes
router.post('/rules', authenticate, authorizePermission('finance.scholarship.manage'), scholarshipController.createScholarshipRule);
router.get('/rules', authenticate, authorizePermission('finance.scholarship.manage'), scholarshipController.getScholarshipRules);
router.put('/rules/:id', authenticate, authorizePermission('finance.scholarship.manage'), scholarshipController.updateScholarshipRule);
router.delete('/rules/:id', authenticate, authorizePermission('finance.scholarship.manage'), scholarshipController.deleteScholarshipRule);
// 1. Check Eligibility (Read Only)
router.get('/check-eligibility/:studentId', authenticate, authorizePermission(['student.view.profile', 'finance.scholarship.manage']), scholarshipController.checkEligibility);

// 2. Verify (Officer)
router.post('/verify-eligibility', authenticate, authorizePermission('finance.scholarship.manage'), scholarshipController.verifyEligibility);

// 3. Allocate (Admin)
router.post('/allocate', authenticate, authorizePermission('finance.scholarship.manage'), scholarshipController.allocateScholarship);

export default router;
