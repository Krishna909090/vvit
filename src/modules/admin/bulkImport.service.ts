import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import prisma from '../../config/prisma';
import { 
    AdmissionStatus, 
    ApplicationMode, 
    PaymentStatus, 
    PaymentComponent, 
    PaymentMethod, 
    FeeStatus, 
    Prisma
} from '@prisma/client';
import { Role } from '../../constants/roles';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

// Type definitions for Excel Row Data
interface StudentImportRow {
    name: string;
    fatherName: string;
    motherName: string;
    email: string;
    phone: string;
    dob: Date | string;
    gender: string;
    aadharNumber: string;
    address: string;
    city: string;
    state: string;
    pincode: string;
    degreeType: string; 
    category: string;
    quotaType?: string; 
    amount?: number; 
}

export const processOfflineRegistration = async (fileBuffer: any, adminId: string) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);
    const worksheet = workbook.getWorksheet(1);

    if (!worksheet) {
        throw new AppError('Invalid Excel file: No worksheet found', 400);
    }

    const results = {
        success: 0,
        failed: 0,
        errors: [] as string[]
    };

    const rows: StudentImportRow[] = [];

    // Parse Headers
    // Allowing flexible headers or assuming fixed order/names. 
    // For robustness, let's assume specific headers map to keys.
    // Row 1 is header.
    
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip Header

        // naive mapping by index, or better by column name if we could.
        // Let's assume a strict template for now or Row values.
        // Assuming strict column order: 
        // 1: Name, 2: FatherName, 3: MotherName, 4: Email, 5: Phone, 6: DOB, 7: Gender, 8: Aadhar, 
        // 9: Address, 10: City, 11: State, 12: Pincode, 13: CourseType, 14: Category, 15: TokenAmount (Optional)

        const values = row.values as any[]; 
        // values is 1-based index array usually in ExcelJS. values[1] is col 1.
        
        if (!values[1] || !values[4] || !values[5]) { // Check minimal required: Name, Email, Phone
             // Skip empty rows
             return; 
        }

        rows.push({
            name: values[1],
            fatherName: values[2],
            motherName: values[3],
            email: values[4]?.text || values[4], // Handle hyperlinks
            phone: values[5]?.toString(),
            dob: values[6],
            gender: values[7],
            aadharNumber: values[8]?.toString(),
            address: values[9],
            city: values[10],
            state: values[11],
            pincode: values[12]?.toString(),
            degreeType: values[13],
            category: values[14]
        });
    });

    for (const data of rows) {
        try {
            await registerSingleStudent(data, ApplicationMode.OFFLINE, adminId);
            results.success++;
        } catch (error: any) {
            results.failed++;
            results.errors.push(`Row for ${data.email}: ${error.message}`);
            logger.error(`Import Error for ${data.email}`, error);
        }
    }

    return results;
};


export const processSeatBookingRegistration = async (fileBuffer: any, adminId: string) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);
    const worksheet = workbook.getWorksheet(1);
    
    if (!worksheet) {
        throw new AppError('Invalid Excel file: No worksheet found', 400);
    }

    const results = {
        success: 0,
        failed: 0,
        errors: [] as string[]
    };

    const rows: StudentImportRow[] = [];
    
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; 

        const values = row.values as any[]; 
        if (!values[1]) return;

        rows.push({
            name: values[1],
            fatherName: values[2],
            motherName: values[3],
            email: values[4]?.text || values[4],
            phone: values[5]?.toString(),
            dob: values[6],
            gender: values[7],
            aadharNumber: values[8]?.toString(),
            address: values[9],
            city: values[10],
            state: values[11],
            pincode: values[12]?.toString(),
            degreeType: values[13],
            category: values[14],
            amount: values[15] ? Number(values[15]) : 10000 // Default token amount
        });
    });

    for (const data of rows) {
        try {
            await registerSeatBookingStudent(data, adminId);
            results.success++;
        } catch (error: any) {
            results.failed++;
            results.errors.push(`Row for ${data.email}: ${error.message}`);
            logger.error(`Seat Booking Import Error for ${data.email}`, error);
        }
    }

    return results;
};

// Helper to Create User and Student
const registerSingleStudent = async (data: StudentImportRow, mode: ApplicationMode, adminId: string) => {
    // 1. Check Duplicates
    const existing = await prisma.student.findFirst({
        where: {
            OR: [
                { email: data.email },
                { aadharNumber: data.aadharNumber }
            ]
        }
    });

    if (existing) {
        throw new Error('Student already registered (Email or Aadhar match)');
    }

    // 2. Generate Application ID
    const prefix = mode === ApplicationMode.OFFLINE ? 'VOF' : 'VSB'; // VSB for Verified Seat Booking? Or just modify prefix logic
    // Using simple random or timestamp for now to avoid complexity of sequential check in loop inside loop
    // But keeping consistent with student service is better.
    // Let's rely on a simplified ID generator for bulk to be faster? 
    // Or just use the timestamp approach combined.
    // VOF2024...
    const applicationId = `${prefix}${Date.now()}${Math.floor(Math.random() * 100)}`;

    // 3. Create User
    const hashedPassword = await bcrypt.hash('Welcome@123', 10);
    
    return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
            data: {
                name: data.name,
                email: data.email,
                phone: data.phone,
                password: hashedPassword,
                role: Role.STUDENT,
                isDeleted: false
            }
        });

        const dobDate = new Date(data.dob);

        const student = await tx.student.create({
            data: {
                applicationId,
                name: data.name,
                fatherName: data.fatherName,
                motherName: data.motherName,
                gender: data.gender || 'MALE', // Fallback or strictly validate?
                dob: isValidDate(dobDate) ? dobDate : new Date(),
                phone: data.phone,
                email: data.email,
                aadharNumber: data.aadharNumber,
                category: data.category || 'OC',
                country: 'India', // Default
                address: data.address || '',
                city: data.city || '',
                state: data.state || '',
                pincode: data.pincode || '',
                degreeType: data.degreeType,
                applicationMode: mode,
                isOffline: mode === ApplicationMode.OFFLINE, // Backward compat
                userId: user.id,
                createdBy: adminId
            }
        });

        // 4. Admission Status
        await tx.studentAdmission.create({
            data: {
                studentId: student.id,
                status: AdmissionStatus.REGISTERED
            }
        });
        
        // 5. Exam Details
        await tx.studentExam.create({
            data: { studentId: student.id }
        });

        return student;
    });
};

const registerSeatBookingStudent = async (data: StudentImportRow, adminId: string) => {
     // 1. Check Duplicates (Same as above)
     const existing = await prisma.student.findFirst({
        where: {
            OR: [
                { email: data.email },
                { aadharNumber: data.aadharNumber }
            ]
        }
    });

    if (existing) {
        throw new Error('Student already registered');
    }

    const applicationId = `VSB${Date.now()}${Math.floor(Math.random() * 100)}`;
    const hashedPassword = await bcrypt.hash('Welcome@123', 10);

    return await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
            data: {
                name: data.name,
                email: data.email,
                phone: data.phone,
                password: hashedPassword,
                role: Role.STUDENT
            }
        });

        const dobDate = new Date(data.dob);

        const student = await tx.student.create({
            data: {
                applicationId,
                name: data.name,
                fatherName: data.fatherName,
                motherName: data.motherName,
                gender: data.gender || 'MALE', 
                dob: isValidDate(dobDate) ? dobDate : new Date(),
                phone: data.phone,
                email: data.email,
                aadharNumber: data.aadharNumber,
                category: data.category || 'OC',
                country: 'India', 
                address: data.address || '',
                city: data.city || '',
                state: data.state || '',
                pincode: data.pincode || '',
                degreeType: data.degreeType,
                applicationMode: 'SEAT_BOOKING' as ApplicationMode, // Cast to avoid lint error if d.ts outdated
                isOffline: true, 
                userId: user.id,
                createdBy: adminId
            }
        });


        // 4. Create Admission - Status ENTRANCE_FEE_PAID to allow slot booking
        // RECORD TOKEN PAYMENT
        const tokenAmount = data.amount || 10000;
        
        await tx.studentAdmission.create({
            data: {
                studentId: student.id,
                status: AdmissionStatus.ENTRANCE_FEE_PAID,
                feeStatus: FeeStatus.PARTIAL,
                paidFee: tokenAmount,
                totalFee: 0, // Will be updated later
                qualificationMode: 'DIRECT' // Likely DIRECT if seat booking? But they take exam... let's keep it null or EXAM
            }
        });

        await tx.studentExam.create({
            data: { studentId: student.id }
        });

        // Create Payment Record (Token)
        await tx.payment.create({
            data: {
                studentId: student.id,
                amount: tokenAmount,
                status: PaymentStatus.SUCCESS,
                component: PaymentComponent.SCHOLARSHIP_TOKEN, // Mapping to Token
                method: PaymentMethod.CASH, // or OFFLINE
                providerTxId: `OFF_TOK_${Date.now()}_${student.applicationId}`,
                metadata: { notes: 'Bulk Upload Seat Booking' }
            }
        });

        // Create Ledger Entry
        await tx.studentLedger.create({
            data: {
                studentId: student.id,
                type: 'CREDIT',
                amount: tokenAmount,
                description: 'Seat Booking Token Fee (Offline)',
                referenceType: 'PAYMENT',
                date: new Date()
            }
        });

        return student;
    });
};

const isValidDate = (d: any) => {
    return d instanceof Date && !isNaN(d.getTime());
};

export const verifyOfflinePayment = async (studentId: string, amount: number, type: 'ENTRANCE' | 'TOKEN', adminId: string) => {
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });

    if (!student || !student.admissionDetails) {
        throw new AppError('Student not found', 404);
    }

    if (student.admissionDetails.status !== AdmissionStatus.REGISTERED && type === 'ENTRANCE') {
        throw new AppError('Student status is not REGISTERED', 400);
    }
    
    const component = type === 'ENTRANCE' ? PaymentComponent.APPLICATION_FEE : PaymentComponent.SCHOLARSHIP_TOKEN;
    const nextStatus = type === 'ENTRANCE' ? AdmissionStatus.ENTRANCE_FEE_PAID : AdmissionStatus.ADMISSION_CONFIRMED;

    return await prisma.$transaction(async (tx) => {
        // Create Payment
        const payment = await tx.payment.create({
            data: {
                studentId,
                amount,
                status: PaymentStatus.SUCCESS,
                component,
                method: PaymentMethod.CASH,
                providerTxId: `OFF_${type}_${Date.now()}`,
                metadata: { verifiedBy: adminId }
            }
        });

        // Update Admission
        await tx.studentAdmission.update({
            where: { studentId },
            data: {
                status: nextStatus,
                feeStatus: FeeStatus.PARTIAL,
                paidFee: { increment: amount }
            }
        });
        
        // Ledger
        await tx.studentLedger.create({
            data: {
                studentId,
                type: 'CREDIT',
                amount,
                description: `${type} Fee Verified by Admin`,
                referenceType: 'PAYMENT',
                referenceId: payment.id,
                date: new Date()
            }
        });

        logger.info(`Offline payment verified for ${student.applicationId}: ${amount} ${type}`);
        return payment;
    });
};
