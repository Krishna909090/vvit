import prisma from '../config/prisma';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';

export const TransportService = {
    // Transport Route
    async createTransportRoute(name: string, city: string, cost: number, busNumber: string, capacity: number, createdBy?: string) {
        if (!name || !city || cost === undefined || !busNumber || !capacity) {
            throw new AppError(MESSAGES.ERROR.TRANSPORT_FIELDS_REQUIRED, 400);
        }

        const existingRoute = await prisma.transportRoute.findFirst({
            where: {
                OR: [
                    { name: { equals: name, mode: 'insensitive' } },
                    { busNumber: { equals: busNumber, mode: 'insensitive' } }
                ]
            }
        });

        if (existingRoute) {
            throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_EXISTS, 409);
        }

        return await prisma.transportRoute.create({
            data: {
                name,
                
                city,
                cost: Number(cost),
                busNumber,
                capacity: Number(capacity),
                filled: 0,
                createdBy
            }
        });
    },

    async getTransportRoutes() {
        return await prisma.transportRoute.findMany({ include: { stops: true } });
    },

    async getTransportRouteById(id: string) {
        const route = await prisma.transportRoute.findUnique({
            where: { id },
            include: { stops: { orderBy: { sequence: 'asc' } }, vehicle: true }
        });
        if (!route) throw new AppError("Transport Route not found", 404);
        return route;
    },

    // Vehicle
    async createVehicle(number: string, capacity: number, driverName: string, driverPhone: string, createdBy?: string) {
        const existingVehicle = await prisma.vehicle.findUnique({ where: { number } });
        if (existingVehicle) {
            throw new AppError(MESSAGES.ERROR.VEHICLE_EXISTS, 409);
        }

        return await prisma.vehicle.create({
            data: { number, capacity: Number(capacity), driverName, driverPhone, createdBy }
        });
    },

    async getVehicles() {
        return await prisma.vehicle.findMany();
    },

    async updateVehicle(id: string, number: string, capacity?: number, driverName?: string, driverPhone?: string, updatedBy?: string) {
        const vehicle = await prisma.vehicle.findUnique({ where: { id } });
        if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);

        return await prisma.vehicle.update({
            where: { id },
            data: {
                number,
                capacity: capacity ? Number(capacity) : undefined,
                driverName,
                driverPhone,
                updatedBy
            }
        });
    },

    async deleteVehicle(id: string) {
        const vehicle = await prisma.vehicle.findUnique({ where: { id } });
        if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);

        return await prisma.vehicle.update({ where: { id }, data: { isDeleted: true } });
    },

    // Transport Stop
    async createTransportStop(routeId: string, name: string, sequence: number, pickupTime: string, dropTime: string, createdBy?: string) {
        const existingStop = await prisma.transportStop.findFirst({
            where: {
                routeId,
                name: { equals: name, mode: 'insensitive' }
            }
        });

        if (existingStop) {
            throw new AppError(MESSAGES.ERROR.TRANSPORT_STOP_EXISTS, 409);
        }

        return await prisma.transportStop.create({
            data: {
                routeId,
                name,
                sequence: Number(sequence),
                pickupTime: new Date(pickupTime),
                dropTime: new Date(dropTime),
                createdBy
            }
        });
    },

    async getTransportStops(routeId?: string) {
        const where: any = {};
        if (routeId) where.routeId = String(routeId);

        return await prisma.transportStop.findMany({
            where,
            include: { route: true },
            orderBy: { sequence: 'asc' }
        });
    },

    async updateTransportStop(id: string, name: string, routeId: string, sequence?: number, pickupTime?: string, dropTime?: string, updatedBy?: string) {
        const stop = await prisma.transportStop.findUnique({ where: { id } });
        if (!stop) throw new AppError(MESSAGES.ERROR.TRANSPORT_STOP_NOT_FOUND, 404);

        const data: any = { name, routeId, updatedBy };
        if (sequence !== undefined) data.sequence = Number(sequence);
        if (pickupTime) data.pickupTime = new Date(pickupTime);
        if (dropTime) data.dropTime = new Date(dropTime);

        return await prisma.transportStop.update({
            where: { id },
            data
        });
    },

    async deleteTransportStop(id: string) {
        const stop = await prisma.transportStop.findUnique({ where: { id } });
        if (!stop) throw new AppError(MESSAGES.ERROR.TRANSPORT_STOP_NOT_FOUND, 404);

        return await prisma.transportStop.update({ where: { id }, data: { isDeleted: true } });
    }
};
