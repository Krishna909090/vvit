import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import { HostelType } from '@prisma/client';

export const HostelService = {
    // Hostel
    async createHostel(data: any, createdBy?: string) {
        const { name, type, capacity, wardenName } = data;

        const existingHostel = await prisma.hostel.findFirst({
            where: {
                name: { equals: name, mode: 'insensitive' }
            }
        });

        if (existingHostel) {
            throw new AppError(MESSAGES.ERROR.HOSTEL_EXISTS || "Hostel with this name already exists", 409);
        }
        
        return await prisma.hostel.create({
            data: {
                name,
                type: type, // Now string
                wardenName,
                capacity: Number(capacity),
                createdBy
            }
        });
    },

    async getAllHostels() {
        return await prisma.hostel.findMany({
            where: { isDeleted: false },
            include: { 
                blocks: { 
                    where: { isDeleted: false },
                    include: { 
                        rooms: { 
                            where: { isDeleted: false },
                            include: { beds: true } 
                        } 
                    } 
                } 
            }
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

    async updateHostel(id: string, data: any) {
        const hostel = await prisma.hostel.findUnique({ where: { id } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

        if (data.name) {
            const duplicate = await prisma.hostel.findFirst({
                where: {
                    name: { equals: data.name, mode: 'insensitive' },
                    id: { not: id }
                }
            });
            if (duplicate) throw new AppError("Hostel with this name already exists", 409);
        }

        return await prisma.hostel.update({
            where: { id },
            data: { 
                name: data.name,
                capacity: data.capacity ? Number(data.capacity) : undefined,
                wardenName: data.wardenName,
                filled: data.filled ? Number(data.filled) : undefined
            }
        });
    },

    async deleteHostel(id: string) {
        const hostel = await prisma.hostel.findUnique({ where: { id } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

        return await prisma.$transaction(async (tx) => {
            const deletedHostel = await tx.hostel.update({
                where: { id },
                data: { isDeleted: true }
            });

            await tx.hostelBlock.updateMany({
                where: { hostelId: id },
                data: { isDeleted: true }
            });

            await tx.hostelRoom.updateMany({
                where: {
                    block: { hostelId: id }
                },
                data: { isDeleted: true }
            });

            return deletedHostel;
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
        const where: any = { isDeleted: false };
        if (hostelId) where.hostelId = hostelId;

        const blocks = await prisma.hostelBlock.findMany({
            where,
            include: { 
                hostel: { select: { name: true } },
                rooms: true 
            }
        });

        return blocks.map(block => ({
            ...block,
            hostelName: block.hostel?.name,
            hostel: undefined // Remove the nested object if you want a clean flat structure, or keep it.
        }));
    },

    async getHostelBlockById(id: string) {
        const block = await prisma.hostelBlock.findUnique({ 
            where: { id },
            include: { rooms: true }
        });
        if (!block) throw new AppError("Hostel Block not found", 404);
        return block;
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
        const { blockId, number, capacity, type, cost } = data;

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
                    cost: Number(cost),
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
        const where: any = { isDeleted: false };
        if (blockId) where.blockId = blockId;

        return await prisma.hostelRoom.findMany({
            where,
            include: { beds: true }
        });
    },

    async getHostelRoomById(id: string) {
        const room = await prisma.hostelRoom.findUnique({ 
            where: { id },
            include: { beds: true }
        });
        if (!room) throw new AppError("Hostel Room not found", 404);
        return room;
    },

    async updateHostelRoom(id: string, data: any, updatedBy?: string) {
        const room = await prisma.hostelRoom.findUnique({ where: { id } });
        if (!room) throw new AppError("Hostel Room not found", 404);

        const updateData: any = { updatedBy };
        if (data.number) updateData.number = data.number;
        if (data.capacity) updateData.capacity = Number(data.capacity);
        if (data.type) updateData.type = data.type;
        if (data.cost !== undefined) updateData.cost = Number(data.cost);
        if (data.blockId) updateData.blockId = data.blockId;

        return await prisma.hostelRoom.update({
            where: { id },
            data: updateData
        });
    },

    async deleteHostelRoom(id: string) {
        const room = await prisma.hostelRoom.findUnique({ where: { id } });
        if (!room) throw new AppError("Hostel Room not found", 404);

        return await prisma.hostelRoom.update({ where: { id }, data: { isDeleted: true } });
    }
};
