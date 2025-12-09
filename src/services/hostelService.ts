import prisma from '../config/prisma';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';
import { HostelType } from '@prisma/client';

export const HostelService = {
    // Hostel
    async createHostel(data: any, createdBy?: string) {
        const { name, type, capacity, cost, wardenName } = data;
        
        return await prisma.hostel.create({
            data: {
                name,
                type: type, // Now string
                wardenName,
                capacity: Number(capacity),
                cost: Number(cost),
                createdBy
            }
        });
    },

    async getAllHostels() {
        return await prisma.hostel.findMany({
            include: { blocks: { include: { rooms: { include: { beds: true } } } } }
        });
    },

    async getHostelById(id: string) {
        const hostel = await prisma.hostel.findUnique({
            where: { id },
            include: { blocks: { include: { rooms: true } } }
        });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        return hostel;
    },

    async updateHostel(id: string, filled: number) {
        const hostel = await prisma.hostel.findUnique({ where: { id } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

        return await prisma.hostel.update({
            where: { id },
            data: { filled: Number(filled) }
        });
    },

    // Hostel Block
    async createHostelBlock(data: any, createdBy?: string) {
        const { hostelId, name, type } = data;
        
        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

        return await prisma.hostelBlock.create({
            data: {
                hostelId,
                name,
                type,
                createdBy
            }
        });
    },

    async getHostelBlocks(hostelId?: string) {
        const where: any = {};
        if (hostelId) where.hostelId = hostelId;

        return await prisma.hostelBlock.findMany({
            where,
            include: { rooms: true }
        });
    },

    async updateHostelBlock(id: string, data: any, updatedBy?: string) {
        const block = await prisma.hostelBlock.findUnique({ where: { id } });
        if (!block) throw new AppError("Hostel Block not found", 404);

        return await prisma.hostelBlock.update({
            where: { id },
            data: { ...data, updatedBy }
        });
    },

    async deleteHostelBlock(id: string) {
        const block = await prisma.hostelBlock.findUnique({ where: { id } });
        if (!block) throw new AppError("Hostel Block not found", 404);

        return await prisma.hostelBlock.update({ where: { id }, data: { isDeleted: true } });
    },

    // Hostel Room
    async createHostelRoom(data: any, createdBy?: string) {
        const { blockId, number, capacity, type } = data;

        const block = await prisma.hostelBlock.findUnique({ where: { id: blockId } });
        if (!block) throw new AppError("Hostel Block not found", 404);

        // Transaction to create room and beds
        return await prisma.$transaction(async (tx) => {
            const room = await tx.hostelRoom.create({
                data: {
                    blockId,
                    number,
                    capacity: Number(capacity),
                    type,
                    createdBy
                }
            });

            // Create Beds
            const bedPromises = [];
            for (let i = 1; i <= Number(capacity); i++) {
                bedPromises.push(
                    tx.hostelBed.create({
                        data: {
                            roomId: room.id,
                            number: `${room.number}-${i}`,
                            createdBy
                        }
                    })
                );
            }
            await Promise.all(bedPromises);

            return room;
        });
    },

    async getHostelRooms(blockId?: string) {
        const where: any = {};
        if (blockId) where.blockId = blockId;

        return await prisma.hostelRoom.findMany({
            where,
            include: { beds: true }
        });
    },

    async updateHostelRoom(id: string, data: any, updatedBy?: string) {
        const room = await prisma.hostelRoom.findUnique({ where: { id } });
        if (!room) throw new AppError("Hostel Room not found", 404);

        return await prisma.hostelRoom.update({
            where: { id },
            data: { ...data, updatedBy }
        });
    },

    async deleteHostelRoom(id: string) {
        const room = await prisma.hostelRoom.findUnique({ where: { id } });
        if (!room) throw new AppError("Hostel Room not found", 404);

        return await prisma.hostelRoom.update({ where: { id }, data: { isDeleted: true } });
    }
};
