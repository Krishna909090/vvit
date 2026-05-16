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

// Student auth: rollNumber + password
export const studentLoginSchema = z.object({
    body: z.object({
        rollNumber: z.string().trim().min(1, "Roll number is required"),
        password: z.string().min(1, "Password is required"),
    }),
});

// Student first-time setup: PII verification (rollNumber + DOB + Aadhaar last 4)
export const studentInitialSetupSchema = z.object({
    body: z.object({
        rollNumber: z.string().trim().min(1, "Roll number is required"),
        dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "DOB must be YYYY-MM-DD"),
        aadhaarLast4: z.string().regex(/^\d{4}$/, "Aadhaar last 4 must be 4 digits"),
        newPassword: z.string().min(8, "Password must be at least 8 characters"),
    }),
});

// Admin issuing forgot-password OTP for a student
export const adminIssueStudentOtpSchema = z.object({
    body: z.object({
        rollNumber: z.string().trim().min(1, "Roll number is required"),
    }),
});

// Student consuming an admin-issued OTP to set a new password
export const studentResetPasswordSchema = z.object({
    body: z.object({
        rollNumber: z.string().trim().min(1, "Roll number is required"),
        otp: z.string().regex(/^\d{8}$/, "OTP must be 8 digits"),
        newPassword: z.string().min(8, "Password must be at least 8 characters"),
    }),
});
