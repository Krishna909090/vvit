import { z } from 'zod';

const conditionTypeEnum = z.enum([
    'OTHER_COLLEGE_CANCEL',
    'INTERNAL_BRANCH_TRANSFER',
    'QUOTA_MGMT_TO_CONVENOR',
    'QUOTA_CONVENOR_TO_MGMT',
    'NORMAL_SEAT_CANCEL',
    'MANAGEMENT_CANCEL_FULL_REFUND',
]);

const componentPaidSchema = z.object({
    tuition:   z.number().min(0).default(0),
    hostel:    z.number().min(0).default(0),
    transport: z.number().min(0).default(0),
    others:    z.number().min(0).default(0),
});

export const previewAdjustmentSchema = z.object({
    body: z.object({
        conditionType:  conditionTypeEnum,
        totalPaid:      z.number().min(0, 'totalPaid must be non-negative'),
        componentPaid:  componentPaidSchema,
        oldQuotaFee:    z.number().min(0).optional(),
        newQuotaFee:    z.number().min(0).optional(),
    }),
});

export const requestCancellationSchema = z.object({
    body: z.object({
        studentId:               z.string().uuid('studentId must be a valid UUID'),
        reason:                  z.string().min(1, 'Reason is required'),
        conditionType:           conditionTypeEnum,
        oldQuotaFee:             z.number().min(0).optional(),
        newQuotaFee:             z.number().min(0).optional(),
        remarks:                 z.string().optional(),
        fileUrl:                 z.string().optional(),
        recommendedByManagement: z.boolean().optional().default(false),
        cancellationFee:         z.number().min(0).optional(),
    }),
});

export const approveCancellationSchema = z.object({
    body: z.object({
        requestId:       z.string().uuid('requestId must be a valid UUID'),
        approved:        z.boolean(),
        remarks:         z.string().optional(),
        cancellationFee: z.number().min(0).optional(),
    }),
});

export const getCancellationByIdSchema = z.object({
    params: z.object({
        id: z.string().uuid('id must be a valid UUID'),
    }),
});
