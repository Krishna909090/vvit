import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getDashboardStats, addAdmin, getAgentCommissions, getUserDetails
} from '../../controllers/admin/generalController';
import {
    addAdminSchema, getAgentCommissionsSchema
} from '../../validators/adminValidators';

const router = Router();

// Admin Operations
/**
 * @swagger
 * /admin/dashboard-stats:
 *   get:
 *     summary: Get dashboard statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard stats retrieved
 */
// Admin Operations
/**
 * @swagger
 * /admin/dashboard-stats:
 *   get:
 *     summary: Get dashboard statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard stats retrieved
 */
router.get('/dashboard-stats', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getDashboardStats);

// Add Admin
/**
 * @swagger
 * /admin/add-admin:
 *   post:
 *     summary: Add a new admin
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
 *               - phone
 *               - role
 *             properties:
 *               name:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [ADMIN, SUPER_ADMIN]
 *     responses:
 *       201:
 *         description: Admin added successfully
 */
router.post('/add-admin', authenticate, authorize([Role.SUPER_ADMIN]), validateRequest(addAdminSchema), addAdmin);

// Agent Commissions
/**
 * @swagger
 * /admin/commissions:
 *   get:
 *     summary: Get agent commissions report
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Commissions report
 */
router.get('/commissions', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(getAgentCommissionsSchema), getAgentCommissions);

// User Details
/**
 * @swagger
 * /admin/user-details:
 *   get:
 *     summary: Get user details by phone
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: phone
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User details retrieved
 */
router.get('/user-details', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getUserDetails);

export default router;
