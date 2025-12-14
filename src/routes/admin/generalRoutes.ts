import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getDashboardStats, addAdmin, getAgentCommissions, getUserDetails, addInvigilator, getStaffUsers, updateStaffUser
} from '../../controllers/admin/generalController';
import {
    addAdminSchema, getAgentCommissionsSchema, addInvigilatorSchema, updateStaffUserSchema
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
router.post('/add-admin', authenticate, authorize([Role.ADMIN,Role.SUPER_ADMIN]), validateRequest(addAdminSchema), addAdmin);

// Add Invigilator
/**
 * @swagger
 * /admin/add-invigilator:
 *   post:
 *     summary: Add a new invigilator
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
 *             properties:
 *               name:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       201:
 *         description: Invigilator added successfully
 */
router.post('/add-invigilator', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(addInvigilatorSchema), addInvigilator);

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

// Get Staff Users
/**
 * @swagger
 * /admin/staff-users:
 *   get:
 *     summary: Get all staff users (excluding students)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [SUPER_ADMIN, ADMIN, AGENT, INVIGILATOR, STAFF]
 *         description: Filter by specific role
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by name, phone, or email
 *     responses:
 *       200:
 *         description: Staff users retrieved successfully
 */
router.get('/staff-users', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getStaffUsers);

// Update Staff User
/**
 * @swagger
 * /admin/staff-users/{userId}:
 *   put:
 *     summary: Update staff user details
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User ID to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               role:
 *                 type: string
 *                 enum: [SUPER_ADMIN, ADMIN, AGENT, INVIGILATOR, STAFF]
 *     responses:
 *       200:
 *         description: Staff user updated successfully
 */
router.put('/staff-users/:userId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateStaffUserSchema), updateStaffUser);

export default router;


