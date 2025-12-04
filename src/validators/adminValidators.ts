import { z } from 'zod';
import { AccommodationType, HostelType } from '@prisma/client';

export const enableExamSchema = z.object({
    body: z.object({
        studentIds: z.array(z.string().uuid()),
        testDate: z.string().datetime().or(z.date()), // Accept ISO string or Date object
        testCenter: z.string().min(1, "Test center is required"),
    }),
});

export const markAttendanceSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        attended: z.boolean(),
    }),
});

export const verifyAndAllotSeatSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        approved: z.boolean(),
        allottedBranch: z.string().optional(), // Required if approved is true, but we can refine this
    }).refine((data) => !data.approved || (data.approved && data.allottedBranch), {
        message: "Allotted branch is required when approved is true",
        path: ["allottedBranch"],
    }),
});

export const changeBranchSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        newBranch: z.string().min(1, "New branch is required"),
        reason: z.string().min(1, "Reason is required"),
    }),
});

export const approveBranchChangeSchema = z.object({
    body: z.object({
        requestId: z.string().uuid(),
        approved: z.boolean(),
    }),
});

export const createDiscountRequestSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        reason: z.string().min(1, "Reason is required"),
        documentUrl: z.string().url("Invalid URL").optional(),
    }),
});

export const reviewDiscountRequestSchema = z.object({
    body: z.object({
        requestId: z.string().uuid(),
        remarks: z.string().optional(),
    }),
});

export const approveDiscountSchema = z.object({
    body: z.object({
        requestId: z.string().uuid(),
        approved: z.boolean(),
    }),
});

export const requestCancellationSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        reason: z.string().min(1, "Reason is required"),
        refundAmount: z.number().min(0).or(z.string().transform(val => Number(val))),
    }),
});

export const approveCancellationSchema = z.object({
    body: z.object({
        requestId: z.string().uuid(),
        approved: z.boolean(),
    }),
});

export const updateExamScoreSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        score: z.number().min(0),
        cutoff: z.number().min(0),
    }),
});

export const createTransportRouteSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Route name is required"),
        cost: z.number().min(0),
        busNumber: z.string().min(1, "Bus number is required"),
        capacity: z.number().int().min(1, "Capacity must be at least 1"),
    }),
});

export const updateAdmissionDetailsSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        accommodationType: z.nativeEnum(AccommodationType),
        hostelType: z.nativeEnum(HostelType).optional().nullable(),
        hostelId: z.string().uuid().optional().nullable(),
        transportRouteId: z.string().optional().nullable(),
        paidAmount: z.number().min(0).optional(),
    }).refine((data) => {
        if (data.accommodationType === AccommodationType.HOSTEL) {
            return !!data.hostelType;
        }
        return true;
    }, {
        message: "Hostel type is required when accommodation type is HOSTEL",
        path: ["hostelType"],
    }).refine((data) => {
        if (data.accommodationType === AccommodationType.TRANSPORT) {
            return !!data.transportRouteId;
        }
        return true;
    }, {
        message: "Transport route ID is required when accommodation type is TRANSPORT",
        path: ["transportRouteId"],
    }),
});

export const getAllApplicationsSchema = z.object({
    query: z.object({
        page: z.string().transform(val => Number(val)).optional(),
        limit: z.string().transform(val => Number(val)).optional(),
        search: z.string().optional(),
    }),
});

export const studentIdParamSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
});

export const addAdminSchema = z.object({
    body: z.object({
        phone: z.string().min(10, "Phone number is required"),
        name: z.string().optional(),
        email: z.string().email().optional(),
    }),
});

export const getAgentCommissionsSchema = z.object({
    query: z.object({
        agentId: z.string().uuid().optional(),
    }),
});

export const createBranchSchema = z.object({
    body: z.object({
        code: z.string().min(1, "Branch code is required"),
        name: z.string().min(1, "Branch name is required"),
        totalSeats: z.number().int().min(1, "Total seats must be at least 1"),
    }),
});

// ERP Schemas

// Academics
export const createDepartmentSchema = z.object({
    body: z.object({
        name: z.string().min(1),
        code: z.string().min(1),
    }),
});

export const createProgramSchema = z.object({
    body: z.object({
        name: z.string().min(1),
        departmentId: z.string().uuid(),
    }),
});

export const createBatchSchema = z.object({
    body: z.object({
        name: z.string().min(1),
        programId: z.string().uuid(),
        startDate: z.string().datetime().or(z.date()),
        endDate: z.string().datetime().or(z.date()),
    }),
});

export const createSectionSchema = z.object({
    body: z.object({
        name: z.string().min(1),
        batchId: z.string().uuid(),
    }),
});

// Hostel
export const createHostelBlockSchema = z.object({
    body: z.object({
        hostelId: z.string().uuid(),
        name: z.string().min(1),
        type: z.string().min(1),
    }),
});

export const createHostelRoomSchema = z.object({
    body: z.object({
        blockId: z.string().uuid(),
        number: z.string().min(1),
        capacity: z.number().int().positive(),
        type: z.string().min(1),
    }),
});

// Transport
export const createVehicleSchema = z.object({
    body: z.object({
        number: z.string().min(1),
        capacity: z.number().int().positive(),
        driverName: z.string().min(1),
        driverPhone: z.string().min(10),
    }),
});

export const createTransportStopSchema = z.object({
    body: z.object({
        routeId: z.string().uuid(),
        name: z.string().min(1),
        sequence: z.number().int().min(1),
        pickupTime: z.string().datetime().or(z.date()),
        dropTime: z.string().datetime().or(z.date()),
    }),
});

// Finance
export const createAcademicYearSchema = z.object({
    body: z.object({
        code: z.string().min(1, "Code is required"),
        startDate: z.string().datetime().or(z.date()),
        endDate: z.string().datetime().or(z.date()),
        isActive: z.boolean().optional(),
    }),
});

export const createFeeHeadSchema = z.object({
    body: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
    }),
});

export const createFeeStructureSchema = z.object({
    body: z.object({
        programId: z.string().uuid(),
        feeHeadId: z.string().uuid(),
        amount: z.number().positive(),
        academicYearId: z.string().uuid(),
    }),
});
