import { z } from 'zod';
import { PaymentMethod, PaymentComponent, PaymentMode } from '@prisma/client';

export const payFeeComponentSchema = z.object({
    body: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
        amount: z.number().positive("Amount must be positive"),
        mode: z.nativeEnum(PaymentMode),
        method: z.union([
            z.nativeEnum(PaymentMethod),
            z.literal('IMPS'),
            z.literal('NEFT'),
            z.literal('RTGS'),
            z.literal('BANK_TRANSFER')
        ]).optional(),
        component: z.union([z.nativeEnum(PaymentComponent), z.string()]),
        feeHeadId: z.string().uuid().optional(),
        remarks: z.string().optional(),
        referenceNumber: z.string().optional(), 
        redirectUrl: z.string().optional(),
        customRedirectPath: z.string().optional(),
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
