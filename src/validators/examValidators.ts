import { z } from 'zod';

export const createExamDateSchema = z.object({
    body: z.object({
        date: z.string().datetime().or(z.date()),
        name: z.string().optional(),
        startTime: z.string().datetime().or(z.date()).optional(),
        endTime: z.string().datetime().or(z.date()).optional(),
    }),
});

export const createExamCenterSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Center name is required"),
        address: z.string().optional(),
        city: z.string().optional(),
        capacity: z.number().int().positive().optional(),
    }),
});

export const generateInvigilatorCredentialSchema = z.object({
    body: z.object({
        validFrom: z.string().datetime().or(z.date()),
        validUntil: z.string().datetime().or(z.date()),
        count: z.number().int().positive().default(1),
    }),
});

export const invigilatorLoginSchema = z.object({
    body: z.object({
        token: z.string().min(1, "Token is required"),
    }),
});

export const scanAttendanceSchema = z.object({
    body: z.object({
        qrHash: z.string().min(1, "QR Hash is required"), // Scanned from QR code
        // studentId might be extracted from QR hash on server side or sent directly if QR contains it
    }),
});

export const createExamSlotSchema = z.object({
    body: z.object({
        examCenterId: z.string().uuid(),
        // Accept datetime strings (with or without timezone) or Date objects
        // Our parseDate function in examService will handle IST conversion
        date: z.string().min(1, "Date is required").or(z.date()),
        startTime: z.string().min(1, "Start time is required").or(z.date()),
        endTime: z.string().min(1, "End time is required").or(z.date()),
        capacity: z.number().int().positive(),
    }),
});

export const bookExamSlotSchema = z.object({
    body: z.object({
        slotId: z.string().uuid(),
    }),
});
