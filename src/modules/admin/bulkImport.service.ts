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

interface OfflineApplicationInput {
    applicationId: string;
    name: string;
    fatherName?: string;
    motherName?: string;
    email?: string;
    phone: string;
    dob?: string;
    gender?: string;
    aadharNumber?: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    pincode?: string;
    degreeType?: string;
    pref1?: string;
    pref2?: string;
    pref3?: string;
    profilePhotoUrl?: string;
    pro?: string;
    isKycVerified?: string;
}

export const validateOfflineApplications = async (applications: OfflineApplicationInput[]) => {
    const results = {
        valid: 0,
        invalid: 0,
        validRecords: [] as OfflineApplicationInput[],
        invalidRecords: [] as (OfflineApplicationInput & { errors: string[] })[]
    };

    // Check for duplicates within the input array itself
    const seenApplicationIds = new Set<string>();
    const seenPhones = new Set<string>();
    const seenEmails = new Set<string>();

    for (let i = 0; i < applications.length; i++) {
        const data = applications[i];
        const rowErrors: string[] = [];

        // Required fields
        if (!data.applicationId) rowErrors.push('applicationId is required');
        if (!data.name) rowErrors.push('name is required');
        if (!data.phone) rowErrors.push('phone is required');

        // Duplicate within batch
        if (data.applicationId && seenApplicationIds.has(data.applicationId)) {
            rowErrors.push(`Duplicate applicationId '${data.applicationId}' within batch`);
        }
        if (data.phone && seenPhones.has(data.phone)) {
            rowErrors.push(`Duplicate phone '${data.phone}' within batch`);
        }
        if (data.email && seenEmails.has(data.email)) {
            rowErrors.push(`Duplicate email '${data.email}' within batch`);
        }

        if (data.applicationId) seenApplicationIds.add(data.applicationId);
        if (data.phone) seenPhones.add(data.phone);
        if (data.email) seenEmails.add(data.email);

        // DOB validation
        if (data.dob) {
            const dobDate = new Date(data.dob);
            if (isNaN(dobDate.getTime())) {
                rowErrors.push(`Invalid date of birth: '${data.dob}'`);
            }
        }

        // Check duplicates against DB
        if (data.applicationId || data.phone) {
            const orConditions: any[] = [];
            if (data.applicationId) orConditions.push({ applicationId: data.applicationId });
            if (data.phone) orConditions.push({ phone: data.phone });
            if (data.aadharNumber) orConditions.push({ aadharNumber: data.aadharNumber });
            if (data.email) orConditions.push({ email: data.email });

            const existing = await prisma.student.findFirst({
                where: { OR: orConditions },
                select: { applicationId: true, phone: true, email: true, aadharNumber: true }
            });

            if (existing) {
                const matches: string[] = [];
                if (existing.applicationId === data.applicationId) matches.push(`applicationId: ${data.applicationId}`);
                if (existing.phone === data.phone) matches.push(`phone: ${data.phone}`);
                if (data.email && existing.email === data.email) matches.push(`email: ${data.email}`);
                if (data.aadharNumber && existing.aadharNumber === data.aadharNumber) matches.push(`aadhar: ${data.aadharNumber}`);
                rowErrors.push(`Student already exists in DB (matched: ${matches.join(', ')})`);
            }
        }

        // Check user table for email/phone conflict
        if (data.phone || data.email) {
            const userOrConditions: any[] = [];
            if (data.phone) userOrConditions.push({ phone: data.phone });
            if (data.email) userOrConditions.push({ email: data.email });

            const existingUser = await prisma.user.findFirst({
                where: { OR: userOrConditions },
                select: { phone: true, email: true }
            });

            if (existingUser) {
                const matches: string[] = [];
                if (existingUser.phone === data.phone) matches.push(`phone: ${data.phone}`);
                if (data.email && existingUser.email === data.email) matches.push(`email: ${data.email}`);
                rowErrors.push(`User already exists (matched: ${matches.join(', ')})`);
            }
        }

        // Course preference validation
        for (const prefKey of ['pref1', 'pref2', 'pref3'] as const) {
            const prefValue = data[prefKey];
            if (prefValue) {
                const course = await prisma.course.findUnique({ where: { id: prefValue } });
                if (!course) {
                    rowErrors.push(`Invalid ${prefKey} course ID: '${prefValue}'`);
                }
            }
        }

        if (rowErrors.length > 0) {
            results.invalid++;
            results.invalidRecords.push({ ...data, errors: rowErrors });
        } else {
            results.valid++;
            results.validRecords.push(data);
        }
    }

    return results;
};

export const processOfflineApplications = async (applications: OfflineApplicationInput[], adminId: string) => {
    // Re-validate on backend even though UI already validated (can't trust client)
    const validation = await validateOfflineApplications(applications);
    const invalidAppIds = new Set(validation.invalidRecords.map(r => r.applicationId));

    const results = {
        total: applications.length,
        success: 0,
        failed: validation.invalid,
        invalidRecords: validation.invalidRecords,
        errors: [] as { index: number; applicationId: string; errors: string[] }[],
        created: [] as { applicationId: string; studentId: string }[]
    };

    // Pre-fetch shared data
    const activeAcademicYear = await prisma.academicYear.findFirst({
        where: { isActive: true, isDeleted: false }
    });

    const uniqueProNumbers = [...new Set(applications.map(a => a.pro).filter(Boolean))] as string[];
    const proRecords = uniqueProNumbers.length > 0
        ? await prisma.pRO.findMany({ where: { proNumber: { in: uniqueProNumbers } } })
        : [];
    const proMap = new Map(proRecords.map(p => [p.proNumber, p.id]));

    const hashedPassword = await bcrypt.hash('Welcome@123', 10);

    // Pre-fetch StudentGroup for auto-assignment
    const studentGroup = await prisma.group.findUnique({ where: { name: 'StudentGroup' } });
    if (!studentGroup) {
        logger.error('[processOfflineApplications] CRITICAL: StudentGroup not found. Users will be created without group.');
    }

    if (applications.length === validation.invalid) {
        return results;
    }

    // Individual transaction per student (so one failure doesn't block others)
    for (let index = 0; index < applications.length; index++) {
        const data = applications[index];
        if (invalidAppIds.has(data.applicationId)) continue; // Skip records that failed validation
        try {
            const dobDate = data.dob ? new Date(data.dob) : undefined;
            const proId = data.pro ? (proMap.get(data.pro) || null) : null;

            const txResult = await prisma.$transaction(async (tx) => {
                const user = await tx.user.create({
                    data: {
                        name: data.name,
                        email: data.email || undefined,
                        phone: data.phone,
                        password: hashedPassword,
                        role: Role.STUDENT,
                        isDeleted: false
                    }
                });

                // Auto-assign to StudentGroup
                if (studentGroup) {
                    await tx.userGroup.create({
                        data: {
                            userId: user.id,
                            groupId: studentGroup.id
                        }
                    });
                }

                const student = await tx.student.create({
                    data: {
                        applicationId: data.applicationId,
                        name: data.name,
                        fatherName: data.fatherName || '',
                        motherName: data.motherName || '',
                        gender: data.gender || 'Male',
                        dob: dobDate && isValidDate(dobDate) ? dobDate : new Date(),
                        phone: data.phone,
                        email: data.email || undefined,
                        aadharNumber: data.aadharNumber || '',
                        category: 'OC',
                        country: data.country || 'India',
                        address: data.address || '',
                        city: data.city || '',
                        state: data.state || '',
                        pincode: data.pincode || '',
                        profilePhotoUrl: data.profilePhotoUrl || undefined,
                        degreeType: data.degreeType || undefined,
                        applicationMode: ApplicationMode.OFFLINE,
                        isOffline: true,
                        isKycVerified: data.isKycVerified === 'true' || data.isKycVerified === '1',
                        pref1: data.pref1 || undefined,
                        pref2: data.pref2 || undefined,
                        pref3: data.pref3 || undefined,
                        userId: user.id,
                        proId: proId,
                        createdBy: adminId
                    }
                });

                await tx.studentAdmission.create({
                    data: {
                        studentId: student.id,
                        status: AdmissionStatus.ENTRANCE_FEE_PAID,
                        feeStatus: FeeStatus.PARTIAL,
                        paidFee: 500,
                        academicYearId: activeAcademicYear?.id
                    }
                });

                const payment = await tx.payment.create({
                    data: {
                        studentId: student.id,
                        amount: 500,
                        status: PaymentStatus.SUCCESS,
                        component: PaymentComponent.APPLICATION_FEE,
                        method: PaymentMethod.CASH,
                        providerTxId: `OFF_APP_${Date.now()}_${data.applicationId}`,
                        metadata: { notes: 'Offline Application - Bulk Import', verifiedBy: adminId }
                    }
                });

                await tx.studentLedger.create({
                    data: {
                        studentId: student.id,
                        type: 'CREDIT',
                        amount: 500,
                        description: 'Application Fee (Offline)',
                        referenceType: 'PAYMENT',
                        referenceId: payment.id,
                        date: new Date()
                    }
                });

                return { studentId: student.id, paymentId: payment.id };
            });

            results.success++;
            results.created.push({ applicationId: data.applicationId, studentId: txResult.studentId });

        } catch (error: any) {
            results.failed++;
            results.errors.push({ index, applicationId: data.applicationId, errors: [`DB insert failed: ${error.message}`] });
            logger.error(`[processOfflineApplications] Insert failed for ${data.applicationId}: ${error.message}`);
        }
    }

    return results;
};
