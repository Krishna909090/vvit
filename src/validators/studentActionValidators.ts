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
        hostelType: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['SHARING_2', 'SHARING_4', 'SHARING_6', 'SHARING_8', 'SHARING_10'])),
    }),
});

export const allocateBedSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        bedId: z.string().uuid("Invalid Bed ID"),
        hostelId: z.string().uuid("Invalid Hostel ID").optional(),
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
            .refine(v => v === undefined || ['SHARING_2', 'SHARING_4', 'SHARING_6', 'SHARING_8', 'SHARING_10'].includes(v), {
                message: "hostelType must be SHARING_2, SHARING_4, SHARING_6, SHARING_8, or SHARING_10"
            }),
        gender: z.string().trim().optional(),
    }),
});

export const assignTransportSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        transportRouteId: z.string().uuid("Invalid Transport Route ID"),
    }),
});

export const reassignTransportSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        transportRouteId: z.string().uuid("Invalid Transport Route ID"),
        reason: z.string().trim().min(1, "Reason is required").max(500),
    }),
});

export const cancelHostelSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        cancellationFee: z.number().min(0).optional().default(0),
        reason: z.string().trim().min(1, "Reason is required").max(500),
    }),
});

export const cancelTransportSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        cancellationFee: z.number().min(0).optional().default(0),
        reason: z.string().trim().min(1, "Reason is required").max(500),
    }),
});

export const switchHostelToTransportSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        // What the college keeps as a non-refundable charge for the period the student
        // actually used the hostel (e.g. prorated for 2 months).
        // refundPool = max(0, hostelPaid − chargeRetained)
        chargeRetained: z.number().min(0).optional().default(0),
        reason: z.string().trim().min(1, "Reason is required").max(500),
        transportRouteId: z.string().uuid("Invalid Transport Route ID"),
    }),
});

export const switchTransportToHostelSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        chargeRetained: z.number().min(0).optional().default(0),
        reason: z.string().trim().min(1, "Reason is required").max(500),
        hostelId: z.string().uuid("Invalid Hostel ID"),
        hostelPaymentMode: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['YEARWISE', 'SEMWISE'])),
        hostelType: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['SHARING_2', 'SHARING_4', 'SHARING_6', 'SHARING_8', 'SHARING_10'])),
    }),
});

export const bedAllocatedStudentsQuerySchema = z.object({
    query: z.object({
        page: z.string().optional().transform(v => v ? Number(v) : 1),
        limit: z.string().optional().transform(v => v ? Number(v) : 10),
        search: z.string().trim().optional(),
        gender: z.string().trim().optional(),
        all: z.string().optional().transform(v => v === 'true' || v === '1'),
    }),
});

export const transportAllocatedStudentsQuerySchema = z.object({
    query: z.object({
        page: z.string().optional().transform(v => v ? Number(v) : 1),
        limit: z.string().optional().transform(v => v ? Number(v) : 10),
        search: z.string().trim().optional(),
        gender: z.string().trim().optional(),
        routeId: z.string().uuid("Invalid Route ID").optional(),
        all: z.string().optional().transform(v => v === 'true' || v === '1'),
    }),
});

export const hostelPaidStudentsQuerySchema = z.object({
    query: z.object({
        page: z.string().optional().transform(v => v ? Number(v) : 1),
        limit: z.string().optional().transform(v => v ? Number(v) : 10),
        search: z.string().trim().optional(),
        gender: z.string().trim().optional(),
        all: z.string().optional().transform(v => v === 'true' || v === '1'),
    }),
});

export const transportPaidStudentsQuerySchema = z.object({
    query: z.object({
        page: z.string().optional().transform(v => v ? Number(v) : 1),
        limit: z.string().optional().transform(v => v ? Number(v) : 10),
        search: z.string().trim().optional(),
        gender: z.string().trim().optional(),
        routeId: z.string().uuid("Invalid Route ID").optional(),
        all: z.string().optional().transform(v => v === 'true' || v === '1'),
    }),
});

export const studentsByHostelSchema = z.object({
    params: z.object({
        hostelId: z.string().uuid("Invalid Hostel ID"),
    }),
    query: z.object({
        page: z.string().optional().transform(v => v ? Number(v) : 1),
        limit: z.string().optional().transform(v => v ? Number(v) : 10),
        search: z.string().trim().optional(),
        hostelType: z.string()
            .optional()
            .transform(v => v ? v.toUpperCase() : undefined)
            .refine(v => v === undefined || ['SHARING_2', 'SHARING_4', 'SHARING_6', 'SHARING_8', 'SHARING_10'].includes(v), {
                message: "hostelType must be SHARING_2, SHARING_4, SHARING_6, SHARING_8, or SHARING_10"
            }),
        gender: z.string().trim().optional(),
        allottedCourseId: z.string().uuid("Invalid Course ID").optional(),
        allocationStatus: z.string()
            .optional()
            .transform(v => v ? v.toUpperCase() : undefined)
            .refine(v => v === undefined || v === 'ALLOCATED' || v === 'NOT_ALLOCATED', {
                message: "allocationStatus must be ALLOCATED or NOT_ALLOCATED"
            }),
    }),
});
