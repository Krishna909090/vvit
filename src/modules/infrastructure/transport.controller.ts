import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { TransportService } from './transport.service';
import logger from '../../utils/logger';

export const createTransportRoute = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[createTransportRoute] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[createTransportRoute] payload=${JSON.stringify(req.body)}`);

    const { name, city, cost, busNumber, capacity, vehicleId } = req.body;
    const adminId = req.user?.userId;

    const route = await TransportService.createTransportRoute(name, city, cost, busNumber, capacity, vehicleId, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.TRANSPORT_ROUTE_CREATED,
        data: route
    });
});

export const getTransportRoutes = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getTransportRoutes] by=${req.user?.userId || 'anonymous'}`);
    const routes = await TransportService.getTransportRoutes();
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.TRANSPORT_ROUTES_FETCHED,
        data: routes
    });
});

export const getTransportRouteById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const route = await TransportService.getTransportRouteById(id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: route
    });
});

export const updateTransportRoute = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateTransportRoute] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;
    const updatedRoute = await TransportService.updateTransportRoute(id, req.body, req.user?.userId);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.TRANSPORT_ROUTE_UPDATED || 'Transport Route updated successfully',
        data: updatedRoute
    });
});

export const deleteTransportRoute = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[deleteTransportRoute] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;
    await TransportService.deleteTransportRoute(id);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.TRANSPORT_ROUTE_DELETED || 'Transport Route deleted successfully'
    });
});

export const createVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { number, capacity, driverName, driverPhone } = req.body;
    const adminId = req.user?.userId;

    const vehicle = await TransportService.createVehicle(number, capacity, driverName, driverPhone, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.VEHICLE_CREATED,
        data: vehicle
    });
});

export const createTransportStop = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { routeId, name, sequence, pickupTime, dropTime } = req.body;
    const adminId = req.user?.userId;

    const stop = await TransportService.createTransportStop(routeId, name, sequence, pickupTime, dropTime, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.TRANSPORT_STOP_CREATED,
        data: stop
    });
});


// Vehicle
export const getVehicles = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const vehicles = await TransportService.getVehicles();
    sendResponse({ res, statusCode: 200, success: true, data: vehicles });
});

export const getVehicleById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const vehicle = await TransportService.getVehicleById(id);
    sendResponse({ res, statusCode: 200, success: true, data: vehicle });
});

export const updateVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    const updatedVehicle = await TransportService.updateVehicle(id, req.body, req.user?.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.VEHICLE_UPDATED, data: updatedVehicle });
});

export const deleteVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await TransportService.deleteVehicle(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.VEHICLE_DELETED });
});

// Transport Stop
export const getTransportStops = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { routeId } = req.query;
    
    const stops = await TransportService.getTransportStops(routeId as string);
    
    sendResponse({ res, statusCode: 200, success: true, data: stops });
});

export const getTransportStopById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const stop = await TransportService.getTransportStopById(id);
    sendResponse({ res, statusCode: 200, success: true, data: stop });
});

export const updateTransportStop = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    const updatedStop = await TransportService.updateTransportStop(id, req.body, req.user?.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.TRANSPORT_STOP_UPDATED, data: updatedStop });
});

export const deleteTransportStop = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await TransportService.deleteTransportStop(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.TRANSPORT_STOP_DELETED });
});
