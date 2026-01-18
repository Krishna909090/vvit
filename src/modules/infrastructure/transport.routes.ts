import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
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
router.post('/transport-route', authenticate, authorizePermission('infra.transport.manage'), validateRequest(createTransportRouteSchema), createTransportRoute);
router.get('/transport-route', authenticate, authorizePermission('infra.view'), getTransportRoutes);
router.get('/transport-route/:id', authenticate, authorizePermission('infra.view'), getTransportRouteById);
router.put('/transport-route/:id', authenticate, authorizePermission('infra.transport.manage'), updateTransportRoute);
router.delete('/transport-route/:id', authenticate, authorizePermission('infra.transport.manage'), deleteTransportRoute);

// Vehicle
router.post('/vehicle', authenticate, authorizePermission('infra.transport.manage'), validateRequest(createVehicleSchema), createVehicle);
router.get('/vehicle', authenticate, authorizePermission('infra.view'), getVehicles);
router.get('/vehicle/:id', authenticate, authorizePermission('infra.view'), getVehicleById);
router.put('/vehicle/:id', authenticate, authorizePermission('infra.transport.manage'), updateVehicle);
router.delete('/vehicle/:id', authenticate, authorizePermission('infra.transport.manage'), deleteVehicle);

// Transport Stop
router.post('/transport-stop', authenticate, authorizePermission('infra.transport.manage'), validateRequest(createTransportStopSchema), createTransportStop);
router.get('/transport-stop', authenticate, authorizePermission('infra.view'), getTransportStops);
router.get('/transport-stop/:id', authenticate, authorizePermission('infra.view'), getTransportStopById);
router.put('/transport-stop/:id', authenticate, authorizePermission('infra.transport.manage'), updateTransportStop);
router.delete('/transport-stop/:id', authenticate, authorizePermission('infra.transport.manage'), deleteTransportStop);

export default router;
