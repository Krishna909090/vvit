import { z } from 'zod';
import { AccommodationType, HostelType, PaymentMethod, HostelPaymentMode, AdmissionEntryType, PaymentComponent, QuotaType, SubjectExamType, SemesterMarkStatus, AttendanceStatus } from '@prisma/client';
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

export const branchChangeSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        newCourseId: z.string().uuid("Invalid Course ID"),
        reason: z.string().min(1, "Reason is required"),
        recommendedByManagement: z.boolean().optional().default(false),
        branchChangeFee: z.number().min(0).optional().default(0),
    }),
});

export const approveCourseChangeSchema = z.object({
    body: z.object({
        requestId: z.string().uuid(),
        approved: z.boolean(),
        recommendedByManagement: z.boolean().optional(),
        branchChangeFee: z.number().min(0).optional(),
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

// HH:MM in 24-hour format, e.g. "07:30", "17:00". Allows HH:MM:SS too ("07:30:00").
const timeRegex = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export const createTransportRouteSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Route name is required"),
        city: z.string().min(1, "City is required"),
        cost: z.number().min(0),
        busNumber: z.string().min(1, "Bus number is required"),
        capacity: z.number().int().min(1, "Capacity must be at least 1"),
        vehicleId: z.string().uuid().optional().nullable(),
        pickupTime: z.string().regex(timeRegex, "pickupTime must be HH:MM (24-hour)").optional().nullable(),
        dropTime: z.string().regex(timeRegex, "dropTime must be HH:MM (24-hour)").optional().nullable(),
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
        dateRange: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        seatAllotedBy: z.string().optional(),
        proCode: z.string().optional(),
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
    proNumber: z.string().trim().optional(),
  }).refine(
    (data) => data.role !== 'PRO' || (data.proNumber !== undefined && data.proNumber.length > 0),
    { message: 'PRO Number is required when role is PRO', path: ['proNumber'] }
  ),
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
        omrId: z.number().int().optional(),
    }),
});

export const createBatchSchema = z.object({
    body: z.object({
        name: z.string().min(1),
        courseId: z.string().uuid('Invalid Course ID'),
        academicYearId: z.string().uuid('Invalid Academic Year ID'),
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
        photoUrl: z.string().url("photoUrl must be a valid URL").optional().nullable(),
    }),
});

export const createTransportStopSchema = z.object({
    body: z.object({
        routeId: z.string().uuid(),
        name: z.string().min(1),
        sequence: z.number().int().min(1),
    }),
});

// Finance
export const createAcademicYearSchema = z.object({
    body: z.object({
        code: z.string().min(1, "Code is required"),
        startDate: z.string().datetime().or(z.date()),
        endDate: z.string().datetime().or(z.date()),
        isActive: z.boolean().optional(),
    }).refine(
        (d) => new Date(d.endDate) > new Date(d.startDate),
        { message: "endDate must be after startDate", path: ["endDate"] }
    ),
});

const PAYMENT_COMPONENT_ENUM = [
    'APPLICATION_FEE', 'TUITION', 'HOSTEL', 'TRANSPORT', 'OTHER',
    'SCHOLARSHIP_TOKEN', 'BOOK_BANK', 'ADMISSION', 'SKILL_DEVELOPMENT',
    'HOSTEL_ACCOMMODATION', 'HOSTEL_MESS', 'HOSTEL_LAUNDRY', 'HOSTEL_REGISTRATION',
    'COURSE_CHANGE_FEE'
] as const;

export const createFeeHeadSchema = z.object({
    body: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        component: z.string().transform(v => v.toUpperCase()).pipe(z.enum(PAYMENT_COMPONENT_ENUM)).optional(),
    }),
});

export const updateFeeHeadSchema = z.object({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        component: z.string().transform(v => v.toUpperCase()).pipe(z.enum(PAYMENT_COMPONENT_ENUM)).optional(),
    }),
});

export const createFeeStructureSchema = z.object({
    body: z.object({
        courseId: z.string().uuid(),
        feeHeadId: z.string().uuid(),
        amount: z.number().positive(),
        academicYearId: z.string().uuid(),
        entryAcademicYearId: z.string().uuid().optional(),
        entryType: z.enum(['REGULAR', 'LATERAL', 'TRANSFER']).optional(),
        instituteCode: z.enum(['VVIG', 'VVITU', 'VVITPU']).optional(),
        quotaType: z.string().optional(),
        yearOfStudy: z.number().int().min(1).max(10).optional(),
    }),
});

export const createBulkFeeStructureSchema = z.object({
    body: z.object({
        degreeType: z.string().min(1),
        feeHeadId: z.string().uuid(),
        amount: z.number().positive(),
        academicYearId: z.string().uuid(),
        quotaType: z.string().optional(),
        yearOfStudy: z.number().int().min(1).max(10).optional(),
    }),
});

// Create fee-structure rows for many fee heads in one go, all sharing the same
// (course, year, entryType, quota, etc.) combination. Each entry sets its own amount.
export const bulkHeadsFeeStructureSchema = z.object({
    body: z.object({
        courseId:            z.string().uuid('Invalid Course ID'),
        academicYearId:      z.string().uuid('Invalid Academic Year ID'),
        entryAcademicYearId: z.string().uuid('Invalid Entry Academic Year ID').optional(),
        entryType:           z.enum(['REGULAR', 'LATERAL', 'TRANSFER']).optional(),
        instituteCode:       z.enum(['VVIG', 'VVITU', 'VVITPU']).optional(),
        quotaType:           z.enum(['MANAGEMENT', 'CONVENOR']).optional(),
        yearOfStudy:         z.number().int().min(1).max(10).optional(),
        feeHeads: z.array(z.object({
            feeHeadId: z.string().uuid('Invalid Fee Head ID'),
            amount:    z.number().positive('amount must be > 0')
                                  .finite('amount must be finite')
                                  .max(100_000_000, 'amount exceeds reasonable limit (₹10 crore)'),
        }))
        .min(1,   'feeHeads must contain at least one entry')
        .max(50,  'feeHeads cannot exceed 50 entries per call'),
    })
    // LATERAL business rule: entries at year 2 or later only.
    .refine(
        b => !(b.entryType === 'LATERAL' && (b.yearOfStudy ?? 2) < 2),
        { message: 'LATERAL entry requires yearOfStudy >= 2', path: ['yearOfStudy'] },
    )
    // No duplicate feeHeadIds within the array.
    .refine(
        b => new Set(b.feeHeads.map(h => h.feeHeadId)).size === b.feeHeads.length,
        { message: 'Duplicate feeHeadId(s) in array — each fee head can appear only once', path: ['feeHeads'] },
    )
    // entryAcademicYearId, if provided, should equal academicYearId per our cohort rule.
    // (Soft check — log via service if they disagree.)
    .refine(
        b => !b.entryAcademicYearId || b.entryAcademicYearId === b.academicYearId,
        { message: 'entryAcademicYearId should equal academicYearId (fee cohort = entry year)', path: ['entryAcademicYearId'] },
    ),
});

/**
 * Clone fee structures from one academic year to another. Used for:
 *  - Setting up a new academic year (clone prior year, then edit individual rows)
 *  - Back-filling past years for lateral / back-dated admissions
 *
 * `multiplier` applies a flat percentage adjustment (1.05 = +5%, 0.95 = -5%).
 * `courseIds` restricts the clone to specific courses (omit to clone all).
 */
/**
 * Assigns rollNumber + section to a previously-registered student. Used after
 * counseling / seat allotment for both fresh and lateral students. Creates the
 * StudentEnrollment row for the active academic year.
 */
export const assignEnrollmentSchema = z.object({
    params: z.object({
        studentId: z.string().uuid('Invalid student ID'),
    }),
    body: z.object({
        rollNumber: z.string().trim().min(1, 'Roll number is required'),
        sectionId: z.string().uuid('Invalid section ID'),
        currentSemester: z.number().int().min(1).max(20).optional(),
        yearOfStudy: z.number().int().min(1).max(10).optional(),
        seedFeeDemands: z.boolean().optional().default(true),
    }),
});

export const cloneFeeStructuresSchema = z.object({
    body: z.object({
        sourceAcademicYearId: z.string().uuid('Invalid source academic year ID'),
        targetAcademicYearId: z.string().uuid('Invalid target academic year ID'),
        multiplier: z.number().positive().max(10).optional().default(1.0),
        courseIds: z.array(z.string().uuid('Invalid course ID')).optional(),
        entryAcademicYearId: z.string().uuid('Invalid entry academic year ID').optional(),
        entryType: z.enum(['REGULAR', 'LATERAL', 'TRANSFER']).optional(),
        instituteCode: z.enum(['VVIG', 'VVITU', 'VVITPU']).optional(),
    }).refine(
        d => d.sourceAcademicYearId !== d.targetAcademicYearId,
        { message: 'Source and target academic years must differ', path: ['targetAcademicYearId'] }
    ),
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
        // Optional — when not provided, service defaults preserve legacy behavior
        // (allowLegacyFallback=true, requireEnrollment=false, deleteExisting=false).
        deleteExisting:       z.boolean().optional(),
        allowLegacyFallback:  z.boolean().optional(),
        requireEnrollment:    z.boolean().optional(),
        dueDateFallbackDays:  z.number().int().min(0).max(365).optional(),
    }),
});

export const generateFeeDemandsBulkSchema = z.object({
    body: z.object({
        academicYearId: z.string().uuid(),
        filters: z.object({
            courseIds:            z.array(z.string().uuid()).optional(),
            entryTypes:           z.array(z.nativeEnum(AdmissionEntryType)).optional(),
            instituteCodes:       z.array(z.string()).optional(),
            entryAcademicYearIds: z.array(z.string().uuid()).optional(),
            quotaTypes:           z.array(z.nativeEnum(QuotaType)).optional(),
            studentIds:           z.array(z.string().uuid()).optional(),
        }).optional(),
        runOptions: z.object({
            allowLegacyFallback:  z.boolean().optional(), // default false (strict for bulk)
            requireEnrollment:    z.boolean().optional(), // default true  (bulk verifies)
            deleteExisting:       z.boolean().optional(), // default false
            dueDateFallbackDays:  z.number().int().min(0).max(365).optional(),
        }).optional(),
    }),
});

export const setEligibleScholarshipSchema = z.object({
    body: z.object({
        studentId: z.string().uuid(),
        ruleId: z.string().uuid(),
    }),
});

// ════════════════════════════════════════════════════════════════════════════
// Semester marks (Subject + SemesterMark)
// ════════════════════════════════════════════════════════════════════════════

export const createSubjectSchema = z.object({
    body: z.object({
        code:             z.string().min(1).max(32),
        name:             z.string().min(1),
        courseId:         z.string().uuid(),
        semester:         z.number().int().min(1).max(12),
        credits:          z.number().min(0).max(20).optional(),
        examType:         z.nativeEnum(SubjectExamType).optional(),
        maxInternalMarks: z.number().min(0).max(1000).nullable().optional(),
        maxExternalMarks: z.number().min(0).max(1000).nullable().optional(),
        maxTotalMarks:    z.number().min(0).max(1000).nullable().optional(),
        isElective:       z.boolean().optional(),
    }),
});

export const updateSubjectSchema = z.object({
    body: z.object({
        code:             z.string().min(1).max(32).optional(),
        name:             z.string().min(1).optional(),
        credits:          z.number().min(0).max(20).optional(),
        examType:         z.nativeEnum(SubjectExamType).optional(),
        maxInternalMarks: z.number().min(0).max(1000).nullable().optional(),
        maxExternalMarks: z.number().min(0).max(1000).nullable().optional(),
        maxTotalMarks:    z.number().min(0).max(1000).nullable().optional(),
        isElective:       z.boolean().optional(),
    }).refine(
        (d) => Object.keys(d).length > 0,
        { message: 'At least one field must be provided' }
    ),
});

const semesterMarkRowSchema = z.object({
    subjectId:       z.string().uuid(),
    internalMarks:   z.number().min(0).nullable().optional(),
    externalMarks:   z.number().min(0).nullable().optional(),
    totalMarks:      z.number().min(0).nullable().optional(),
    grade:           z.string().max(8).nullable().optional(),
    gradePoints:     z.number().min(0).max(10).nullable().optional(),
    status:          z.nativeEnum(SemesterMarkStatus).optional(),
    attemptNumber:   z.number().int().min(1).max(20).optional(),
    isSupplementary: z.boolean().optional(),
    remarks:         z.string().max(500).optional(),
    isBackfilled:    z.boolean().optional(),
});

export const recordMarkSchema = z.object({
    body: semesterMarkRowSchema.extend({
        studentId:      z.string().uuid(),
        academicYearId: z.string().uuid(),
    }),
});

export const recordMarksBulkSchema = z.object({
    body: z.object({
        studentId:      z.string().uuid(),
        academicYearId: z.string().uuid(),
        marks:          z.array(semesterMarkRowSchema).min(1).max(100),
    }),
});

export const updateMarkSchema = z.object({
    body: z.object({
        internalMarks:   z.number().min(0).nullable().optional(),
        externalMarks:   z.number().min(0).nullable().optional(),
        totalMarks:      z.number().min(0).nullable().optional(),
        grade:           z.string().max(8).nullable().optional(),
        gradePoints:     z.number().min(0).max(10).nullable().optional(),
        status:          z.nativeEnum(SemesterMarkStatus).optional(),
        remarks:         z.string().max(500).optional(),
        isBackfilled:    z.boolean().optional(),
    }).refine(
        (d) => Object.keys(d).length > 0,
        { message: 'At least one field must be provided' }
    ),
});

// ════════════════════════════════════════════════════════════════════════════
// Class attendance
// ════════════════════════════════════════════════════════════════════════════

const dateInputSchema = z.union([z.string().datetime(), z.string().regex(/^\d{4}-\d{2}-\d{2}/), z.date()]);

export const markAttendanceSchemaV2 = z.object({
    body: z.object({
        studentId:      z.string().uuid(),
        subjectId:      z.string().uuid(),
        academicYearId: z.string().uuid(),
        date:           dateInputSchema,
        periodNumber:   z.number().int().min(1).max(20).nullable().optional(),
        status:         z.nativeEnum(AttendanceStatus),
        remarks:        z.string().max(500).optional(),
        isBackfilled:   z.boolean().optional(),
    }),
});

export const markClassAttendanceSchema = z.object({
    body: z.object({
        subjectId:      z.string().uuid(),
        academicYearId: z.string().uuid(),
        date:           dateInputSchema,
        periodNumber:   z.number().int().min(1).max(20).nullable().optional(),
        isBackfilled:   z.boolean().optional(),
        rows: z.array(z.object({
            studentId: z.string().uuid(),
            status:    z.nativeEnum(AttendanceStatus),
            remarks:   z.string().max(500).optional(),
        })).min(1).max(500),
    }),
});

export const markAttendanceBackfillSchema = z.object({
    body: z.object({
        studentId:      z.string().uuid(),
        academicYearId: z.string().uuid(),
        rows: z.array(z.object({
            subjectId:    z.string().uuid(),
            date:         dateInputSchema,
            periodNumber: z.number().int().min(1).max(20).nullable().optional(),
            status:       z.nativeEnum(AttendanceStatus),
            remarks:      z.string().max(500).optional(),
        })).min(1).max(500),
    }),
});

export const updateAttendanceSchema = z.object({
    body: z.object({
        status:       z.nativeEnum(AttendanceStatus).optional(),
        remarks:      z.string().max(500).optional(),
        isBackfilled: z.boolean().optional(),
    }).refine(
        (d) => Object.keys(d).length > 0,
        { message: 'At least one field must be provided' }
    ),
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
        degreeType: z.string().min(1).optional(),
        pref1: z.string().uuid("Invalid Course ID").nullable().optional(),
        pref2: z.string().uuid("Invalid Course ID").nullable().optional(),
        pref3: z.string().uuid("Invalid Course ID").nullable().optional(),
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
            hostelId: z.string().uuid().optional(),                         // optional — inferred from student's admission if not sent
            transportRouteId: z.string().uuid().optional(),
            hostelType: z.nativeEnum(HostelType).optional(),
            hostelPaymentMode: z.nativeEnum(HostelPaymentMode).optional(),
        }).refine((data) => {
            if (data.type === AccommodationType.HOSTEL) {
                // hostelId is no longer required in body — picked up from student's admission
                return !!data.hostelType && !!data.hostelPaymentMode;
            }
            if (data.type === AccommodationType.TRANSPORT) return !!data.transportRouteId;
            return true;
        }, {
            message: "For HOSTEL: hostelType (SHARING_*) and hostelPaymentMode are required. For TRANSPORT: transportRouteId is required.",
        }).optional(),
        course: z.object({
            allottedCourseId: z.string().uuid(),
        }),
        // Optional: the academic year of the BATCH the student joins (the seat pool
        // to claim from). For a lateral via finalize, send the batch's year (e.g. the
        // previous year). Omit for regular first-year students → defaults to current year.
        batchAcademicYearId: z.string().uuid().optional(),
    }),
});

/**
 * Manual entry admission — lateral entry, transfer, or back-dated admission.
 *
 * The endpoint is used when a student needs to be added directly into the system
 * outside the normal application → entrance → seat-allotment → finalize flow.
 *
 * Three valid scenarios:
 *   1. Lateral year-2/3/4 (e.g., diploma → BTech)
 *   2. Transfer from another institution at any year
 *   3. Back-dated admission (entering a past academic year's cohort now)
 *
 * Defaults: entry.type=REGULAR, entry.yearOfStudy=1, entry.isBackdated=false.
 * Currying these defaults makes this validator usable for fresh manual admissions too.
 */
export const manualEntryAdmissionSchema = z.object({
    body: z.object({
        // ── Student profile ────────────────────────────────────────────
        student: z.object({
            name:          z.string().trim().min(1),
            fatherName:    z.string().trim().min(1),
            motherName:    z.string().trim().min(1),
            gender:        z.string().trim().min(1),
            dob:           z.string().datetime().or(z.date()),
            phone:         z.string().trim().min(10).max(15),
            email:         z.string().email().optional(),
            aadharNumber:  z.string().trim().min(1),
            category:      z.string().trim().min(1),
            country:       z.string().trim().min(1),
            address:       z.string().trim().min(1),
            address2:      z.string().trim().optional(),
            city:          z.string().trim().min(1),
            state:         z.string().trim().min(1),
            pincode:       z.string().trim().min(1),
            profilePhotoUrl: z.string().url().optional(),
            quotaType:     z.nativeEnum(QuotaType),
        }),

        // ── Course allocation ──────────────────────────────────────────
        course: z.object({
            allottedCourseId: z.string().uuid('Invalid Course ID'),
        }),

        // ── Entry context ──────────────────────────────────────────────
        entry: z.object({
            type:           z.nativeEnum(AdmissionEntryType).default(AdmissionEntryType.REGULAR),
            yearOfStudy:    z.number().int().min(1).max(10).default(1),
            academicYearId: z.string().uuid('Invalid Academic Year ID'),
            currentSemester: z.number().int().min(1).max(20).optional(), // defaults to (yearOfStudy*2 - 1)
            reason:         z.string().trim().max(500).optional(),
            isBackdated:    z.boolean().default(false),
            instituteCode:  z.enum(['VVITU', 'VVITPU']).optional(),  // defaults to VVITU server-side
        }).refine(
            e => e.type !== AdmissionEntryType.LATERAL || e.yearOfStudy >= 2,
            { message: 'LATERAL entry requires yearOfStudy >= 2', path: ['yearOfStudy'] }
        ),

        // ── Enrollment (section + roll number) ─────────────────────────
        enrollment: z.object({
            sectionId:  z.string().uuid('Invalid Section ID'),
            rollNumber: z.string().trim().min(1),
        }),

        // ── Scholarship — strict tier list for lateral, free for fresh ─
        scholarship: z.object({
            ruleId:     z.string().uuid().optional(),
            // Lateral entries are restricted to 0/15/25/50; REGULAR entries can use any value.
            // The service layer enforces the lateral-only restriction.
            percentage: z.number().min(0).max(100),
        }).optional(),

        // ── Optional same-day accommodation ────────────────────────────
        accommodation: z.object({
            type:              z.nativeEnum(AccommodationType).default(AccommodationType.NONE),
            hostelId:          z.string().uuid().optional(),
            hostelType:        z.nativeEnum(HostelType).optional(),
            hostelPaymentMode: z.nativeEnum(HostelPaymentMode).optional(),
            transportRouteId:  z.string().uuid().optional(),
        }).refine(a => {
            if (a.type === AccommodationType.HOSTEL)    return !!a.hostelType && !!a.hostelPaymentMode && !!a.hostelId;
            if (a.type === AccommodationType.TRANSPORT) return !!a.transportRouteId;
            return true;
        }, { message: 'HOSTEL needs hostelId+hostelType+hostelPaymentMode; TRANSPORT needs transportRouteId' }).optional(),

        // ── Optional carried-over payment from prior institution ───────
        priorPayment: z.object({
            amount:          z.number().positive(),
            method:          z.nativeEnum(PaymentMethod),
            component:       z.nativeEnum(PaymentComponent),
            referenceNumber: z.string().trim().optional(),
            date:            z.string().datetime().or(z.date()).optional(),
            feeHeadId:       z.string().uuid().optional(),
        }).optional(),
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

export const editProSchema = z.object({
    body: z.object({
        studentId: z.string().uuid('Invalid student ID'),
        proNumber: z.string().optional(),
    }),
});

export const updateSeatAllotedBySchema = z.object({
    body: z.object({
        studentId: z.string().uuid('Invalid student ID'),
        seatAllotedBy: z.string().uuid('Invalid seatAllotedBy UUID').nullable().optional(),
    }),
});

// CourseCapacity (per-year sanctioned + filled seats)
export const createCourseCapacitySchema = z.object({
    body: z.object({
        courseId:       z.string().uuid(),
        academicYearId: z.string().uuid(),
        totalSeats:     z.number().int().min(0),
        filledSeats:    z.number().int().min(0).optional(),
    }),
});

export const upsertCourseCapacitySchema = z.object({
    body: z.object({
        courseId:       z.string().uuid(),
        academicYearId: z.string().uuid(),
        totalSeats:     z.number().int().min(0),
    }),
});

export const bulkUpsertCourseCapacitySchema = z.object({
    body: z.object({
        academicYearId: z.string().uuid(),
        rows: z.array(z.object({
            courseId:   z.string().uuid(),
            totalSeats: z.number().int().min(0),
        })).min(1, 'rows must contain at least one entry'),
    }),
});

export const updateCourseCapacitySchema = z.object({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({
        totalSeats:  z.number().int().min(0).optional(),
        filledSeats: z.number().int().min(0).optional(),
    }).refine(b => b.totalSeats !== undefined || b.filledSeats !== undefined, {
        message: 'At least one of totalSeats or filledSeats is required',
    }),
});

