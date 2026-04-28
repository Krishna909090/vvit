import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import { HostelType } from '@prisma/client';
import { convertToPresignedUrl } from '../../utils/s3Utils';

// Compute occupancy on-demand from source-of-truth tables.
// totalRooms     = COUNT(HostelRoom) for the hostel
// totalBeds      = SUM(HostelRoom.capacity) for the hostel
// filledRooms    = COUNT(HostelRoom where EVERY bed has an active HostelAllocation, and the room has ≥1 bed)
// filledBeds     = COUNT(active HostelAllocation rows in this hostel)
// filledStudents = COUNT(StudentAdmission.hostelId = X, not CANCELLED) — students earmarked for the hostel (some may not yet have a bed)
export const getHostelOccupancy = async (hostelId: string, client: any = prisma) => {
    const [totalRooms, bedsAgg, filledRooms, filledBeds, filledStudents] = await Promise.all([
        client.hostelRoom.count({
            where: { hostelId, isDeleted: false }
        }),
        client.hostelRoom.aggregate({
            where: { hostelId, isDeleted: false },
            _sum: { capacity: true }
        }),
        client.hostelRoom.count({
            where: {
                hostelId,
                isDeleted: false,
                // Has at least one bed AND no bed is missing an active allocation.
                beds: {
                    some: {},
                    none: {
                        OR: [
                            { allocation: null },
                            { allocation: { status: { not: 'ACTIVE' } } }
                        ]
                    }
                }
            }
        }),
        client.hostelAllocation.count({
            where: { status: 'ACTIVE', bed: { room: { hostelId, isDeleted: false } } }
        }),
        client.studentAdmission.count({
            where: { hostelId, status: { not: 'CANCELLED' } }
        })
    ]);
    const totalBeds = bedsAgg._sum.capacity ?? 0;
    return {
        totalRooms,
        filledRooms,
        vacantRooms: Math.max(0, totalRooms - filledRooms),
        totalBeds,
        filledBeds,
        vacantBeds: Math.max(0, totalBeds - filledBeds),
        filledStudents,
    };
};

export const assertHostelHasCapacity = async (hostelId: string, client: any = prisma) => {
    const { totalBeds, filledStudents } = await getHostelOccupancy(hostelId, client);
    if (totalBeds === 0) throw new AppError('Hostel has no rooms configured', 400);
    // Use filledStudents (earmarks) so we don't oversubscribe the hostel even
    // before beds are allocated. Capacity check fires at assign-hostel time.
    if (filledStudents >= totalBeds) throw new AppError(MESSAGES.ERROR.HOSTEL_FULL, 400);
};

export const HostelService = {
    // Hostel
    async createHostel(data: any, createdBy?: string) {
        const { name, type, wardenName, floors, totalRooms, photoUrl,
                accommodationBank, messBank, laundryBank, registrationBank } = data;

        const existingHostel = await prisma.hostel.findFirst({
            where: {
                name: { equals: name, mode: 'insensitive' },
                isDeleted: false
            }
        });

        if (existingHostel) {
            throw new AppError(MESSAGES.ERROR.HOSTEL_EXISTS || "Hostel with this name already exists", 409);
        }

        return await prisma.hostel.create({
            data: {
                name,
                type,
                wardenName,
                floors: floors ? Number(floors) : undefined,
                totalRooms: totalRooms ? Number(totalRooms) : undefined,
                photoUrl: photoUrl || undefined,
                accommodationBank: accommodationBank || undefined,
                messBank: messBank || undefined,
                laundryBank: laundryBank || undefined,
                registrationBank: registrationBank || undefined,
                createdBy
            }
        });
    },

    async getAllHostels() {
        const hostels = await prisma.hostel.findMany({
            where: { isDeleted: false },
            include: {
                rooms: {
                    where: { isDeleted: false },
                    include: { beds: true }
                }
            },
            orderBy: { createdAt: 'asc' }
        });
        const enriched = await Promise.all(hostels.map(async (h) => ({
            ...h,
            photoUrl: await convertToPresignedUrl(h.photoUrl),
            occupancy: await getHostelOccupancy(h.id)
        })));

        const totals = enriched.reduce(
            (acc, h) => {
                acc.totalRooms += h.occupancy.totalRooms;
                acc.filledRooms += h.occupancy.filledRooms;
                acc.vacantRooms += h.occupancy.vacantRooms;
                acc.totalBeds += h.occupancy.totalBeds;
                acc.filledBeds += h.occupancy.filledBeds;
                acc.vacantBeds += h.occupancy.vacantBeds;
                acc.filledStudents += h.occupancy.filledStudents;
                return acc;
            },
            { totalHostels: enriched.length, totalRooms: 0, filledRooms: 0, vacantRooms: 0, totalBeds: 0, filledBeds: 0, vacantBeds: 0, filledStudents: 0 }
        );

        return { hostels: enriched, totals };
    },

    async getHostelById(id: string) {
        const hostel = await prisma.hostel.findUnique({
            where: { id },
            include: { rooms: { include: { beds: true } } }
        });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        return {
            ...hostel,
            photoUrl: await convertToPresignedUrl(hostel.photoUrl),
            occupancy: await getHostelOccupancy(id)
        };
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
                type: data.type,
                wardenName: data.wardenName,
                floors: data.floors !== undefined ? Number(data.floors) : undefined,
                totalRooms: data.totalRooms !== undefined ? Number(data.totalRooms) : undefined,
                photoUrl: data.photoUrl !== undefined ? (data.photoUrl || null) : undefined,
                accommodationBank: data.accommodationBank !== undefined ? (data.accommodationBank || null) : undefined,
                messBank: data.messBank !== undefined ? (data.messBank || null) : undefined,
                laundryBank: data.laundryBank !== undefined ? (data.laundryBank || null) : undefined,
                registrationBank: data.registrationBank !== undefined ? (data.registrationBank || null) : undefined
            }
        });
    },

    async deleteHostel(id: string) {
        const hostel = await prisma.hostel.findUnique({ where: { id } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError("Hostel is already deleted", 400);

        // Block if any non-cancelled student is currently assigned
        const activeStudents = await prisma.studentAdmission.count({
            where: { hostelId: id, status: { not: 'CANCELLED' } }
        });
        if (activeStudents > 0) {
            throw new AppError(
                `Cannot delete hostel — ${activeStudents} student(s) are currently assigned. Re-assign or cancel them first.`,
                400
            );
        }

        // Block if any ACTIVE bed allocation still points here
        const activeAllocations = await (prisma.hostelAllocation as any).count({
            where: { status: 'ACTIVE', bed: { room: { hostelId: id } } }
        });
        if (activeAllocations > 0) {
            throw new AppError(
                `Cannot delete hostel — ${activeAllocations} active bed allocation(s) exist. Vacate them first.`,
                400
            );
        }

        return await prisma.$transaction(async (tx) => {
            const deletedHostel = await tx.hostel.update({
                where: { id },
                data: { isDeleted: true }
            });

            // Soft-delete rooms in this hostel (beds are reached via room.isDeleted filter)
            await tx.hostelRoom.updateMany({
                where: { hostelId: id },
                data: { isDeleted: true }
            });

            return deletedHostel;
        });
    },

    // Hostel Room
    async createHostelRoom(data: any, createdBy?: string) {
        const { hostelId, floor, number, capacity, type } = data;

        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError("Cannot add rooms to a deleted hostel", 400);

        // Floor must be within hostel.floors range
        if (hostel.floors !== null && hostel.floors !== undefined && Number(floor) > hostel.floors) {
            throw new AppError(`Floor ${floor} exceeds hostel's total floors (${hostel.floors})`, 400);
        }

        // Check for duplicate room number in this hostel
        const existing = await prisma.hostelRoom.findFirst({
            where: { hostelId, number, isDeleted: false }
        });
        if (existing) {
            throw new AppError(`Room "${number}" already exists in this hostel`, 409);
        }

        // Check capacity not exceeded
        if (hostel.totalRooms !== null && hostel.totalRooms !== undefined) {
            const currentRoomCount = await prisma.hostelRoom.count({
                where: { hostelId, isDeleted: false }
            });
            if (currentRoomCount + 1 > hostel.totalRooms) {
                throw new AppError(`Hostel is at full room capacity (${hostel.totalRooms})`, 400);
            }
        }

        return await prisma.$transaction(async (tx) => {
            const room = await tx.hostelRoom.create({
                data: {
                    hostelId,
                    floor: Number(floor),
                    number,
                    capacity: Number(capacity),
                    type: type || 'AC',
                    createdBy
                }
            });

            for (let i = 1; i <= Number(capacity); i++) {
                await tx.hostelBed.create({
                    data: {
                        roomId: room.id,
                        number: `${room.number}-${i}`,
                        createdBy
                    }
                });
            }

            return room;
        });
    },

    /**
     * Bulk create rooms by parsing a number range (e.g. A-101 → A-110).
     * Generates one HostelRoom per number, plus beds based on capacity.
     */
    async createHostelRoomsBulk(data: any, createdBy?: string) {
        const { hostelId, floor, roomRangeStart, roomRangeEnd, capacity, type } = data;

        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError("Cannot add rooms to a deleted hostel", 400);

        // Floor must be within hostel.floors range
        if (hostel.floors !== null && hostel.floors !== undefined && Number(floor) > hostel.floors) {
            throw new AppError(`Floor ${floor} exceeds hostel's total floors (${hostel.floors})`, 400);
        }

        // Parse the range — extract trailing digits (validated by zod, but double-check)
        const parseRoomNumber = (s: string) => {
            const match = String(s).trim().match(/^(.*?)(\d+)$/);
            if (!match) throw new AppError(`Invalid room number "${s}". Must end with digits (e.g. A-101).`, 400);
            return { prefix: match[1], num: parseInt(match[2], 10), width: match[2].length };
        };

        const start = parseRoomNumber(roomRangeStart);
        const end = parseRoomNumber(roomRangeEnd);

        const roomNumbers: string[] = [];
        const padWidth = Math.max(start.width, end.width);
        for (let n = start.num; n <= end.num; n++) {
            roomNumbers.push(`${start.prefix}${String(n).padStart(padWidth, '0')}`);
        }

        // Check total rooms wouldn't exceed hostel.totalRooms cap
        if (hostel.totalRooms !== null && hostel.totalRooms !== undefined) {
            const currentRoomCount = await prisma.hostelRoom.count({
                where: { hostelId, isDeleted: false }
            });
            if (currentRoomCount + roomNumbers.length > hostel.totalRooms) {
                throw new AppError(
                    `Adding ${roomNumbers.length} rooms would exceed the hostel's total room capacity (${hostel.totalRooms}). Currently has ${currentRoomCount}.`,
                    400
                );
            }
        }

        // Check for any existing rooms with the same numbers in this hostel
        const existing = await prisma.hostelRoom.findMany({
            where: { hostelId, number: { in: roomNumbers }, isDeleted: false },
            select: { number: true }
        });
        if (existing.length > 0) {
            const dupes = existing.map(r => r.number).join(', ');
            throw new AppError(`These rooms already exist in this hostel: ${dupes}`, 409);
        }

        const cap = Number(capacity);
        const roomType = type || 'AC';

        // Create rooms + beds in a transaction (batched — avoids P2028 timeout for large ranges)
        const result = await prisma.$transaction(async (tx) => {
            // 1. Bulk-insert all rooms in one statement
            await tx.hostelRoom.createMany({
                data: roomNumbers.map(number => ({
                    hostelId,
                    floor: Number(floor),
                    number,
                    capacity: cap,
                    type: roomType,
                    createdBy
                }))
            });

            // 2. Fetch back the inserted rooms to get their generated IDs
            const createdRooms = await tx.hostelRoom.findMany({
                where: { hostelId, number: { in: roomNumbers }, isDeleted: false },
                orderBy: { number: 'asc' }
            });

            // 3. Bulk-insert all beds in one statement
            const bedRows = createdRooms.flatMap(room =>
                Array.from({ length: cap }, (_, i) => ({
                    roomId: room.id,
                    number: `${room.number}-${i + 1}`,
                    createdBy
                }))
            );
            if (bedRows.length > 0) {
                await tx.hostelBed.createMany({ data: bedRows });
            }

            return createdRooms;
        }, { timeout: 30000 }); // Safety: 30s ceiling for very large ranges

        return {
            createdCount: result.length,
            rooms: result
        };
    },

    async getHostelRooms(filters?: { blockId?: string, hostelId?: string, floor?: number, includeBeds?: boolean, roomNumber?: string }) {
        const where: any = { isDeleted: false };
        if (filters?.blockId) where.blockId = filters.blockId;
        if (filters?.hostelId) where.hostelId = filters.hostelId;
        if (filters?.floor !== undefined) where.floor = Number(filters.floor);
        if (filters?.roomNumber) where.number = { contains: filters.roomNumber, mode: 'insensitive' };

        const includeBeds = filters?.includeBeds === true;

        // When includeBeds=true, fetch student details for each occupant.
        // When false, fetch only enough to count (id + allocation status).
        const bedInclude = includeBeds
            ? {
                orderBy: { number: 'asc' as const },
                include: {
                    allocation: {
                        select: {
                            id: true, status: true, startDate: true,
                            student: {
                                select: { id: true, name: true, applicationId: true }
                            }
                        }
                    }
                }
              }
            : {
                select: { id: true, allocation: { select: { status: true } } }
              };

        const rooms = await prisma.hostelRoom.findMany({
            where,
            include: { beds: bedInclude as any },
            orderBy: { createdAt: 'asc' }
        });

        return rooms.map(room => {
            const totalBeds = room.beds.length;
            const filledBeds = room.beds.filter((b: any) => b.allocation && b.allocation.status === 'ACTIVE').length;

            const base = {
                id: room.id,
                hostelId: room.hostelId,
                number: room.number,
                floor: room.floor,
                capacity: room.capacity,
                type: room.type,
                isDeleted: room.isDeleted,
                createdAt: room.createdAt,
                updatedAt: room.updatedAt,
                totalBeds,
                filledBeds,
                vacantBeds: totalBeds - filledBeds,
            };

            if (!includeBeds) return base;

            // Reshape beds to match the detail-view contract
            const beds = (room.beds as any[]).map(bed => {
                const alloc = bed.allocation;
                const isActive = alloc && alloc.status === 'ACTIVE';
                return {
                    id: bed.id,
                    number: bed.number,
                    status: isActive ? 'OCCUPIED' : 'AVAILABLE',
                    occupant: isActive ? {
                        studentId: alloc.student?.id ?? null,
                        name: alloc.student?.name ?? null,
                        applicationId: alloc.student?.applicationId ?? null,
                        allocatedAt: alloc.startDate ?? null
                    } : null
                };
            });

            return { ...base, beds };
        });
    },

    async getHostelRoomById(id: string) {
        const room = await prisma.hostelRoom.findUnique({
            where: { id },
            include: {
                beds: {
                    orderBy: { number: 'asc' },
                    include: {
                        allocation: {
                            select: {
                                id: true, status: true, startDate: true,
                                student: {
                                    select: {
                                        id: true, name: true, applicationId: true,
                                        phone: true, gender: true, profilePhotoUrl: true,
                                        fatherName: true, motherName: true, degreeType: true,
                                        admissionDetails: {
                                            select: {
                                                allottedCourse: { select: { id: true, name: true } }
                                            }
                                        },
                                        documents: {
                                            where: { documentKey: 'HOSTEL_ALLOTMENT_ORDER', isDeleted: false },
                                            select: { url: true, updatedAt: true },
                                            take: 1,
                                            orderBy: { updatedAt: 'desc' }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
        if (!room) throw new AppError("Hostel Room not found", 404);

        // Shape the response: per-bed status + room-level counts.
        // Presign occupant profilePhotoUrl + hostelAllotmentOrder PDF URL (S3 keys → 1h presigned URLs).
        const beds = await Promise.all(room.beds.map(async bed => {
            const alloc: any = (bed as any).allocation;
            const isActive = alloc && alloc.status === 'ACTIVE';
            const student = alloc?.student;
            const allotmentDoc = student?.documents?.[0];
            return {
                id: bed.id,
                number: bed.number,
                status: isActive ? 'OCCUPIED' : 'AVAILABLE',
                occupant: isActive ? {
                    studentId: student?.id ?? null,
                    name: student?.name ?? null,
                    applicationId: student?.applicationId ?? null,
                    phone: student?.phone ?? null,
                    gender: student?.gender ?? null,
                    fatherName: student?.fatherName ?? null,
                    motherName: student?.motherName ?? null,
                    degreeType: student?.degreeType ?? null,
                    allottedCourse: student?.admissionDetails?.allottedCourse?.name ?? null,
                    profilePhotoUrl: await convertToPresignedUrl(student?.profilePhotoUrl ?? null),
                    hostelAllotmentOrderUrl: await convertToPresignedUrl(allotmentDoc?.url ?? null),
                    hostelAllotmentOrderGeneratedAt: allotmentDoc?.updatedAt ?? null,
                    allocatedAt: alloc.startDate ?? null
                } : null
            };
        }));

        const filledBeds = beds.filter(b => b.status === 'OCCUPIED').length;

        return {
            id: room.id,
            hostelId: room.hostelId,
            number: room.number,
            floor: room.floor,
            capacity: room.capacity,
            type: room.type,
            isDeleted: room.isDeleted,
            totalBeds: beds.length,
            filledBeds,
            vacantBeds: beds.length - filledBeds,
            beds,
            createdAt: room.createdAt,
            updatedAt: room.updatedAt
        };
    },

    async updateHostelRoom(id: string, data: any, updatedBy?: string) {
        const room = await prisma.hostelRoom.findUnique({
            where: { id },
            include: { beds: true }
        });
        if (!room) throw new AppError("Hostel Room not found", 404);
        if (room.isDeleted) throw new AppError("Cannot update a deleted room", 400);

        const newCapacity = data.capacity !== undefined ? Number(data.capacity) : room.capacity;
        const newNumber = data.number ?? room.number;
        const currentBedCount = room.beds.length;

        // If renaming, ensure new number doesn't collide in this hostel
        if (newNumber !== room.number) {
            const dupe = await prisma.hostelRoom.findFirst({
                where: { hostelId: room.hostelId, number: newNumber, isDeleted: false, id: { not: id } }
            });
            if (dupe) throw new AppError(`Room "${newNumber}" already exists in this hostel`, 409);
        }

        return await prisma.$transaction(async (tx) => {
            // 1. Update the room itself
            const updateData: any = { updatedBy };
            if (data.number) updateData.number = data.number;
            if (data.capacity !== undefined) updateData.capacity = newCapacity;
            if (data.type) updateData.type = data.type;
            const updatedRoom = await tx.hostelRoom.update({ where: { id }, data: updateData });

            // 2. Sync beds — order by trailing-digit suffix so we always remove highest-numbered beds first
            const sortedBeds = [...room.beds].sort((a, b) => {
                const aNum = parseInt(a.number.split('-').pop() || '0', 10);
                const bNum = parseInt(b.number.split('-').pop() || '0', 10);
                return aNum - bNum;
            });

            // 2a. Capacity decrease — remove surplus beds (block if any are allocated)
            if (newCapacity < currentBedCount) {
                const toRemove = sortedBeds.slice(newCapacity);
                const toRemoveIds = toRemove.map(b => b.id);
                const allocated = await (tx.hostelAllocation as any).count({
                    where: { bedId: { in: toRemoveIds }, status: 'ACTIVE' }
                });
                if (allocated > 0) {
                    throw new AppError(
                        `Cannot reduce capacity to ${newCapacity} — ${allocated} of the beds being removed are currently allocated to students. Vacate them first.`,
                        400
                    );
                }
                await tx.hostelBed.deleteMany({ where: { id: { in: toRemoveIds } } });
            }

            // 2b. Room renamed — rename remaining beds to keep the `${roomNumber}-${i}` convention
            if (newNumber !== room.number) {
                const remaining = newCapacity < currentBedCount
                    ? sortedBeds.slice(0, newCapacity)
                    : sortedBeds;
                for (let i = 0; i < remaining.length; i++) {
                    await tx.hostelBed.update({
                        where: { id: remaining[i].id },
                        data: { number: `${newNumber}-${i + 1}`, updatedBy }
                    });
                }
            }

            // 2c. Capacity increase — append new beds
            if (newCapacity > currentBedCount) {
                const newBeds = [];
                for (let i = currentBedCount + 1; i <= newCapacity; i++) {
                    newBeds.push({ roomId: id, number: `${newNumber}-${i}`, createdBy: updatedBy });
                }
                if (newBeds.length > 0) {
                    await tx.hostelBed.createMany({ data: newBeds });
                }
            }

            return updatedRoom;
        });
    },

    async deleteHostelRoom(id: string) {
        const room = await prisma.hostelRoom.findUnique({ where: { id } });
        if (!room) throw new AppError("Hostel Room not found", 404);
        if (room.isDeleted) throw new AppError("Room is already deleted", 400);

        // Block if any bed in this room is allocated
        const allocated = await (prisma.hostelAllocation as any).count({
            where: { bed: { roomId: id }, status: 'ACTIVE' }
        });
        if (allocated > 0) {
            throw new AppError(
                `Cannot delete room — ${allocated} bed(s) are currently allocated to students. Vacate them first.`,
                400
            );
        }

        return await prisma.hostelRoom.update({ where: { id }, data: { isDeleted: true } });
    }
};
