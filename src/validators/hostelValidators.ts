import { z } from 'zod';
import { HostelType } from '@prisma/client';

const ROOM_NUMBER_PATTERN = /^[A-Za-z0-9\-_/]+\d+$/;

const bankEnum = () => z.string().transform(v => v.toUpperCase()).pipe(z.enum(['TRUST', 'LLP'])).optional();

export const createHostelSchema = z.object({
    body: z.object({
        name: z.string().trim().min(1, "Hostel name is required").max(100, "Hostel name too long"),
        type: z.string().transform((val) => val.toUpperCase()).pipe(z.enum(["BOYS", "GIRLS"])),
        floors: z.number().int("Floors must be an integer").min(1, "Floors must be at least 1").max(50, "Floors cannot exceed 50"),
        totalRooms: z.number().int("Total rooms must be an integer").min(1, "Total rooms must be at least 1").max(2000, "Total rooms cannot exceed 2000"),
        wardenName: z.string().trim().min(1, "Warden name is required").max(100, "Warden name too long"),
        photoUrl: z.string().url("Photo URL must be a valid URL").optional().or(z.literal('')),

        // Bank routing — defaults applied if omitted
        accommodationBank: bankEnum(),
        messBank: bankEnum(),
        laundryBank: bankEnum(),
        registrationBank: bankEnum(),
    }),
});

export const updateHostelSchema = z.object({
    params: z.object({
        hostelId: z.string().uuid("Invalid Hostel ID"),
    }),
    body: z.object({
        name: z.string().trim().min(1).max(100).optional(),
        type: z.string().transform((val) => val.toUpperCase()).pipe(z.enum(["BOYS", "GIRLS"])).optional(),
        floors: z.number().int().min(1).max(50).optional(),
        totalRooms: z.number().int().min(1).max(2000).optional(),
        wardenName: z.string().trim().min(1).max(100).optional(),
        photoUrl: z.string().url().optional().or(z.literal('')),
        accommodationBank: bankEnum(),
        messBank: bankEnum(),
        laundryBank: bankEnum(),
        registrationBank: bankEnum(),
    }).refine(
        (data) => Object.values(data).some(v => v !== undefined),
        { message: "At least one field must be provided to update" }
    ),
});

export const createHostelRoomsBulkSchema = z.object({
    body: z.object({
        hostelId: z.string().uuid("Invalid Hostel ID"),
        floor: z.number().int().min(1, "Floor must be at least 1").max(50, "Floor cannot exceed 50"),
        roomRangeStart: z.string().trim().min(1, "Room range start is required")
            .regex(ROOM_NUMBER_PATTERN, "Room range start must end with digits (e.g. A-101)"),
        roomRangeEnd: z.string().trim().min(1, "Room range end is required")
            .regex(ROOM_NUMBER_PATTERN, "Room range end must end with digits (e.g. A-110)"),
        capacity: z.number().int().refine(v => [2, 4, 6, 8, 10].includes(v), { message: "Capacity must be 2, 4, 6, 8, or 10" }),
        type: z.string().transform(v => v.toUpperCase()).pipe(z.enum(['AC', 'NON_AC'])).optional().default('AC'),
    }).refine(data => {
        // Both start and end must share the same prefix
        const startMatch = data.roomRangeStart.match(/^(.*?)(\d+)$/);
        const endMatch = data.roomRangeEnd.match(/^(.*?)(\d+)$/);
        if (!startMatch || !endMatch) return false;
        return startMatch[1] === endMatch[1];
    }, { message: "Room range start and end must share the same prefix (e.g. both 'A-')", path: ["roomRangeEnd"] })
    .refine(data => {
        const startNum = parseInt(data.roomRangeStart.match(/\d+$/)?.[0] || '0', 10);
        const endNum = parseInt(data.roomRangeEnd.match(/\d+$/)?.[0] || '0', 10);
        return endNum >= startNum;
    }, { message: "Room range end number must be >= start number", path: ["roomRangeEnd"] })
    .refine(data => {
        const startNum = parseInt(data.roomRangeStart.match(/\d+$/)?.[0] || '0', 10);
        const endNum = parseInt(data.roomRangeEnd.match(/\d+$/)?.[0] || '0', 10);
        return (endNum - startNum + 1) <= 500;
    }, { message: "Cannot create more than 500 rooms in a single batch", path: ["roomRangeEnd"] })
});

export const createHostelRoomSchema = z.object({
    body: z.object({
        hostelId: z.string().uuid("Invalid Hostel ID"),
        floor: z.number().int().min(1).max(50),
        number: z.string().trim().min(1, "Room number is required").regex(ROOM_NUMBER_PATTERN, "Room number must end with digits (e.g. A-101)"),
        capacity: z.number().int().refine(v => [2, 4, 6, 8, 10].includes(v), { message: "Capacity must be 2, 4, 6, 8, or 10" }),
        type: z.string().transform(v => v.toUpperCase()).pipe(z.enum(['AC', 'NON_AC'])).optional().default('AC'),
    })
});

export const updateHostelRoomSchema = z.object({
    params: z.object({
        id: z.string().uuid("Invalid Room ID"),
    }),
    body: z.object({
        number: z.string().trim().regex(ROOM_NUMBER_PATTERN, "Room number must end with digits").optional(),
        floor: z.number().int().min(1).max(50).optional(),
        capacity: z.number().int().refine(v => [2, 4, 6, 8, 10].includes(v), { message: "Capacity must be 2, 4, 6, 8, or 10" }).optional(),
        type: z.string().transform(v => v.toUpperCase()).pipe(z.enum(['AC', 'NON_AC'])).optional(),
    }).refine(
        (data) => Object.values(data).some(v => v !== undefined),
        { message: "At least one field must be provided to update" }
    ),
});

export const hostelIdParamSchema = z.object({
    params: z.object({
        hostelId: z.string().uuid("Invalid Hostel ID"),
    })
});

export const roomIdParamSchema = z.object({
    params: z.object({
        id: z.string().uuid("Invalid Room ID"),
    })
});

export const createHostelPriceCategorySchema = z.object({
    body: z.object({
        sharing: z.any().transform(val => Number(val)).refine(val => [2, 4, 6, 8, 10].includes(val), "Sharing must be 2, 4, 6, 8, or 10"),
        roomType: z.string().transform(v => v.toUpperCase()).pipe(z.enum(['AC', 'NON_AC'])),
        academicYearId: z.string().uuid('academicYearId must be a valid UUID'),

        // Yearwise (Single Instalment)
        accommodationYearwise: z.number().min(0).optional(),
        messYearwise: z.number().min(0).optional(),
        laundryYearwise: z.number().min(0).optional(),

        // Semwise (Two Instalment) — total amount across both instalments
        accommodationSemwise: z.number().min(0).optional(),
        messSemwise: z.number().min(0).optional(),
        laundrySemwise: z.number().min(0).optional(),

        // One-time non-refundable
        registrationFee: z.number().min(0).optional(),

        metadata: z.record(z.string(), z.any()).optional(),
        isActive: z.boolean().optional()
    })
});

export const updateHostelPriceCategorySchema = z.object({
    params: z.object({
        id: z.string().uuid()
    }),
    body: z.object({
        sharing: z.any().transform(val => Number(val)).refine(val => [2, 4, 6, 8, 10].includes(val), "Sharing must be 2, 4, 6, 8, or 10").optional(),
        roomType: z.string().transform(v => v.toUpperCase()).pipe(z.enum(['AC', 'NON_AC'])).optional(),

        accommodationYearwise: z.number().min(0).optional(),
        messYearwise: z.number().min(0).optional(),
        laundryYearwise: z.number().min(0).optional(),
        accommodationSemwise: z.number().min(0).optional(),
        messSemwise: z.number().min(0).optional(),
        laundrySemwise: z.number().min(0).optional(),
        registrationFee: z.number().min(0).optional(),

        metadata: z.record(z.string(), z.any()).optional(),
        isActive: z.boolean().optional()
    }).refine(
        (data) => Object.values(data).some(v => v !== undefined),
        { message: "At least one field must be provided to update" }
    )
});
