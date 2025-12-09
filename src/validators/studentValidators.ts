import { z } from 'zod';

export const registerStudentSchema = z.object({
    body: z.object({
        name: z.string().min(1, "Name is required"),
        fatherName: z.string().min(1, "Father's name is required"),
        motherName: z.string().min(1, "Mother's name is required"),
        email: z.string().email("Invalid email"),
        phone: z.string().min(10, "Phone number must be at least 10 digits"),
        gender: z.string().min(1, "Gender is required"),
        dob: z.string().datetime().or(z.date()).or(z.string()), // Allow string date
        aadharNumber: z.string().min(12, "Aadhar number must be 12 digits"),
        category: z.string().min(1, "Category is required"),
        country: z.string().min(1, "Country is required"),
        address: z.string().min(1, "Address is required"),
        address2: z.string().optional(),
        city: z.string().min(1, "City is required"),
        state: z.string().min(1, "State is required"),
        pincode: z.string().min(6, "Pincode must be 6 digits"),
        courseType: z.string().min(1, "Course Type is required"), // e.g., B.Tech, MBA
        pref1: z.string().min(1, "Preference 1 is required"),
        pref2: z.string().optional(),
        pref3: z.string().optional(),
        profilePhotoUrl: z.string().url("Profile Photo URL is required"),
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
            board: z.string().min(1, "Board is required"),
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
