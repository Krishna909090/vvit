import { z } from 'zod';

/**
 * Optional admin pricing overrides shared across accommodation/transport flows.
 * When present they fully replace the config tier / route cost (the system value
 * is not consulted), so every charged amount must be supplied. Use 0 to skip a
 * component. Supplying an override additionally requires `student.pricing.override`.
 */
const hostelCustomPricingField = z.object({
    accommodation: z.number().min(0, "accommodation must be >= 0"),
    mess: z.number().min(0, "mess must be >= 0"),
    laundry: z.number().min(0, "laundry must be >= 0"),
    registration: z.number().min(0, "registration must be >= 0"),
}).optional();

const transportCustomCostField = z.number().min(0, "customCost must be >= 0").optional();

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
        customPricing: hostelCustomPricingField,
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
        customPricing: hostelCustomPricingField,
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
        customCost: transportCustomCostField,
    }),
});

export const reassignTransportSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        transportRouteId: z.string().uuid("Invalid Transport Route ID"),
        reason: z.string().trim().min(1, "Reason is required").max(500),
        customCost: transportCustomCostField,
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
        customCost: transportCustomCostField,
    }),
});

export const switchTransportToHostelSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        chargeRetained: z.number().min(0).optional().default(0),
        reason: z.string().trim().min(1, "Reason is required").max(500),
        // Optional — the switch commits by sharing tier; the specific hostel/bed is
        // assigned later (assign-hostel/allocate-bed).
        hostelId: z.string().uuid("Invalid Hostel ID").optional(),
        hostelPaymentMode: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['YEARWISE', 'SEMWISE'])),
        hostelType: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['SHARING_2', 'SHARING_4', 'SHARING_6', 'SHARING_8', 'SHARING_10'])),
        customPricing: hostelCustomPricingField,
    }),
});

/* ───── Preview (dry-run) schemas ─────
 * Same body as the write counterpart but `reason` is omitted — a preview
 * doesn't record anything, so no reason is needed.
 */
export const reassignHostelPreviewSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        hostelId: z.string().uuid("Invalid Hostel ID"),
        bedId: z.string().uuid("Invalid Bed ID"),
        hostelPaymentMode: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['YEARWISE', 'SEMWISE'])),
        customPricing: hostelCustomPricingField,
    }),
});

export const cancelHostelPreviewSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        cancellationFee: z.number().min(0).optional().default(0),
    }),
});

export const cancelTransportPreviewSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        cancellationFee: z.number().min(0).optional().default(0),
    }),
});

export const switchHostelToTransportPreviewSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        chargeRetained: z.number().min(0).optional().default(0),
        transportRouteId: z.string().uuid("Invalid Transport Route ID"),
        customCost: transportCustomCostField,
    }),
});

export const switchTransportToHostelPreviewSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        chargeRetained: z.number().min(0).optional().default(0),
        // Optional for the preview — pricing is keyed by sharing, not the specific
        // hostel; the hostel/bed is chosen later at assign-hostel/allocate-bed.
        hostelId: z.string().uuid("Invalid Hostel ID").optional(),
        hostelPaymentMode: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['YEARWISE', 'SEMWISE'])),
        hostelType: z.string()
            .transform(v => v.toUpperCase())
            .pipe(z.enum(['SHARING_2', 'SHARING_4', 'SHARING_6', 'SHARING_8', 'SHARING_10'])),
        customPricing: hostelCustomPricingField,
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
        hostelType: z.enum(['SHARING_2', 'SHARING_4', 'SHARING_6', 'SHARING_8', 'SHARING_10']).optional(),
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
