import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import logger from '../../utils/logger';

export const TransportService = {
    // Transport Route
    async createTransportRoute(name: string, city: string, cost: number, busNumber: string, capacity: number, vehicleId?: string, createdBy?: string) {
        logger.info(`[createTransportRoute] Attempting to create route: ${name}`);
        if (!name || !city || cost === undefined || !busNumber || !capacity) {
            throw new AppError(MESSAGES.ERROR.TRANSPORT_FIELDS_REQUIRED, 400);
        }

        if (vehicleId) {
            const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
            if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);
        }

        const existingRoute = await prisma.transportRoute.findFirst({
            where: {
                OR: [
                    { name: { equals: name, mode: 'insensitive' } },
                    { busNumber: { equals: busNumber, mode: 'insensitive' } }
                ],
                isDeleted: false
            }
        });

        if (existingRoute) {
            logger.warn(`[createTransportRoute] Route creation failed. Route ${name} or Bus ${busNumber} already exists.`);
            throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_EXISTS, 409);
        }

        const route = await prisma.transportRoute.create({
            data: {
                name,
                city,
                cost: Number(cost),
                busNumber,
                capacity: Number(capacity),
                vehicleId,
                filled: 0,
                createdBy
            }
        });
        logger.info(`[createTransportRoute] Route created successfully: ${route.id}`);
        return route;
    },

    async getTransportRoutes() {
        return await prisma.transportRoute.findMany({ 
            where: { isDeleted: false },
            include: { stops: true } 
        });
    },

    async getTransportRouteById(id: string) {
        const route = await prisma.transportRoute.findFirst({
            where: { id, isDeleted: false },
            include: { stops: { orderBy: { sequence: 'asc' } }, vehicle: true }
        });
        if (!route) throw new AppError("Transport Route not found", 404);
        return route;
    },

    async updateTransportRoute(id: string, data: any, updatedBy?: string) {
        logger.info(`[updateTransportRoute] Updating route: ${id}`);
        const route = await prisma.transportRoute.findUnique({ where: { id } });
        if (!route) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_NOT_FOUND || "Transport Route not found", 404);

        const updateData: any = { updatedBy };
        if (data.name) updateData.name = data.name;
        if (data.city) updateData.city = data.city;
        if (data.cost !== undefined) updateData.cost = Number(data.cost);
        if (data.busNumber) updateData.busNumber = data.busNumber;
        if (data.capacity) updateData.capacity = Number(data.capacity);
        
        if (data.vehicleId) {
            const vehicle = await prisma.vehicle.findUnique({ where: { id: data.vehicleId } });
            if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);
            updateData.vehicleId = data.vehicleId;
        }

        const updated = await prisma.transportRoute.update({
            where: { id },
            data: updateData
        });
        logger.info(`[updateTransportRoute] Route updated successfully: ${id}`);
        return updated;
    },

    async deleteTransportRoute(id: string) {
        logger.info(`[deleteTransportRoute] Deleting route: ${id}`);
        const route = await prisma.transportRoute.findUnique({ where: { id } });
        if (!route) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_NOT_FOUND || "Transport Route not found", 404);

        await prisma.transportRoute.update({ 
            where: { id }, 
            data: { isDeleted: true } 
        });
        logger.info(`[deleteTransportRoute] Route deleted successfully: ${id}`);
    },

    // Vehicle
    async createVehicle(number: string, capacity: number, driverName: string, driverPhone: string, createdBy?: string) {
        logger.info(`[createVehicle] Attempting to create vehicle: ${number}`);
        
        const existingVehicle = await prisma.vehicle.findFirst({ 
            where: { 
                number,
                isDeleted: false 
            } 
        });

        if (existingVehicle) {
            logger.warn(`[createVehicle] Vehicle creation failed. Vehicle ${number} already exists.`);
            throw new AppError(MESSAGES.ERROR.VEHICLE_EXISTS, 409);
        }

        const vehicle = await prisma.vehicle.create({
            data: { number, capacity: Number(capacity), driverName, driverPhone, createdBy }
        });

        logger.info(`[createVehicle] Vehicle created successfully: ${vehicle.id}`);
        return vehicle;
    },

    async getVehicles() {
        return await prisma.vehicle.findMany({ where: { isDeleted: false } });
    },

    async getVehicleById(id: string) {
        const vehicle = await prisma.vehicle.findFirst({ where: { id, isDeleted: false } });
        if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);
        return vehicle;
    },

    async updateVehicle(id: string, data: any, updatedBy?: string) {
        logger.info(`[updateVehicle] Updating vehicle: ${id}`);
        const vehicle = await prisma.vehicle.findUnique({ where: { id } });
        if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);

        const updateData: any = { updatedBy };
        if (data.number) updateData.number = data.number;
        if (data.capacity) updateData.capacity = Number(data.capacity);
        if (data.driverName) updateData.driverName = data.driverName;
        if (data.driverPhone) updateData.driverPhone = data.driverPhone;

        const updated = await prisma.vehicle.update({
            where: { id },
            data: updateData
        });
        logger.info(`[updateVehicle] Vehicle updated successfully: ${id}`);
        return updated;
    },

    async deleteVehicle(id: string) {
        logger.info(`[deleteVehicle] Deleting vehicle: ${id}`);
        const vehicle = await prisma.vehicle.findUnique({ where: { id } });
        if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);

        await prisma.vehicle.update({ where: { id }, data: { isDeleted: true } });
        logger.info(`[deleteVehicle] Vehicle deleted successfully: ${id}`);
    },

    // Transport Stop
    async createTransportStop(routeId: string, name: string, sequence: number, pickupTime: string, dropTime: string, createdBy?: string) {
        logger.info(`[createTransportStop] Creating stop for route: ${routeId} - ${name}`);
        const existingStop = await prisma.transportStop.findFirst({
            where: {
                routeId,
                name: { equals: name, mode: 'insensitive' },
                isDeleted: false
            }
        });

        if (existingStop) {
            logger.warn(`[createTransportStop] Stop creation failed. Stop ${name} already exists for route ${routeId}.`);
            throw new AppError(MESSAGES.ERROR.TRANSPORT_STOP_EXISTS, 409);
        }

        const stop = await prisma.transportStop.create({
            data: {
                routeId,
                name,
                sequence: Number(sequence),
                pickupTime: new Date(pickupTime),
                dropTime: new Date(dropTime),
                createdBy
            }
        });
        logger.info(`[createTransportStop] Stop created successfully: ${stop.id}`);
        return stop;
    },

    async getTransportStops(routeId?: string) {
        const where: any = { isDeleted: false };
        if (routeId) where.routeId = String(routeId);

        return await prisma.transportStop.findMany({
            where,
            include: { route: true },
            orderBy: { sequence: 'asc' }
        });
    },

    async getTransportStopById(id: string) {
        const stop = await prisma.transportStop.findUnique({ where: { id }, include: { route: true } });
        if (!stop) throw new AppError(MESSAGES.ERROR.TRANSPORT_STOP_NOT_FOUND, 404);
        return stop;
    },

    async updateTransportStop(id: string, data: any, updatedBy?: string) {
        logger.info(`[updateTransportStop] Updating stop: ${id}`);
        const stop = await prisma.transportStop.findUnique({ where: { id } });
        if (!stop) throw new AppError(MESSAGES.ERROR.TRANSPORT_STOP_NOT_FOUND, 404);

        const updateData: any = { updatedBy };
        if (data.name) updateData.name = data.name;
        if (data.routeId) updateData.routeId = data.routeId;
        if (data.sequence !== undefined) updateData.sequence = Number(data.sequence);
        if (data.pickupTime) updateData.pickupTime = new Date(data.pickupTime);
        if (data.dropTime) updateData.dropTime = new Date(data.dropTime);

        const updated = await prisma.transportStop.update({
            where: { id },
            data: updateData
        });
        logger.info(`[updateTransportStop] Stop updated successfully: ${id}`);
        return updated;
    },

    async deleteTransportStop(id: string) {
        logger.info(`[deleteTransportStop] Deleting stop: ${id}`);
        const stop = await prisma.transportStop.findUnique({ where: { id } });
        if (!stop) throw new AppError(MESSAGES.ERROR.TRANSPORT_STOP_NOT_FOUND, 404);

        await prisma.transportStop.update({ where: { id }, data: { isDeleted: true } });
        logger.info(`[deleteTransportStop] Stop deleted successfully: ${id}`);
    }
};
