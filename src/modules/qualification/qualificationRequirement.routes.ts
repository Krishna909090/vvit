import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import * as controller from './qualificationRequirement.controller';
import { createQualificationRequirementSchema, updateQualificationRequirementSchema } from '../../validators/qualificationRequirementValidators';

const router = Router();

router.get(
    '/',
    authenticate,
    authorizePermission(['admin.read.all', 'student.view.profile', 'student.create']), // Students need to see reqs
    controller.getQualificationRequirements
);

router.get(
    '/:id',
    authenticate,
    authorizePermission(['admin.read.all', 'student.view.profile']),
    controller.getQualificationRequirementById
);

router.post(
    '/',
    authenticate,
    authorizePermission('admin.update.all'),
    validateRequest(createQualificationRequirementSchema),
    controller.createQualificationRequirement
);

router.put(
    '/:id',
    authenticate,
    authorizePermission('admin.update.all'),
    validateRequest(updateQualificationRequirementSchema),
    controller.updateQualificationRequirement
);

router.delete(
    '/:id',
    authenticate,
    authorizePermission('admin.delete.all'),
    controller.deleteQualificationRequirement
);

router.post(
    '/validate',
    authenticate,
    // authorizePermission(['admin.read.all', 'student.view.profile']), // All can validate
    controller.validate
);

export default router;
