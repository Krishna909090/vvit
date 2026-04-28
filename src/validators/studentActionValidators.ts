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

export const assignHostelSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        hostelId: z.string().uuid("Invalid Hostel ID"),
        hostelPaymentMode: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['YEARWISE', 'SEMWISE'])),
    }),
});

export const allocateBedSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        bedId: z.string().uuid("Invalid Bed ID"),
        academicYearId: z.string().uuid("Invalid Academic Year ID").optional(),
    }),
});

export const bulkAllocateRoomSchema = z.object({
    body: z.object({
        roomId: z.string().uuid("Invalid Room ID"),
        studentIds: z.array(z.string().uuid("Invalid Student ID"))
            .min(1, "At least one student ID required")
            .max(50, "Cannot allocate more than 50 students in a single batch"),
        academicYearId: z.string().uuid("Invalid Academic Year ID").optional(),
    }).refine(
        data => new Set(data.studentIds).size === data.studentIds.length,
        { message: "studentIds contains duplicates", path: ["studentIds"] }
    ),
});

export const reassignHostelSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        hostelId: z.string().uuid("Invalid Hostel ID"),
        bedId: z.string().uuid("Invalid Bed ID"),
        hostelPaymentMode: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['YEARWISE', 'SEMWISE'])),
        reason: z.string().trim().min(1, "Reason is required").max(500),
    }),
});

export const availableBedsQuerySchema = z.object({
    params: z.object({
        hostelId: z.string().uuid("Invalid Hostel ID"),
    }),
    query: z.object({
        sharing: z.string()
            .optional()
            .transform(v => v ? Number(v) : undefined)
            .refine(v => v === undefined || [2, 4, 6, 8, 10].includes(v), {
                message: "Sharing must be 2, 4, 6, 8, or 10"
            }),
        roomType: z.string()
            .optional()
            .transform(v => v ? v.toUpperCase() : undefined)
            .refine(v => v === undefined || v === 'AC' || v === 'NON_AC', {
                message: "Room type must be AC or NON_AC"
            }),
        floor: z.string()
            .optional()
            .transform(v => v ? Number(v) : undefined),
    }),
});

export const pendingHostelAllocationsQuerySchema = z.object({
    query: z.object({
        page: z.string().optional().transform(v => v ? Number(v) : 1),
        limit: z.string().optional().transform(v => v ? Number(v) : 10),
        search: z.string().trim().optional(),
        hostelId: z.string().uuid("Invalid Hostel ID").optional(),
        hostelType: z.string()
            .optional()
            .transform(v => v ? v.toUpperCase() : undefined)
            .refine(v => v === undefined || v === 'BOYS' || v === 'GIRLS', {
                message: "hostelType must be BOYS or GIRLS"
            }),
        gender: z.string().trim().optional(),
    }),
});
