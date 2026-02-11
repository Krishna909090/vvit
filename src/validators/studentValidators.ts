import { z } from 'zod';

export const registerStudentSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Name is required. Please enter your full name."),
        fatherName: z.string().min(1, "Father's name is required"),
        motherName: z.string().min(1, "Mother's name is required"),
        email: z.string().email("Please enter a valid email address (e.g., user@example.com)"),
        phone: z.string().regex(/^\d{10}$/, "Phone number must be exactly 10 digits"),
        gender: z.string().transform((val) => val.toUpperCase()).pipe(z.enum(["MALE", "FEMALE", "OTHER"])),
        dob: z.coerce.date(), 
        aadharNumber: z.string().regex(/^\d{12}$/, "Aadhaar number must be exactly 12 digits"),
        category: z.string().min(1, "Category is required"),
        country: z.string().min(1, "Country is required"),
        address: z.string().min(1, "Address is required"),
        address2: z.string().optional(),
        city: z.string().min(1, "City is required"),
        state: z.string().min(1, "State is required"),
        pincode: z.string().regex(/^\d{6}$/, "Pincode must be exactly 6 digits"),
        degreeType: z.string().min(1, "Degree Type is required"), // e.g., B.Tech, MBA
        pref1: z.string().optional(),
        pref2: z.string().optional(),
        pref3: z.string().optional(),
        profilePhotoUrl: z.string().url("Profile Photo must be a valid URL"),
        isOffline: z.boolean().optional(),
    }),
});

export const studentIdParamSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
});

export const uploadDocumentsAndPreferencesSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        pref1: z.string().optional(),
        pref2: z.string().optional(),
        pref3: z.string().optional(),
    }).passthrough(),
});

export const requestDiscountSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        reason: z.string().min(1, "Reason is required"),
        documentUrl: z.string().url().optional(),
    }),
});

export const addAcademicDetailsSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        details: z.array(z.object({
            level: z.string().min(1, "Level is required"), // e.g., "10th", "12th"
            board: z.string().optional(),
            yearOfPassing: z.number().int().min(1900).max(new Date().getFullYear()),
            hallTicketNumber: z.string().min(1, "Hall ticket number is required"),
            gpaOrMarks: z.string().or(z.number()),
        })).min(1, "At least one academic detail is required"),
    }),
});

export const selectExamSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        slotId: z.string().uuid("Invalid Slot ID"),
    }),
});

export const updatePersonalDetailsSchema = z.object({
    params: z.object({
        studentId: z.string().uuid("Invalid Student ID"),
    }),
    body: z.object({
        name: z.string().min(1).optional(),
        fatherName: z.string().min(1).optional(),
        motherName: z.string().min(1).optional(),
        gender: z.string().transform((val) => val.toUpperCase()).pipe(z.enum(["MALE", "FEMALE", "OTHER"])).optional(),
        dob: z.coerce.date().optional(),
        email: z.string().email().optional(),
        category: z.string().min(1).optional(),
        address: z.string().min(1).optional(),
        city: z.string().min(1).optional(),
        state: z.string().min(1).optional(),
        pincode: z.string().min(1).optional(),
        country: z.string().min(1).optional(),
        profilePhotoUrl: z.string().url().optional(),
    }).refine(data => {
        const forbiddenKeys = ['phone', 'phoneNumber', 'aadharNumber', 'aadhar'];
        const keys = Object.keys(data);
        return !keys.some(k => forbiddenKeys.includes(k));
    }, {
        message: "Updates to phone number or Aadhar number are not allowed.",
    }),
});
