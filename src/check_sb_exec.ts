
import prisma from './config/prisma';
import { registerStudent } from './modules/student/student.service';
import { FeeService } from './modules/finance/fee.service';
import { PaymentMethod, PaymentComponent, AdmissionStatus, FeeStatus } from '@prisma/client';

// Mock Data Generator
const generateMockData = (mode: string, isOffline: boolean = false) => {
    const timestamp = Date.now();
    return {
        name: `Test Student ${timestamp}`,
        fatherName: "Test Father",
        motherName: "Test Mother",
        gender: "MALE",
        dob: "2000-01-01",
        email: `student_${mode}_${timestamp}@test.com`,
        phone: `${Math.floor(Math.random() * 9000000000) + 1000000000}`,
        aadharNumber: `${Math.floor(Math.random() * 900000000000) + 100000000000}`,
        category: "OC",
        country: "India",
        address: "Test Address",
        city: "Test City",
        state: "Test State",
        pincode: "500000",
        degreeType: "B.Tech",
        applicationMode: mode,
        isOffline,
        // Optional
        pref1: "CSE",
        isKycVerified: true
    };
};

async function run() {
    try {
        console.log("=== STARTING SEAT BOOKING FLOW VERIFICATION ===\n");
        
        // Fetch a valid course for FK constraints
        const course = await prisma.course.findFirst();
        if (!course) {
            throw new Error("No courses found in DB. Cannot test preferences.");
        }
        const courseId = course.id;

        // --- SCENARIO 1: SEAT BOOKING (Start from VON2600001) ---
        console.log("--- 1. Testing SEAT_BOOKING Flow ---");
        const sbData = {
             ...generateMockData('SEAT_BOOKING', true),
             pref1: courseId,
             pref2: courseId, // Just reusing for test
             pref3: courseId
        };
        
        const sbStudent = await registerStudent(sbData, null, null, "ADMIN_SCRIPT");
        console.log(`[SEAT_BOOKING] Registered. ID: ${sbStudent.applicationId}`);
        
        if (!sbStudent.applicationId.startsWith("VON")) {
            throw new Error(`[FAIL] SEAT_BOOKING Expected VON prefix, got ${sbStudent.applicationId}`);
        }

        console.log(`[SEAT_BOOKING] Admin recording Token Payment (Offline/Cash)...`);
        await FeeService.recordOfflinePayment(
            sbStudent.id,
            10000,
            PaymentMethod.CASH,
            PaymentComponent.SCHOLARSHIP_TOKEN,
            "ADMIN_SCRIPT"
        );

        const sbFresh = await prisma.student.findUnique({ 
            where: { id: sbStudent.id },
            include: { admissionDetails: true }
        });
        
        console.log(`[SEAT_BOOKING] Status after Token Pay: ${sbFresh?.admissionDetails?.status}`);
        if (sbFresh?.admissionDetails?.status !== AdmissionStatus.ADMISSION_CONFIRMED) {
             console.warn(`[WARN] Status expected ADMISSION_CONFIRMED, got ${sbFresh?.admissionDetails?.status}`);
        } else {
             console.log("[PASS] Status updated to ADMISSION_CONFIRMED");
        }


        // --- SCENARIO 2: NORMAL ONLINE (Start from VON2600001) ---
        console.log("\n--- 2. Testing ONLINE Flow ---");
        const onData = {
            ...generateMockData('ONLINE', false),
            pref1: courseId, pref2: courseId, pref3: courseId
        };
        const onStudent = await registerStudent(onData, null, null, "ADMIN_SCRIPT");
        console.log(`[ONLINE] Registered. ID: ${onStudent.applicationId}`);
        
        if (!onStudent.applicationId.startsWith("VON")) {
             throw new Error(`[FAIL] ONLINE Expected VON prefix, got ${onStudent.applicationId}`);
        }

        console.log(`[ONLINE] Admin recording Application Fee (Online Ref)...`);
        await FeeService.recordOfflinePayment(
            onStudent.id,
            500,
            PaymentMethod.UPI, 
            PaymentComponent.APPLICATION_FEE,
            "ADMIN_SCRIPT",
            `REF_ONLINE_${Date.now()}`
        );

        const onFresh = await prisma.student.findUnique({ 
            where: { id: onStudent.id },
            include: { admissionDetails: true }
        });
        console.log(`[ONLINE] Status after App Fee: ${onFresh?.admissionDetails?.status}`);


        // --- SCENARIO 3: OFFLINE (Start from VOF2600001) ---
        console.log("\n--- 3. Testing OFFLINE Flow ---");
        const offData = {
            ...generateMockData('OFFLINE', true),
            pref1: courseId, pref2: courseId, pref3: courseId
        };
        const offStudent = await registerStudent(offData, null, null, "ADMIN_SCRIPT");
        console.log(`[OFFLINE] Registered. ID: ${offStudent.applicationId}`);
        
        if (!offStudent.applicationId.startsWith("VOF")) {
             throw new Error(`[FAIL] OFFLINE Expected VOF prefix, got ${offStudent.applicationId}`);
        }

        console.log("\n=== ALL CHECKS COMPLETED ===");

    } catch (err) {
        console.error("\n[ERROR] Script Failed:", err);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

run();
