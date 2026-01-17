import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import * as scholarshipController from './scholarship.controller';

const router = Router();

// Routes
// Routes
router.post('/rules', authenticate, authorizePermission('scholarship.create'), scholarshipController.createScholarshipRule);
router.get('/rules', authenticate, authorizePermission('scholarship.read'), scholarshipController.getScholarshipRules);
router.put('/rules/:id', authenticate, authorizePermission('scholarship.update'), scholarshipController.updateScholarshipRule);
router.delete('/rules/:id', authenticate, authorizePermission('scholarship.delete'), scholarshipController.deleteScholarshipRule);
// 1. Check Eligibility (Read Only)
router.get('/check-eligibility/:studentId', authenticate, authorizePermission('scholarship.read'), scholarshipController.checkEligibility);

// 2. Verify (Officer) - POST -> Create/Update. "verify" changes state.
router.post('/verify-eligibility', authenticate, authorizePermission('scholarship.create'), scholarshipController.verifyEligibility);

// 3. Allocate (Admin)
router.post('/allocate', authenticate, authorizePermission('scholarship.create'), scholarshipController.allocateScholarship);

export default router;
