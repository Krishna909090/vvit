import { z } from 'zod';
import { AccommodationType, HostelType, PaymentMethod, HostelPaymentMode } from '@prisma/client';
import { Role } from '../constants/roles';

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
        allottedCourseId: z.string().uuid().optional(), // Required if approved is true, but we can refine this
    }).refine((data) => !data.approved || (data.approved && data.allottedCourseId), {
        message: "Allotted course ID is required when approved is true",
        path: ["allottedCourseId"],
    }),
});

export const changeCourseSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        newCourseId: z.string().uuid("Invalid Course ID"),
        reason: z.string().min(1, "Reason is required"),
    }),
});

export const approveCourseChangeSchema = z.object({
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
        referredBy: z.string().optional(),
        // New optional flag to bypass duplicate‑request check
        forceCreate: z.boolean().optional(),
        items: z.array(z.object({
            feeHeadId: z.string().optional().nullable(),
            component: z.string().min(1, "Component is required"),
            amount: z.number().min(0, "Amount must be non-negative")
        })).min(1, "At least one component is required"),
    }),
});

export const approveDiscountSchema = z.object({
    body: z.object({
        requestId: z.string().uuid(),
        approved: z.boolean(),
        approvedItems: z.array(z.object({
            component: z.string().min(1),
            approvedAmount: z.number().min(0)
        })).optional(),
        remarks: z.string().optional(),
        // New optional flag to bypass conflict check
        forceApprove: z.boolean().optional(),
    }),
});

export const updateDiscountRequestSchema = z.object({
    params: z.object({
        id: z.string().uuid("Invalid Request ID"),
    }),
    body: z.object({
        reason: z.string().min(1, "Reason is required"),
        documentUrl: z.string().url("Invalid URL").optional(),
        referredBy: z.string().optional(),
        items: z.array(z.object({
            feeHeadId: z.string().optional().nullable(),
            component: z.string().min(1, "Component is required"),
            amount: z.number().min(0, "Amount must be non-negative")
        })).min(1, "At least one component is required"),
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
        city: z.string().min(1, "City is required"),
        cost: z.number().min(0),
        busNumber: z.string().min(1, "Bus number is required"),
        capacity: z.number().int().min(1, "Capacity must be at least 1"),
        vehicleId: z.string().uuid().optional().nullable(),
    }),
});

export const updateAdmissionDetailsSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        accommodationType: z.nativeEnum(AccommodationType),
        hostelType: z.nativeEnum(HostelType).optional().nullable(),
        hostelId: z.string().uuid().optional().nullable(),
        transportRouteId: z.string().optional().nullable(),
        hostelPaymentMode: z.nativeEnum(HostelPaymentMode).optional().nullable(),
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
        status: z.string().optional(),
        quotaType: z.string().optional(),
        degreeType: z.string().optional(),
        applicationId: z.string().optional(),
        isScholarshipEligible: z.string().optional(),
        hasDocuments: z.string().optional(),
        createdBy: z.string().optional(),
        qualificationVerifiedBy: z.string().optional(),
        gender: z.string().optional(),
        pref1: z.string().optional(),
        pref2: z.string().optional(),
        pref3: z.string().optional(),
        applicationFeePaid: z.string().optional(),
        examDate: z.string().optional(),
        qualificationVerified: z.string().optional(),
        certificateStatus: z.string().optional(),
        qualificationLevel: z.string().optional(),
        qualificationBoard: z.string().optional(),
        marks10thMin: z.string().optional(),
        marks10thMax: z.string().optional(),
        marks12thMin: z.string().optional(),
        marks12thMax: z.string().optional(),
        certificatesApproved: z.string().optional(),
        seatStatus: z.string().optional(),
        scholarship: z.string().optional(),
        scholarshipPercentage: z.string().optional(),
        program: z.string().optional(),
        branch: z.string().optional(),
        facilities: z.string().optional(),
        discountApplied: z.string().optional(),
        branchChange: z.string().optional(),
        seatCancellation: z.string().optional(),
        cancellationReason: z.string().optional(),
        allotmentOrder: z.string().optional(),
    }),
});

export const getApplicationsExtendedSchema = z.object({
    query: z.object({
        page: z.string().transform(val => Number(val)).optional(),
        limit: z.string().transform(val => Number(val)).optional(),
        search: z.string().optional(),
        status: z.string().optional(),
        quotaType: z.string().optional(),
        courseType: z.string().optional(),
        degree: z.string().optional(),
        gender: z.string().optional(),
        preference: z.string().optional(),
        paymentStatus: z.string().optional(),
        applicationId: z.string().optional(),
        isScholarshipEligible: z.string().optional(),
        hasDocuments: z.string().optional(),
    }),
});

export const studentIdParamSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
});

const AllowedRoles = ["ADMIN", "SUPER_ADMIN", "STAFF", "INVIGILATOR", "VERIFICATION_OFFICER"] as const;

export const addAdminSchema = z.object({
  body: z.object({
    phone: z
      .string()
      .min(1, "Phone number is required")
      .min(10, "Phone number must be at least 10 digits")
      .max(15, "Phone number must be at most 15 digits")
      .regex(/^\d+$/, "Phone number must contain only digits"),
    name: z.string().trim().optional(),
    email: z.string().email("Invalid email address").optional(),

    role: z
      .string()
      .optional()
      .transform((val) => val ? val.toUpperCase() : val),
    groupIds: z.array(z.string().uuid("Invalid Group ID")).optional(),
  }),
});

export const addInvigilatorSchema = z.object({
  body: z.object({
    phone: z
      .string()
      .min(1, "Phone number is required")
      .min(10, "Phone number must be at least 10 digits")
      .max(15, "Phone number must be at most 15 digits")
      .regex(/^\d+$/, "Phone number must contain only digits"),
    name: z.string().trim().optional(),
    email: z.string().email("Invalid email address").optional(),
  }),
});

export const getAgentCommissionsSchema = z.object({
    query: z.object({
        agentId: z.string().uuid().optional(),
    }),
});

export const createSpecializationSchema = z.object({
    body: z.object({
        code: z.string().min(1, "code is required"),
        name: z.string().min(1, "name is required"),
        courseId: z.string().uuid("This refers to Course ID"),
        totalSeats: z.number().int().min(1, "Total seats must be at least 1"),
    }),
});

// ERP Schemas

// Academics
export const createSchoolSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Name is required"),
        code: z.string().min(1, "Code is required"),
    }),
});

export const createDepartmentSchema = z.object({
    body: z.object({
        name: z.string().min(1),
        code: z.string().min(1),
        schoolId: z.string().uuid().optional(),
    }),
});

export const createCourseSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Name is required"),
        code: z.string().min(1, "Code is required"),
        departmentId: z.string().uuid("Invalid Department ID"),
        degree: z.string().optional(),
        totalSeats: z.number().int().min(0).optional(),
        omrId: z.number().int().optional(),
    }),
});

export const createBatchSchema = z.object({
    body: z.object({
        name: z.string().min(1),
        specializationId: z.string().uuid(),
        startDate: z.coerce.date(),
        endDate: z.coerce.date(),
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
        capacity: z.number().int().refine(val => [2, 4, 8].includes(val), { message: "Capacity must be 2, 4, or 8" }),
        type: z.enum(["AC", "Non-AC", "ac", "non-ac"]),
        cost: z.number().positive(),
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
        courseId: z.string().uuid(),
        feeHeadId: z.string().uuid(),
        amount: z.number().positive(),
        academicYearId: z.string().uuid(),
        quotaType: z.string().optional(),
        courseType: z.string().optional(),
        degreeId: z.string().uuid().optional(),
        yearOfStudy: z.number().int().min(1).max(10).optional(),
        dueDate: z.string().datetime().or(z.date()).optional(),
    }),
});

export const createBulkFeeStructureSchema = z.object({
    body: z.object({
        degreeType: z.string().min(1),
        feeHeadId: z.string().uuid(),
        amount: z.number().positive(),
        academicYearId: z.string().uuid(),
        quotaType: z.string().optional(),
        courseType: z.string().optional(),
        yearOfStudy: z.number().int().min(1).max(10).optional(),
        dueDate: z.string().datetime().or(z.date()).optional(),
    }),
});

export const updateStaffUserSchema = z.object({
    params: z.object({
        userId: z.string().uuid('Invalid user ID'),
    }),
    body: z.object({
        name: z.string().trim().min(1, 'Name cannot be empty').optional(),
        email: z.string().email('Invalid email address').optional(),
        role: z.string().refine(val => Object.values(Role).includes(val as any)).optional(),
        isDeleted: z.boolean().optional(),
    }).refine(
        (data) => data.name !== undefined || data.email !== undefined || data.role !== undefined || data.isDeleted !== undefined,
        {
            message: 'At least one field (name, email, or role) must be provided',
        }
    ),
});

export const generateFeeDemandsSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        courseId: z.string().uuid(),
        academicYearId: z.string().uuid(),
    }),
});

export const setEligibleScholarshipSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        ruleId: z.string().uuid(),
    }),
});

export const submitVerificationSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        class12Aggregate: z.number().min(0).max(100).optional(),
        jeePercentile: z.number().min(0).max(100).optional(),
        satScore: z.number().min(400).max(1600).optional(),
        vvitPercentile: z.number().min(0).max(100).optional(),
    }).refine(data => data.class12Aggregate !== undefined || data.jeePercentile !== undefined || data.satScore !== undefined || data.vvitPercentile !== undefined, {
        message: "At least one score must be provided",
    }),
});

export const updateStudentPersonalDetailsSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        name: z.string().min(1).optional(),
        fatherName: z.string().min(1).optional(),
        motherName: z.string().min(1).optional(),
        gender: z.string().min(1).optional(),
        dob: z.coerce.date().optional(),
        email: z.string().email().optional(),
        category: z.string().min(1).optional(),
        address: z.string().min(1).optional(),
        address2: z.string().optional(),
        city: z.string().min(1).optional(),
        state: z.string().min(1).optional(),
        pincode: z.string().min(1).optional(),
        country: z.string().min(1).optional(),
        profilePhotoUrl: z.string().url().optional(),
        aadharNumber: z.string().optional(),
        pref1: z.string().uuid("Invalid Course ID").optional(),
        pref2: z.string().uuid("Invalid Course ID").optional(),
        pref3: z.string().uuid("Invalid Course ID").optional(),
    }).refine(data => {
        const forbiddenKeys = ['phone', 'phoneNumber'];
        const keys = Object.keys(data);
        return !keys.some(k => forbiddenKeys.includes(k));
    }, {
        message: "Updates to phone number are not allowed through this API.",
    }),
});

export const updateAcademicQualificationSchema = z.object({
    params: z.object({
        id: z.string().uuid("Invalid Qualification ID"),
    }),
    body: z.object({
        level: z.string().min(1).optional(),
        board: z.string().optional(),
        yearOfPassing: z.string().min(1).optional(),
        hallTicketNumber: z.string().min(1).optional(),
        gpaOrMarks: z.string().min(1).optional(),
    }).refine(data => Object.keys(data).length > 0, {
        message: "At least one field must be provided for update",
    }),
});


export const deleteAcademicQualificationSchema = z.object({
    params: z.object({
        id: z.string().uuid("Invalid Qualification ID"),
    }),
});

export const finalizeAdmissionSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        payment: z.object({
            method: z.nativeEnum(PaymentMethod),
            amount: z.number().positive(),
            referenceNumber: z.string().optional(),
            date: z.string().datetime().or(z.date()).optional(),
            feeHeadId: z.string().uuid().optional(), 
            feeStructureId: z.string().uuid().optional(),
        }),
        scholarship: z.object({
            percentage: z.number().min(0).max(100).nullable(),
            ruleId: z.string().uuid().optional(),
        }).nullable(),
        allocation: z.object({
            type: z.nativeEnum(AccommodationType),
            hostelId: z.string().uuid().optional(),
            transportRouteId: z.string().uuid().optional(),
            hostelType: z.nativeEnum(HostelType).optional(),
            hostelPaymentMode: z.nativeEnum(HostelPaymentMode).optional(),
        }).refine((data) => {
            if (data.type === AccommodationType.HOSTEL) return !!data.hostelId;
            if (data.type === AccommodationType.TRANSPORT) return !!data.transportRouteId;
            return true;
        }, {
            message: "Hostel ID or Transport Route ID is required based on allocation type",
        }).optional(),
        course: z.object({
            allottedCourseId: z.string().uuid(),
        }),
    }),
});

export const verifyPaymentSchema = z.object({
    body: z.object({
        paymentId: z.string().uuid("Invalid Payment ID"),
    }),
});

export const assignRoleGroupSchema = z.object({
    body: z.object({
        userId: z.string().uuid("Invalid User ID"),
        role: z.string().optional(),
        // Refine for stricter strings if needed, but assuming any valid string for now
        groupIds: z.array(z.string().uuid("Invalid Group ID")).optional(),
    }).refine((data: any) => data.role !== undefined || data.groupIds !== undefined, {
        message: "Either role or groupIds must be provided",
    }),
});

export const updateFullStaffDetailsSchema = z.object({
    params: z.object({
        userId: z.string().uuid('Invalid user ID'),
    }),
    body: z.object({
        name: z.string().trim().min(1, 'Name cannot be empty').optional(),
        email: z.string().email('Invalid email address').optional(),
        phone: z.string().min(10, 'Phone number must be at least 10 digits').optional(),
        role: z.string().optional(),
        groupIds: z.array(z.string().uuid("Invalid Group ID")).optional(),
        isDeleted: z.boolean().optional(),
    }).refine(
        (data) => data.name !== undefined || data.email !== undefined || data.phone !== undefined || data.role !== undefined || data.groupIds !== undefined || data.isDeleted !== undefined,
        {
            message: 'At least one field must be provided',
        }
    ),
});

export const assignProSchema = z.object({
    body: z.object({
        studentId: z.string().uuid('Invalid student ID'),
        proNumber: z.string().min(1, 'PRO number is required'),
    }),
});

export const updateSeatAllotedBySchema = z.object({
    body: z.object({
        studentId: z.string().uuid('Invalid student ID'),
        seatAllotedBy: z.string().uuid('Invalid seatAllotedBy UUID').nullable().optional(),
    }),
});
