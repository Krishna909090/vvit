import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import * as controller from './qualificationRequirement.controller';
import { createQualificationRequirementSchema, updateQualificationRequirementSchema } from '../../validators/qualificationRequirementValidators';

const router = Router();

// Routes definition
router.get(
    '/',
    authenticate,
    authorizePermission('qualification.read'), 
    controller.getQualificationRequirements
);

router.get(
    '/:id',
    authenticate,
    authorizePermission('qualification.read'),
    controller.getQualificationRequirementById
);

router.post(
    '/',
    authenticate,
    authorizePermission('qualification.create'),
    validateRequest(createQualificationRequirementSchema),
    controller.createQualificationRequirement
);

router.put(
    '/:id',
    authenticate,
    authorizePermission('qualification.update'),
    validateRequest(updateQualificationRequirementSchema),
    controller.updateQualificationRequirement
);

router.delete(
    '/:id',
    authenticate,
    authorizePermission('qualification.delete'),
    controller.deleteQualificationRequirement
);

router.post(
    '/validate',
    authenticate,
    authorizePermission('qualification.read'), // Validate is checking existing against rules.
    controller.validate
);

export default router;
