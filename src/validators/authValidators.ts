import { z } from 'zod';

export const sendOtpSchema = z.object({
    body: z.object({
        phone: z.string().min(10, "Phone number must be at least 10 digits").optional(),
        email: z.string().email("Invalid email address").optional(),
        role: z.enum(['STUDENT', 'ADMIN', 'SUPER_ADMIN', 'AGENT', 'INVIGILATOR']).optional(),
    }).refine(data => data.phone || data.email, {
        message: "Either phone or email is required",
        path: ["phone"] // Error will be attached to phone field
    }),
});

export const verifyOtpSchema = z.object({
    body: z.object({
        phone: z.string().min(10, "Phone number must be at least 10 digits").optional(),
        email: z.string().email("Invalid email address").optional(),
        otp: z.string().length(6, "OTP must be 6 digits"),
    }).refine(data => data.phone || data.email, {
        message: "Either phone or email is required",
        path: ["phone"]
    }),
});

export const generateAadhaarOtpSchema = z.object({
    body: z.object({
        id_number: z.string().min(12, "Aadhaar number must be at least 12 digits").max(12, "Aadhaar number must be at most 12 digits"),
    }),
});

export const submitAadhaarOtpSchema = z.object({
    body: z.object({
        request_id: z.string().or(z.number()),
        otp: z.string().min(1, "OTP is required"),
    }),
});
