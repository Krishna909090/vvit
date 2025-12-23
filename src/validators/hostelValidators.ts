import { z } from 'zod';
import { HostelType } from '@prisma/client';

export const createHostelSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Hostel name is required"),
        type: z.enum(["Boys", "Girls", "BOYS", "GIRLS"]),
        capacity: z.number().int().positive(),
        cost: z.number().positive(),
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
