import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import * as scholarshipController from './scholarship.controller';
import { validateRequest } from '../../middleware/validationMiddleware';
import { allocateScholarshipSchema, updateStudentScholarshipSchema } from '../../validators/paymentValidators';

const router = Router();

router.post('/rules', authenticate, authorizePermission('scholarship.create.all'), scholarshipController.createScholarshipRule);

router.get('/rules', authenticate, authorizePermission(['scholarship.read.all', 'scholarship.read.own']), scholarshipController.getScholarshipRules);

router.put('/rules/:id', authenticate, authorizePermission('scholarship.update.all'), scholarshipController.updateScholarshipRule);

router.delete('/rules/:id', authenticate, authorizePermission('scholarship.delete.all'), scholarshipController.deleteScholarshipRule);

router.get('/check-eligibility/:studentId', authenticate, authorizePermission(['scholarship.read.all', 'scholarship.read.own']), scholarshipController.checkEligibility);

router.post('/verify-eligibility', authenticate, authorizePermission('scholarship.update.all'), scholarshipController.verifyEligibility);

router.post('/allocate', authenticate, authorizePermission('scholarship.create.all'), validateRequest(allocateScholarshipSchema), scholarshipController.allocateScholarship);

router.post('/update-student-scholarship', authenticate, authorizePermission('scholarship.update.all'), validateRequest(updateStudentScholarshipSchema), scholarshipController.updateStudentScholarship);

export default router;
