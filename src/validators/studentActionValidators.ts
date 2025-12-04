import { z } from 'zod';

export const selectExamSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        slotId: z.string().uuid("Invalid Slot ID"),
    }),
});

export const requestBranchChangeSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        newBranch: z.string().min(1, "New branch is required"),
        reason: z.string().min(1, "Reason is required"),
    }),
});
