import { z } from 'zod';
import { HostelType } from '@prisma/client';

export const createHostelSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Hostel name is required"),
        type: z.enum(["Boys", "Girls", "BOYS", "GIRLS"]),
        capacity: z.number().int().positive(),

        wardenName: z.string().optional(),
        blockName: z.string().optional(),
        roomNumber: z.string().optional(),
    }),
});

export const updateHostelSchema = z.object({
    params: z.object({
        hostelId: z.string().uuid(),
    }),
    body: z.object({
        name: z.string().optional(),
        capacity: z.number().int().positive().optional(),
        cost: z.number().positive().optional(),
        wardenName: z.string().optional(),
    }),
});

export const createHostelPriceCategorySchema = z.object({
    body: z.object({
        sharing: z.any().transform(val => Number(val)).refine(val => [2, 4, 6, 8, 10].includes(val), "Sharing must be 2, 4, 6, 8, or 10"),
        roomType: z.enum(['AC', 'NON_AC']),
        price: z.number().min(0),
        metadata: z.record(z.string(), z.any()).optional()
    })
});

export const updateHostelPriceCategorySchema = z.object({
    params: z.object({
        id: z.string().uuid()
    }),
    body: z.object({
        sharing: z.any().transform(val => Number(val)).refine(val => [2, 4, 6, 8, 10].includes(val), "Sharing must be 2, 4, 6, 8, or 10").optional(),
        roomType: z.enum(['AC', 'NON_AC']).optional(),
        price: z.number().min(0).optional(),
        metadata: z.record(z.string(), z.any()).optional()
    })
});
