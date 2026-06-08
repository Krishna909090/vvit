import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import * as controller from './qualificationRequirement.controller';
import { createQualificationRequirementSchema, updateQualificationRequirementSchema } from '../../validators/qualificationRequirementValidators';

const router = Router();

router.get(
    '/',
    authenticate,
    authorizePermission(['qualification.read.all', 'student.create.own', 'student.create.all']),
    controller.getQualificationRequirements
);

router.get(
    '/:id',
    authenticate,
    authorizePermission(['qualification.read.all', 'student.create.own', 'student.create.all']),
    controller.getQualificationRequirementById
);

router.post(
    '/',
    authenticate,
    authorizePermission('qualification.create.all'),
    validateRequest(createQualificationRequirementSchema),
    controller.createQualificationRequirement
);

router.put(
    '/:id',
    authenticate,
    authorizePermission('qualification.update.all'),
    validateRequest(updateQualificationRequirementSchema),
    controller.updateQualificationRequirement
);

router.delete(
    '/:id',
    authenticate,
    authorizePermission('qualification.delete.all'),
    controller.deleteQualificationRequirement
);

router.post(
    '/validate',
    authenticate,

    controller.validate
);

export default router;
