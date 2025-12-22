import { z } from 'zod';

export const uploadQuerySchema = z.object({
    query: z.object({
        folder: z.string().optional(),
    }),
});

export const getPresignedUrlSchema = z.object({
    body: z.object({
        url: z.string().url("Valid URL is required"),
    }),
});
