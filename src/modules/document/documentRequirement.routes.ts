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
    authorizePermission(['admin.read.all', 'student.view.profile', 'student.create']),
    getDocumentRequirements
);

router.get(
    '/:id',
    authenticate,
    authorizePermission(['admin.read.all']),
    getDocumentRequirementById
);

router.post(
    '/',
    authenticate,
    authorizePermission('admin.update.all'),
    validateRequest(createDocumentRequirementSchema),
    createDocumentRequirement
);

router.put(
    '/:id',
    authenticate,
    authorizePermission('admin.update.all'),
    validateRequest(updateDocumentRequirementSchema),
    updateDocumentRequirement
);

router.delete(
    '/:id',
    authenticate,
    authorizePermission('admin.delete.all'),
    deleteDocumentRequirement
);

router.get(
    '/students/:studentId',
    authenticate,
    authorizePermission(['admin.read.all', 'student.view.profile']),
    getStudentDocumentRequirements
);

export default router;
