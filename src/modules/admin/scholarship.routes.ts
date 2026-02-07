import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import * as scholarshipController from './scholarship.controller';

const router = Router();

// Routes
// Routes
router.post('/rules', authenticate, authorizePermission('scholarship.create.all'), scholarshipController.createScholarshipRule);
router.get('/rules', authenticate, authorizePermission(['scholarship.read.all', 'scholarship.read.own']), scholarshipController.getScholarshipRules);
router.put('/rules/:id', authenticate, authorizePermission('scholarship.update.all'), scholarshipController.updateScholarshipRule);
router.delete('/rules/:id', authenticate, authorizePermission('scholarship.delete.all'), scholarshipController.deleteScholarshipRule);
// 1. Check Eligibility (Read Only)
router.get('/check-eligibility/:studentId', authenticate, authorizePermission(['scholarship.read.all', 'scholarship.read.own']), scholarshipController.checkEligibility);

// 2. Verify (Officer)
router.post('/verify-eligibility', authenticate, authorizePermission('scholarship.update.all'), scholarshipController.verifyEligibility);

// 3. Allocate (Admin)
router.post('/allocate', authenticate, authorizePermission('scholarship.create.all'), scholarshipController.allocateScholarship);

export default router;
