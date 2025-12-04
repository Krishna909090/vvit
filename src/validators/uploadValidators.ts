import { z } from 'zod';

export const uploadQuerySchema = z.object({
    query: z.object({
        folder: z.string().optional(),
    }),
});
