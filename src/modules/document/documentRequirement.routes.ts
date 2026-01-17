import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
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
    authorizePermission('document.read'),
    getDocumentRequirements
);

router.get(
    '/:id',
    authenticate,
    authorizePermission('document.read'),
    getDocumentRequirementById
);

router.post(
    '/',
    authenticate,
    authorizePermission('document.create'),
    validateRequest(createDocumentRequirementSchema),
    createDocumentRequirement
);

router.put(
    '/:id',
    authenticate,
    authorizePermission('document.update'),
    validateRequest(updateDocumentRequirementSchema),
    updateDocumentRequirement
);

router.delete(
    '/:id',
    authenticate,
    authorizePermission('document.delete'),
    deleteDocumentRequirement
);

router.get(
    '/students/:studentId',
    authenticate,
    authorizePermission('document.read'),
    getStudentDocumentRequirements
);

export default router;
