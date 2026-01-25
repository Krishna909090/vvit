
import { PrismaClient, PaymentStatus, PaymentComponent, PaymentMethod, PaymentMode } from '@prisma/client';
import { sendPaymentReceipt } from '../src/utils/emailService';
import { AdminStudentService } from '../src/modules/admin/adminStudent.service';
import { convertToPresignedUrl } from '../src/utils/s3Utils';
const prisma = new PrismaClient();

const EMAIL = 'bhsrikrishna1994@gmail.com';

async function main() {
    console.log(`Starting mock simulation for ${EMAIL}...`);

    // 1. Find or Create Student
    let student = await prisma.student.findFirst({
        where: { email: EMAIL }
    });

    if (!student) {
        console.log('Student not found. Creating test student...');
        // Create a basic student if not exists (minimal fields)
        // Note: In real scenarios, usually students apply first.
        // Assuming we rely on an existing structure, but let's try to fetch an existing one to clone or update.
        const helperStudent = await prisma.student.findFirst();
        if (helperStudent) {
             // Clone update
             student = await prisma.student.update({
                 where: { id: helperStudent.id },
                 data: { email: EMAIL, name: 'Srikrishna Test' }
             });
             console.log(`Updated existing student ${student.id} to use email ${EMAIL}`);
        } else {
            console.error('No students in DB to update. Cannot run test without student.');
            return;
        }
    } else {
        console.log(`Using existing student: ${student.id} (${student.name})`);
    }

    const studentId = student.id;

    // --- TEST 1: ENTRANCE EXAM FEE (Application Fee) ---
    console.log('\n--- Running Test 1: Entrance Exam Fee (Application Fee) ---');
    
    // Simulate Success Payment for Application Fee
    // We create a payment record manually and trigger the email receipt logic.
    // Ideally we would use `initiateApplicationFeePayment` but that requires PhonePe.
    // We want to test the EMAIL and INVOICE logic.
    
    // Create Dummy Invoice (Assume we generated one or skip invoice URL generation for simplicity in test script if strict not needed)
    // Actually, to get the email with invoice, we should simulate the flow component that calls sendPaymentReceipt.
    
    // Mock Data for Entrance Fee
    const entrancePayment = await prisma.payment.create({
        data: {
            studentId,
            amount: 500,
            method: PaymentMethod.UPI,
            mode: PaymentMode.ONLINE,
            status: PaymentStatus.SUCCESS,
            component: PaymentComponent.APPLICATION_FEE,
            providerTxId: `MOCK_ENTRANCE_${Date.now()}`
        }
    });
    console.log(`Created Mock Entrance Payment: ${entrancePayment.id}`);

    // Trigger Email manually (Simulation of what happens in processPaymentSuccess)
    // Note: We are testing the "Payment Receipt" email logic.
    await sendPaymentReceipt(EMAIL, {
        studentName: student.name,
        invoiceNumber: `INV/APP/${Date.now()}`,
        applicationId: student.applicationId || 'APP-001',
        transactionId: entrancePayment.providerTxId || 'N/A',
        amount: 500,
        date: new Date(),
        paymentType: 'APPLICATION_FEE',
        customFeeType: 'Application Fee',
        address: {
            line1: student.address,
            line2: student.address2 || '',
            city: student.city,
            state: student.state,
            pincode: student.pincode
        }
    });
    console.log('Entrance Fee Email Sent!');


    // --- TEST 2: FINALIZE ADMISSION (Admission Fee) ---
    console.log('\n--- Running Test 2: Finalize Admission (Admission Fee - offline) ---');

    // RESET STATUS to allow re-testing
    await prisma.studentAdmission.update({
        where: { studentId },
        data: {
            status: 'ENTRANCE_FEE_PAID',
            allottedCourseId: null,
            hostelId: null,
            transportRouteId: null
        }
    });
    console.log('Reset student status to ENTRANCE_FEE_PAID for test.');

    // Prepare Payload
    // Need valid IDs for Course, Hostel, FeeHead if strict checks exist.
    const course = await prisma.course.findFirst();
    if (!course) throw new Error('No courses found');
    
    const feeHead = await prisma.feeHead.findFirst(); // Nullable often

    const payload = {
        studentId: studentId,
        payment: {
            amount: 25000,
            method: PaymentMethod.CASH, // Offline Flow triggers immediate email in our new code
            date: new Date(),
            referenceNumber: `CASH_REF_${Date.now()}`,
            feeHeadId: feeHead?.id
        },
        scholarship: { percentage: 25 },
        allocation: {
            type: 'NONE' // Simple allocation
        },
        course: {
            allottedCourseId: course.id
        }
    };

    try {
        const result = await AdminStudentService.finalizeAdmission(payload, 'TEST_SCRIPT');
        console.log('Finalize Admission Result:', result);
        console.log('Admission Fee Email should have been sent by the service.');
    } catch (e) {
        console.error('Finalize Admission Failed:', e);
    }

}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
