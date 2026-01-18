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
router.post('/transport-route', authenticate, authorizePermission('transport.create.all'), validateRequest(createTransportRouteSchema), createTransportRoute);
router.get('/transport-route', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getTransportRoutes);
router.get('/transport-route/:id', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getTransportRouteById);
router.put('/transport-route/:id', authenticate, authorizePermission('transport.update.all'), updateTransportRoute);
router.delete('/transport-route/:id', authenticate, authorizePermission('transport.delete.all'), deleteTransportRoute);

// Vehicle
router.post('/vehicle', authenticate, authorizePermission('transport.create.all'), validateRequest(createVehicleSchema), createVehicle);
router.get('/vehicle', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getVehicles);
router.get('/vehicle/:id', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getVehicleById);
router.put('/vehicle/:id', authenticate, authorizePermission('transport.update.all'), updateVehicle);
router.delete('/vehicle/:id', authenticate, authorizePermission('transport.delete.all'), deleteVehicle);

// Transport Stop
router.post('/transport-stop', authenticate, authorizePermission('transport.create.all'), validateRequest(createTransportStopSchema), createTransportStop);
router.get('/transport-stop', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getTransportStops);
router.get('/transport-stop/:id', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getTransportStopById);
router.put('/transport-stop/:id', authenticate, authorizePermission('transport.update.all'), updateTransportStop);
router.delete('/transport-stop/:id', authenticate, authorizePermission('transport.delete.all'), deleteTransportStop);

export default router;
