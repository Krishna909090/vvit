import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import * as scholarshipController from './scholarship.controller';

const router = Router();

// Routes
router.post('/rules', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), scholarshipController.createScholarshipRule);
router.get('/rules', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), scholarshipController.getScholarshipRules);
router.put('/rules/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), scholarshipController.updateScholarshipRule);
router.delete('/rules/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), scholarshipController.deleteScholarshipRule);
// 1. Check Eligibility (Read Only)
router.get('/check-eligibility/:studentId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.VERIFICATION_OFFICER]), scholarshipController.checkEligibility);

// 2. Verify (Officer)
router.post('/verify-eligibility', authenticate, authorize([Role.VERIFICATION_OFFICER, Role.ADMIN, Role.SUPER_ADMIN]), scholarshipController.verifyEligibility);

// 3. Allocate (Admin)
router.post('/allocate', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), scholarshipController.allocateScholarship);

export default router;
