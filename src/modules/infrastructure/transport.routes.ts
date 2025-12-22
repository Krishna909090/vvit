import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createTransportRoute, getTransportRoutes, getTransportRouteById, updateTransportRoute, deleteTransportRoute,
    createVehicle, getVehicles, getVehicleById, updateVehicle, deleteVehicle,
    createTransportStop, getTransportStops, getTransportStopById, updateTransportStop, deleteTransportStop
} from './transport.controller';
import {
    createTransportRouteSchema, createVehicleSchema, createTransportStopSchema
} from '../../validators/adminValidators';

const router = Router();


// Transport Route
router.post('/transport-route', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createTransportRouteSchema), createTransportRoute);
router.get('/transport-route', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getTransportRoutes);
router.get('/transport-route/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getTransportRouteById);
router.put('/transport-route/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateTransportRoute);
router.delete('/transport-route/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteTransportRoute);

// Vehicle
router.post('/vehicle', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createVehicleSchema), createVehicle);
router.get('/vehicle', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getVehicles);
router.get('/vehicle/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getVehicleById);
router.put('/vehicle/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateVehicle);
router.delete('/vehicle/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteVehicle);

// Transport Stop
router.post('/transport-stop', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createTransportStopSchema), createTransportStop);
router.get('/transport-stop', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getTransportStops);
router.get('/transport-stop/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getTransportStopById);
router.put('/transport-stop/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateTransportStop);
router.delete('/transport-stop/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteTransportStop);

export default router;
