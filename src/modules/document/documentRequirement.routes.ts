// routes/documentRequirementRoutes.ts
// Routes for document requirement management

import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getDocumentRequirements,
    getDocumentRequirementById,
    createDocumentRequirement,
    updateDocumentRequirement,
    deleteDocumentRequirement,
    getStudentDocumentRequirements
} from './documentRequirement.controller';
import {
    createDocumentRequirementSchema,
    updateDocumentRequirementSchema
} from '../../validators/documentRequirementValidators';

const router = Router();

router.get(
    '/',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    getDocumentRequirements
);

router.get(
    '/:id',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    getDocumentRequirementById
);

router.post(
    '/',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    validateRequest(createDocumentRequirementSchema),
    createDocumentRequirement
);

router.put(
    '/:id',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    validateRequest(updateDocumentRequirementSchema),
    updateDocumentRequirement
);

router.delete(
    '/:id',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    deleteDocumentRequirement
);

router.get(
    '/students/:studentId',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT]),
    getStudentDocumentRequirements
);

export default router;
