import { z } from 'zod';

export const selectExamSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        slotId: z.string().uuid("Invalid Slot ID"),
    }),
});

export const requestCourseChangeSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        newCourse: z.string().min(1, "New course is required"),
        reason: z.string().min(1, "Reason is required"),
    }),
});
