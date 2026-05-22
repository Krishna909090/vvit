import { z } from 'zod';
import { PaymentMethod, PaymentComponent, PaymentMode } from '@prisma/client';

export const payFeeComponentSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        amount: z.number().positive("Amount must be positive"),
        mode: z.nativeEnum(PaymentMode),
        method: z.nativeEnum(PaymentMethod).optional(),
        component: z.union([z.nativeEnum(PaymentComponent), z.string()]),
        feeHeadId: z.string().uuid().optional(),
        remarks: z.string().optional(),
        referenceNumber: z.string().optional(),
        redirectUrl: z.string().optional(),
    }).refine((data) => {
        if (data.mode === PaymentMode.OFFLINE) {
            return !!data.method && !!data.referenceNumber;
        }
        return true;
    }, {
        message: "Method and Reference Number are required for Offline payments",
        path: ["method"], // Attach error to method but implies both
    }).refine((data) => {
        if (data.component === PaymentComponent.OTHER && !data.feeHeadId) {
             return false;
        }
        return true;
    }, {
        message: "Fee Head ID is required for 'OTHER' component payments",
        path: ["feeHeadId"]
    })
});

// ─────────────────────────────────────────────────────────────────────────────
// Money-route validation for endpoints that previously had NO validateRequest.
// Deliberately LENIENT to avoid breaking working clients:
//   - amounts use z.coerce.number() so stringified amounts ("5000") still pass
//   - every body object is .passthrough() so no field the service needs is stripped
// They only reject genuinely-missing/empty required fields (mirroring each
// controller's own existing required-field checks).
// ─────────────────────────────────────────────────────────────────────────────

export const offlineApplicationFeeSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        paymentMethod: z.union([z.nativeEnum(PaymentMethod), z.string()]),
        transactionId: z.string().optional(),
        remarks: z.string().optional(),
        referenceNumber: z.string().optional(),
    }).passthrough(),
});

export const adminInitiatePaymentSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        amount: z.coerce.number().positive("Amount must be positive"),
        component: z.union([z.nativeEnum(PaymentComponent), z.string()]),
        feeHeadId: z.string().uuid().optional(),
        remarks: z.string().optional(),
    }).passthrough(),
});

export const multiComponentPaymentSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        components: z.array(
            z.object({
                component: z.union([z.nativeEnum(PaymentComponent), z.string()]),
                amount: z.coerce.number().positive("Component amount must be positive"),
                feeHeadId: z.string().uuid().optional(),
            }).passthrough()
        ).min(1, "At least one component is required"),
        paymentMethod: z.union([z.nativeEnum(PaymentMethod), z.string()]).optional(),
        mode: z.union([z.nativeEnum(PaymentMode), z.string()]).optional(),
        remarks: z.string().optional(),
        referenceNumber: z.string().optional(),
    }).passthrough(),
});

export const approveDiscountSchema = z.object({
    params: z.object({ requestId: z.string().uuid("Invalid Request ID") }),
    body: z.object({
        approvedAmount: z.coerce.number().positive("Approved amount must be positive"),
        component: z.union([z.nativeEnum(PaymentComponent), z.string()]),
        remarks: z.string().optional(),
    }).passthrough(),
});

export const rejectDiscountSchema = z.object({
    params: z.object({ requestId: z.string().uuid("Invalid Request ID") }),
    body: z.object({ remarks: z.string().optional() }).passthrough(),
});

export const setApplicationFeeSchema = z.object({
    body: z.object({ amount: z.coerce.number().min(0, "Amount must be >= 0") }).passthrough(),
});

export const collectFeeSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        amount: z.coerce.number().positive("Amount must be positive"),
        method: z.union([z.nativeEnum(PaymentMethod), z.string()]),
        component: z.union([z.nativeEnum(PaymentComponent), z.string()]),
        referenceNumber: z.string().optional(),
        bankName: z.string().optional(),
        branchName: z.string().optional(),
        instrumentDate: z.string().optional(),
    }).passthrough(),
});

export const addStudentDiscountSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        feeHeadId: z.string().uuid().optional(),
        feeStructureId: z.string().uuid().optional(),
        type: z.enum(['DISCOUNT', 'FINE']),
        amount: z.coerce.number().positive("Amount must be positive"),
        reason: z.string().optional(),
    }).passthrough().refine(d => !!d.feeHeadId || !!d.feeStructureId, {
        message: "Either feeHeadId or feeStructureId is required",
        path: ["feeHeadId"],
    }),
});

export const changeAccommodationSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        newType: z.string().min(1, "newType is required"),
        hostelId: z.string().uuid().optional(),
        hostelType: z.string().optional(),
        transportRouteId: z.string().uuid().optional(),
        reason: z.string().optional(),
    }).passthrough(),
});

export const allocateScholarshipSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        ruleId: z.string().uuid("Invalid Rule ID"),
    }).passthrough(),
});

export const updateStudentScholarshipSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        scholarshipPercentage: z.coerce.number().min(0).max(100, "Percentage must be between 0 and 100"),
        feeHeadId: z.string().uuid().optional(),
    }).passthrough(),
});
