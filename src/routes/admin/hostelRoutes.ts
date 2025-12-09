import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createHostel, getHostels, getHostelById, updateHostel,
    createHostelBlock, getHostelBlocks, updateHostelBlock, deleteHostelBlock,
    createHostelRoom, getHostelRooms, updateHostelRoom, deleteHostelRoom
} from '../../controllers/admin/hostelController';
import {
    createHostelBlockSchema, createHostelRoomSchema
} from '../../validators/adminValidators';
import { createHostelSchema, updateHostelSchema } from '../../validators/hostelValidators';

const router = Router();

// Hostel Management
/**
 * @swagger
 * /admin/hostels:
 *   post:
 *     summary: Create a new hostel
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
 *               - type
 *               - capacity
 *               - fee
 *             properties:
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [SHARING_4, SHARING_8]
 *               capacity:
 *                 type: integer
 *               fee:
 *                 type: number
 *               blockName:
 *                 type: string
 *               roomNumber:
 *                 type: string
 *     responses:
 *       201:
 *         description: Hostel created successfully
 *   get:
 *     summary: Get all hostels
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of hostels
 */
// Hostel Management
/**
 * @swagger
 * /admin/hostels:
 *   post:
 *     summary: Create a new hostel
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
 *               - type
 *               - capacity
 *               - fee
 *             properties:
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [SHARING_4, SHARING_8]
 *               capacity:
 *                 type: integer
 *               fee:
 *                 type: number
 *               blockName:
 *                 type: string
 *               roomNumber:
 *                 type: string
 *     responses:
 *       201:
 *         description: Hostel created successfully
 *   get:
 *     summary: Get all hostels
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of hostels
 */
router.post('/hostels', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createHostelSchema), createHostel);
router.get('/hostels', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostels);
router.get('/hostels/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostelById);

/**
 * @swagger
 * /admin/hostels/{hostelId}:
 *   put:
 *     summary: Update hostel details
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: hostelId
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
 *               name:
 *                 type: string
 *               capacity:
 *                 type: integer
 *               fee:
 *                 type: number
 *     responses:
 *       200:
 *         description: Hostel updated successfully
 */
router.put('/hostels/:hostelId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateHostelSchema), updateHostel);

// Hostel Block
/**
 * @swagger
 * /admin/hostel-block:
 *   post:
 *     summary: Create a new hostel block
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
 *               - hostelId
 *               - name
 *               - type
 *             properties:
 *               hostelId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *     responses:
 *       200:
 *         description: Hostel block created
 */
router.post('/hostel-block', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createHostelBlockSchema), createHostelBlock);
router.get('/hostel-block', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostelBlocks);
router.put('/hostel-block/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateHostelBlock);
router.delete('/hostel-block/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteHostelBlock);

// Hostel Room
/**
 * @swagger
 * /admin/hostel-room:
 *   post:
 *     summary: Create a new hostel room
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
 *               - blockId
 *               - number
 *               - capacity
 *               - type
 *             properties:
 *               blockId:
 *                 type: string
 *                 format: uuid
 *               number:
 *                 type: string
 *               capacity:
 *                 type: integer
 *               type:
 *                 type: string
 *     responses:
 *       200:
 *         description: Hostel room created
 */
router.post('/hostel-room', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createHostelRoomSchema), createHostelRoom);
router.get('/hostel-room', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostelRooms);
router.put('/hostel-room/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateHostelRoom);
router.delete('/hostel-room/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteHostelRoom);

export default router;
