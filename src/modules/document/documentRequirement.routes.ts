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
    authorizePermission(['document.read.all', 'student.create.own', 'student.create.all']),
    getDocumentRequirements
);

router.get(
    '/:id',
    authenticate,
    authorizePermission(['document.read.all', 'student.create.own', 'student.create.all']),
    getDocumentRequirementById
);

router.post(
    '/',
    authenticate,
    authorizePermission('document.create.all'),
    validateRequest(createDocumentRequirementSchema),
    createDocumentRequirement
);

router.put(
    '/:id',
    authenticate,
    authorizePermission('document.update.all'),
    validateRequest(updateDocumentRequirementSchema),
    updateDocumentRequirement
);

router.delete(
    '/:id',
    authenticate,
    authorizePermission('document.delete.all'),
    deleteDocumentRequirement
);

router.get(
    '/students/:studentId',
    authenticate,
    authorizePermission(['document.read.all', 'student.create.own', 'student.create.all']),
    getStudentDocumentRequirements
);

export default router;
