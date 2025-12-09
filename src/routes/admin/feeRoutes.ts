import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createFeeHead, getFeeHeads, updateFeeHead, deleteFeeHead,
    createFeeStructure, getFeeStructures, updateFeeStructure, deleteFeeStructure,
    getFeeStatistics,
    createDiscountRequest, reviewDiscountRequest, approveDiscount
} from '../../controllers/admin/feeController';
import {
    createFeeHeadSchema, createFeeStructureSchema,
    createDiscountRequestSchema, reviewDiscountRequestSchema, approveDiscountSchema
} from '../../validators/adminValidators';

const router = Router();

// Fee Head
/**
 * @swagger
 * /admin/fee-head:
 *   post:
 *     summary: Create a new fee head
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fee head created
 */
// Fee Head
/**
 * @swagger
 * /admin/fee-head:
 *   post:
 *     summary: Create a new fee head
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fee head created
 */
router.post('/fee-head', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createFeeHeadSchema), createFeeHead);
router.get('/fee-head', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getFeeHeads);
router.put('/fee-head/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateFeeHead);
router.delete('/fee-head/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteFeeHead);

// Fee Structure
/**
 * @swagger
 * /admin/fee-structure:
 *   post:
 *     summary: Create a new fee structure
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - academicYearId
 *               - courseId
 *               - feeHeadId
 *               - amount
 *               - dueDate
 *             properties:
 *               academicYearId:
 *                 type: string
 *                 format: uuid
 *               courseId:
 *                 type: string
 *                 format: uuid
 *               quota:
 *                 type: string
 *                 enum: [GQ, MQ]
 *               feeHeadId:
 *                 type: string
 *                 format: uuid
 *               amount:
 *                 type: number
 *               dueDate:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Fee structure created
 */
router.post('/fee-structure', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createFeeStructureSchema), createFeeStructure);
router.get('/fee-structure', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getFeeStructures);
router.put('/fee-structure/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateFeeStructure);
router.delete('/fee-structure/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteFeeStructure);

// Fee Statistics
/**
 * @swagger
 * /admin/fee-stats:
 *   get:
 *     summary: Get fee collection statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: academicYearId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Fee statistics retrieved
 */
router.get('/fee-stats', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getFeeStatistics);

// Discounts
/**
 * @swagger
 * /admin/create-discount:
 *   post:
 *     summary: Request a fee discount
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - studentId
 *               - amount
 *               - reason
 *             properties:
 *               studentId:
 *                 type: string
 *               amount:
 *                 type: number
 *               reason:
 *                 type: string
 *     responses:
 *       201:
 *         description: Discount request created
 */
router.post('/create-discount', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createDiscountRequestSchema), createDiscountRequest);

/**
 * @swagger
 * /admin/review-discount:
 *   post:
 *     summary: Review discount request (Admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - requestId
 *               - action
 *             properties:
 *               requestId:
 *                 type: string
 *               action:
 *                 type: string
 *                 enum: [APPROVE, REJECT, FORWARD]
 *               remarks:
 *                 type: string
 *     responses:
 *       200:
 *         description: Discount request processed
 */
router.post('/review-discount', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(reviewDiscountRequestSchema), reviewDiscountRequest);

/**
 * @swagger
 * /admin/approve-discount:
 *   post:
 *     summary: Approve discount request (Super Admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - requestId
 *               - action
 *             properties:
 *               requestId:
 *                 type: string
 *               action:
 *                 type: string
 *                 enum: [APPROVE, REJECT]
 *               remarks:
 *                 type: string
 *     responses:
 *       200:
 *         description: Discount request finally processed
 */
router.post('/approve-discount', authenticate, authorize([Role.SUPER_ADMIN]), validateRequest(approveDiscountSchema), approveDiscount);

export default router;
