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
router.post('/transport-route', authenticate, authorizePermission('transport.create'), validateRequest(createTransportRouteSchema), createTransportRoute);
router.get('/transport-route', authenticate, authorizePermission('transport.read'), getTransportRoutes);
router.get('/transport-route/:id', authenticate, authorizePermission('transport.read'), getTransportRouteById);
router.put('/transport-route/:id', authenticate, authorizePermission('transport.update'), updateTransportRoute);
router.delete('/transport-route/:id', authenticate, authorizePermission('transport.delete'), deleteTransportRoute);

// Vehicle
router.post('/vehicle', authenticate, authorizePermission('transport.create'), validateRequest(createVehicleSchema), createVehicle);
router.get('/vehicle', authenticate, authorizePermission('transport.read'), getVehicles);
router.get('/vehicle/:id', authenticate, authorizePermission('transport.read'), getVehicleById);
router.put('/vehicle/:id', authenticate, authorizePermission('transport.update'), updateVehicle);
router.delete('/vehicle/:id', authenticate, authorizePermission('transport.delete'), deleteVehicle);

// Transport Stop
router.post('/transport-stop', authenticate, authorizePermission('transport.create'), validateRequest(createTransportStopSchema), createTransportStop);
router.get('/transport-stop', authenticate, authorizePermission('transport.read'), getTransportStops);
router.get('/transport-stop/:id', authenticate, authorizePermission('transport.read'), getTransportStopById);
router.put('/transport-stop/:id', authenticate, authorizePermission('transport.update'), updateTransportStop);
router.delete('/transport-stop/:id', authenticate, authorizePermission('transport.delete'), deleteTransportStop);

export default router;
