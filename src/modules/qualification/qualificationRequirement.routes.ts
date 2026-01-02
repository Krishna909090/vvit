import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import * as controller from './qualificationRequirement.controller';
import { createQualificationRequirementSchema, updateQualificationRequirementSchema } from '../../validators/qualificationRequirementValidators';

const router = Router();

router.get(
    '/',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT]), // Students need to see reqs
    controller.getQualificationRequirements
);

router.get(
    '/:id',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT]),
    controller.getQualificationRequirementById
);

router.post(
    '/',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    validateRequest(createQualificationRequirementSchema),
    controller.createQualificationRequirement
);

router.put(
    '/:id',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    validateRequest(updateQualificationRequirementSchema),
    controller.updateQualificationRequirement
);

router.delete(
    '/:id',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    controller.deleteQualificationRequirement
);

router.post(
    '/validate',
    authenticate,
    // authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT]), // All can validate
    controller.validate
);

export default router;
