// routes/documentRequirementRoutes.ts
// Routes for document requirement management

import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../middlewares/validationMiddleware';
import {
    getDocumentRequirements,
    createDocumentRequirement,
    updateDocumentRequirement,
    deleteDocumentRequirement,
    getStudentDocumentRequirements
} from '../controllers/documentRequirementController';
import {
    createDocumentRequirementSchema,
    updateDocumentRequirementSchema
} from '../validators/documentRequirementValidators';

const router = Router();

/**
 * @swagger
 * /document-requirements:
 *   get:
 *     summary: Get all document requirements (with optional courseType filter)
 *     tags: [Document Requirements]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: courseType
 *         schema:
 *           type: string
 *         description: Filter by course type (e.g., UG, PG, DIPLOMA)
 *     responses:
 *       200:
 *         description: List of document requirements
 */
router.get(
    '/',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    getDocumentRequirements
);

/**
 * @swagger
 * /document-requirements:
 *   post:
 *     summary: Create a new document requirement
 *     tags: [Document Requirements]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - courseType
 *               - documentName
 *               - documentKey
 *             properties:
 *               courseType:
 *                 type: string
 *                 example: "UG"
 *               documentName:
 *                 type: string
 *                 example: "10th Mark Sheet"
 *               documentKey:
 *                 type: string
 *                 example: "10th_marksheet"
 *               isRequired:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       201:
 *         description: Document requirement created
 */
router.post(
    '/',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    validateRequest(createDocumentRequirementSchema),
    createDocumentRequirement
);

/**
 * @swagger
 * /document-requirements/{id}:
 *   put:
 *     summary: Update a document requirement
 *     tags: [Document Requirements]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               documentName:
 *                 type: string
 *                 example: "10th Grade Mark Sheet"
 *               isRequired:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: Document requirement updated
 */
router.put(
    '/:id',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    validateRequest(updateDocumentRequirementSchema),
    updateDocumentRequirement
);

/**
 * @swagger
 * /document-requirements/{id}:
 *   delete:
 *     summary: Delete a document requirement (soft delete)
 *     tags: [Document Requirements]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Document requirement deleted
 */
router.delete(
    '/:id',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN]),
    deleteDocumentRequirement
);

/**
 * @swagger
 * /students/{studentId}/document-requirements:
 *   get:
 *     summary: Get document requirements for a specific student
 *     tags: [Document Requirements]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Student document requirements
 */
router.get(
    '/students/:studentId',
    authenticate,
    authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT]),
    getStudentDocumentRequirements
);

export default router;
