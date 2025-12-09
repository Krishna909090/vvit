import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createTransportRoute, getTransportRoutes, getTransportRouteById,
    createVehicle, getVehicles, updateVehicle, deleteVehicle,
    createTransportStop, getTransportStops, updateTransportStop, deleteTransportStop
} from '../../controllers/admin/transportController';
import {
    createTransportRouteSchema, createVehicleSchema, createTransportStopSchema
} from '../../validators/adminValidators';

const router = Router();


// Transport Route
/**
 * @swagger
 * /admin/transport-route:
 *   post:
 *     summary: Create a transport route
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
 *               - city
 *               - cost
 *             properties:
 *               name:
 *                 type: string
 *               city:
 *                 type: string
 *               cost:
 *                 type: number
 *               busNumber:
 *                 type: string
 *               capacity:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Transport route created
 *   get:
 *     summary: Get all transport routes
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of transport routes
 */
router.post('/transport-route', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createTransportRouteSchema), createTransportRoute);
router.get('/transport-route', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getTransportRoutes);
router.get('/transport-route/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getTransportRouteById);

// Vehicle
/**
 * @swagger
 * /admin/vehicle:
 *   post:
 *     summary: Create a new vehicle
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
 *               - number
 *               - capacity
 *               - driverName
 *               - driverPhone
 *             properties:
 *               number:
 *                 type: string
 *               capacity:
 *                 type: integer
 *               driverName:
 *                 type: string
 *               driverPhone:
 *                 type: string
 *     responses:
 *       200:
 *         description: Vehicle created
 */
router.post('/vehicle', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createVehicleSchema), createVehicle);
router.get('/vehicle', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getVehicles);
router.put('/vehicle/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateVehicle);
router.delete('/vehicle/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteVehicle);

// Transport Stop
/**
 * @swagger
 * /admin/transport-stop:
 *   post:
 *     summary: Create a new transport stop
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
 *               - routeId
 *               - name
 *               - sequence
 *               - pickupTime
 *               - dropTime
 *             properties:
 *               routeId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               sequence:
 *                 type: integer
 *               pickupTime:
 *                 type: string
 *                 format: date-time
 *               dropTime:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Transport stop created
 */
router.post('/transport-stop', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createTransportStopSchema), createTransportStop);
router.get('/transport-stop', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getTransportStops);
router.put('/transport-stop/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateTransportStop);
router.delete('/transport-stop/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteTransportStop);

export default router;
