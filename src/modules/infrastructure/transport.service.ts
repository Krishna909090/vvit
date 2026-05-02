import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import logger from '../../utils/logger';
import { convertToPresignedUrl } from '../../utils/s3Utils';

export const TransportService = {
    // Transport Route
    async createTransportRoute(
        name: string,
        city: string,
        cost: number,
        busNumber: string,
        capacity: number,
        vehicleId?: string,
        pickupTime?: string | null,
        dropTime?: string | null,
        createdBy?: string
    ) {
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
                pickupTime: pickupTime || undefined,
                dropTime: dropTime || undefined,
                filled: 0,
                createdBy
            }
        });
        logger.info(`[createTransportRoute] Route created successfully: ${route.id}`);
        return route;
    },

    async getTransportRoutes(filters?: { search?: string; name?: string; city?: string; busNumber?: string }) {
        const where: any = { isDeleted: false };

        if (filters?.search) {
            where.OR = [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { city: { contains: filters.search, mode: 'insensitive' } },
                { busNumber: { contains: filters.search, mode: 'insensitive' } },
            ];
        } else {
            if (filters?.name) where.name = { contains: filters.name, mode: 'insensitive' };
            if (filters?.city) where.city = { contains: filters.city, mode: 'insensitive' };
            if (filters?.busNumber) where.busNumber = { contains: filters.busNumber, mode: 'insensitive' };
        }

        const rows = await prisma.transportRoute.findMany({
            where,
            include: {
                stops: {
                    where: { isDeleted: false },
                    orderBy: { sequence: 'asc' },
                    select: { id: true, name: true, sequence: true },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        // Recompute filled live from active TransportAllocations (route.filled column may drift).
        const allocCounts = await prisma.transportAllocation.groupBy({
            by: ['routeId'],
            where: { status: 'ACTIVE', route: { isDeleted: false } },
            _count: { _all: true },
        });
        const filledByRoute = new Map<string, number>(
            allocCounts.map(a => [a.routeId, a._count._all])
        );

        const routes = rows.map(r => {
            const capacity = r.capacity ?? 0;
            const filled = filledByRoute.get(r.id) ?? (r.filled ?? 0);
            const stops = r.stops as any[];
            return {
                id: r.id,
                name: r.name,
                city: r.city,
                busNumber: r.busNumber,
                cost: r.cost,
                capacity,
                filled,
                vacant: Math.max(0, capacity - filled),
                pickupTime: r.pickupTime,
                dropTime: r.dropTime,
                vehicleId: r.vehicleId,
                createdAt: r.createdAt,
                updatedAt: r.updatedAt,
                totalStops: stops.length,
                stopsNames: stops.map(s => s.name),
                stops,
            };
        });

        const totals = routes.reduce(
            (acc, r) => {
                acc.totalCapacity += r.capacity;
                acc.totalFilled += r.filled;
                acc.totalVacant += r.vacant;
                acc.totalStops += r.totalStops;
                return acc;
            },
            { totalRoutes: routes.length, totalCapacity: 0, totalFilled: 0, totalVacant: 0, totalStops: 0 }
        );

        return { routes, totals };
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
        if (data.pickupTime !== undefined) updateData.pickupTime = data.pickupTime || null;
        if (data.dropTime !== undefined) updateData.dropTime = data.dropTime || null;

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
    async createVehicle(
        number: string,
        capacity: number,
        driverName: string,
        driverPhone: string,
        photoUrl?: string | null,
        createdBy?: string
    ) {
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
            data: {
                number,
                capacity: Number(capacity),
                driverName,
                driverPhone,
                photoUrl: photoUrl || undefined,
                createdBy,
            }
        });

        logger.info(`[createVehicle] Vehicle created successfully: ${vehicle.id}`);
        return vehicle;
    },

    async getVehicles(filters?: { search?: string }) {
        const where: any = { isDeleted: false };

        if (filters?.search) {
            where.OR = [
                { driverName: { contains: filters.search, mode: 'insensitive' } },
                { driverPhone: { contains: filters.search } },
                { number: { contains: filters.search, mode: 'insensitive' } },
            ];
        }

        const vehicles = await prisma.vehicle.findMany({
            where,
            orderBy: { createdAt: 'desc' },
        });
        return Promise.all(vehicles.map(async v => ({
            ...v,
            photoUrl: await convertToPresignedUrl(v.photoUrl),
        })));
    },

    async getVehicleById(id: string) {
        const vehicle = await prisma.vehicle.findFirst({ where: { id, isDeleted: false } });
        if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);
        return {
            ...vehicle,
            photoUrl: await convertToPresignedUrl(vehicle.photoUrl),
        };
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
        if (data.photoUrl !== undefined) updateData.photoUrl = data.photoUrl || null;

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
    async createTransportStop(routeId: string, name: string, sequence: number, createdBy?: string) {
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
