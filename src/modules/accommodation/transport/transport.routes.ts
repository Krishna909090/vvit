import { Router } from 'express';
import { authenticate, authorizePermission } from '../../../middleware/rbac.middleware';
import { validateRequest } from '../../../middleware/validationMiddleware';
import {
    createTransportRoute, getTransportRoutes, getTransportRouteById, updateTransportRoute, deleteTransportRoute,
    createVehicle, getVehicles, getVehicleById, updateVehicle, deleteVehicle,
    createTransportStop, getTransportStops, getTransportStopById, updateTransportStop, deleteTransportStop
} from './transport.controller';
import {
    createTransportRouteSchema, createVehicleSchema, createTransportStopSchema
} from '../../../validators/adminValidators';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  TRANSPORT ROUTE MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /transport-route
 * @desc    Create a new transport route.
 * @access  Requires `transport.create.all` permission.
 * @body    { routeName, origin, destination, ... } — validated against createTransportRouteSchema.
 * @returns {{ success: boolean, data: TransportRoute }} The newly created route.
 */
router.post('/transport-route', authenticate, authorizePermission('transport.create.all'), validateRequest(createTransportRouteSchema), createTransportRoute);

/**
 * @route   GET /transport-route
 * @desc    Retrieve all transport routes. Accessible by admins and students during admission.
 * @access  Requires `transport.read.all`, `student.create.own`, or `student.create.all` permission.
 * @returns {{ success: boolean, data: TransportRoute[] }} Array of transport route records.
 */
router.get('/transport-route', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getTransportRoutes);

/**
 * @route   GET /transport-route/:id
 * @desc    Retrieve a single transport route by its ID.
 * @access  Requires `transport.read.all`, `student.create.own`, or `student.create.all` permission.
 * @param   {string} id — The transport route ID.
 * @returns {{ success: boolean, data: TransportRoute }} The matching route record.
 */
router.get('/transport-route/:id', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getTransportRouteById);

/**
 * @route   PUT /transport-route/:id
 * @desc    Update an existing transport route.
 * @access  Requires `transport.update.all` permission.
 * @param   {string} id — The transport route ID.
 * @body    Fields to update (routeName, status, etc.).
 * @returns {{ success: boolean, data: TransportRoute }} The updated route record.
 */
router.put('/transport-route/:id', authenticate, authorizePermission('transport.update.all'), updateTransportRoute);

/**
 * @route   DELETE /transport-route/:id
 * @desc    Delete a transport route. Side-effect: may cascade-delete associated stops.
 * @access  Requires `transport.delete.all` permission.
 * @param   {string} id — The transport route ID.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/transport-route/:id', authenticate, authorizePermission('transport.delete.all'), deleteTransportRoute);

// ═══════════════════════════════════════════════════════════
//  VEHICLE MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /vehicle
 * @desc    Register a new vehicle in the transport fleet.
 * @access  Requires `transport.create.all` permission.
 * @body    { vehicleNumber, capacity, type, ... } — validated against createVehicleSchema.
 * @returns {{ success: boolean, data: Vehicle }} The newly created vehicle record.
 */
router.post('/vehicle', authenticate, authorizePermission('transport.create.all'), validateRequest(createVehicleSchema), createVehicle);

/**
 * @route   GET /vehicle
 * @desc    Retrieve all vehicles. Accessible by admins and students during admission.
 * @access  Requires `transport.read.all`, `student.create.own`, or `student.create.all` permission.
 * @returns {{ success: boolean, data: Vehicle[] }} Array of vehicle records.
 */
router.get('/vehicle', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getVehicles);

/**
 * @route   GET /vehicle/:id
 * @desc    Retrieve a single vehicle by its ID.
 * @access  Requires `transport.read.all`, `student.create.own`, or `student.create.all` permission.
 * @param   {string} id — The vehicle ID.
 * @returns {{ success: boolean, data: Vehicle }} The matching vehicle record.
 */
router.get('/vehicle/:id', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getVehicleById);

/**
 * @route   PUT /vehicle/:id
 * @desc    Update an existing vehicle record.
 * @access  Requires `transport.update.all` permission.
 * @param   {string} id — The vehicle ID.
 * @body    Fields to update.
 * @returns {{ success: boolean, data: Vehicle }} The updated vehicle record.
 */
router.put('/vehicle/:id', authenticate, authorizePermission('transport.update.all'), updateVehicle);

/**
 * @route   DELETE /vehicle/:id
 * @desc    Remove a vehicle from the transport fleet.
 * @access  Requires `transport.delete.all` permission.
 * @param   {string} id — The vehicle ID.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/vehicle/:id', authenticate, authorizePermission('transport.delete.all'), deleteVehicle);

// ═══════════════════════════════════════════════════════════
//  TRANSPORT STOP MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /transport-stop
 * @desc    Create a new transport stop along a route.
 * @access  Requires `transport.create.all` permission.
 * @body    { routeId, stopName, order, ... } — validated against createTransportStopSchema.
 * @returns {{ success: boolean, data: TransportStop }} The newly created stop.
 */
router.post('/transport-stop', authenticate, authorizePermission('transport.create.all'), validateRequest(createTransportStopSchema), createTransportStop);

/**
 * @route   GET /transport-stop
 * @desc    Retrieve all transport stops. Accessible by admins and students during admission.
 * @access  Requires `transport.read.all`, `student.create.own`, or `student.create.all` permission.
 * @returns {{ success: boolean, data: TransportStop[] }} Array of transport stop records.
 */
router.get('/transport-stop', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getTransportStops);

/**
 * @route   GET /transport-stop/:id
 * @desc    Retrieve a single transport stop by its ID.
 * @access  Requires `transport.read.all`, `student.create.own`, or `student.create.all` permission.
 * @param   {string} id — The transport stop ID.
 * @returns {{ success: boolean, data: TransportStop }} The matching stop record.
 */
router.get('/transport-stop/:id', authenticate, authorizePermission(['transport.read.all', 'student.create.own', 'student.create.all']), getTransportStopById);

/**
 * @route   PUT /transport-stop/:id
 * @desc    Update an existing transport stop.
 * @access  Requires `transport.update.all` permission.
 * @param   {string} id — The transport stop ID.
 * @body    Fields to update (stopName, order, etc.).
 * @returns {{ success: boolean, data: TransportStop }} The updated stop record.
 */
router.put('/transport-stop/:id', authenticate, authorizePermission('transport.update.all'), updateTransportStop);

/**
 * @route   DELETE /transport-stop/:id
 * @desc    Delete a transport stop from a route.
 * @access  Requires `transport.delete.all` permission.
 * @param   {string} id — The transport stop ID.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/transport-stop/:id', authenticate, authorizePermission('transport.delete.all'), deleteTransportStop);

export default router;
