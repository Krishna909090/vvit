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

// ── Helpers ───────────────────────────────────────────────────────────
// Resolve an academic year identifier that may be either a UUID or a code
// (e.g. "2025-26"). Admins typically know the code, not the UUID.
const resolveAcademicYearId = async (codeOrId: string): Promise<string | null> => {
    if (!codeOrId) return null;
    // UUID v4 detection
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(codeOrId);
    if (isUuid) {
        const ay = await prisma.academicYear.findUnique({ where: { id: codeOrId } });
        return ay?.id ?? null;
    }
    const ay = await prisma.academicYear.findFirst({ where: { code: codeOrId, isDeleted: false } });
    return ay?.id ?? null;
};

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
            }
        });

        await tx.studentExam.create({
            data: { studentId: student.id }
        });

        // Create Payment Record (Token).
        // academicYearId is not set on the admission in this flow, so skip it on the payment too
        // (no source of truth — would be guessing). yearOfStudy=1 since this is a new admission.
        const tokenTxnId = `OFF_TOK_${Date.now()}_${student.applicationId}`;
        await tx.payment.create({
            data: {
                studentId: student.id,
                amount: tokenAmount,
                status: PaymentStatus.SUCCESS,
                component: PaymentComponent.SCHOLARSHIP_TOKEN, // Mapping to Token
                method: PaymentMethod.CASH, // or OFFLINE
                providerTxId: tokenTxnId,
                idempotencyKey: `${tokenTxnId}_SCHOLARSHIP_TOKEN`,
                yearOfStudy: 1,
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
    const academicYearId = student.admissionDetails.academicYearId ?? undefined;

    return await prisma.$transaction(async (tx) => {
        // Create Payment
        const verifyTxnId = `OFF_${type}_${Date.now()}`;
        const payment = await tx.payment.create({
            data: {
                studentId,
                amount,
                status: PaymentStatus.SUCCESS,
                component,
                method: PaymentMethod.CASH,
                providerTxId: verifyTxnId,
                idempotencyKey: `${verifyTxnId}_${component}`,
                academicYearId,
                yearOfStudy: 1,
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
                        gender: (data.gender || 'MALE').toUpperCase(),
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

                const appTxnId = `OFF_APP_${Date.now()}_${data.applicationId}`;
                const payment = await tx.payment.create({
                    data: {
                        studentId: student.id,
                        amount: 500,
                        status: PaymentStatus.SUCCESS,
                        component: PaymentComponent.APPLICATION_FEE,
                        method: PaymentMethod.CASH,
                        providerTxId: appTxnId,
                        idempotencyKey: `${appTxnId}_APPLICATION_FEE`,
                        academicYearId: activeAcademicYear?.id,
                        yearOfStudy: 1,
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

// ── Bulk Manual-Entry Admission ────────────────────────────────────────
// Pre-flight validation for the bulk manual-entry flow (lateral / transfer /
// back-dated admissions). Mirrors validateOfflineApplications: accepts a JSON
// array (frontend parses CSV/Excel client-side and posts JSON), returns
// detailed per-row errors and does NOT touch the DB beyond reads.
export const validateBulkManualEntry = async (rows: any[]) => {
    const results = {
        total: rows.length,
        valid: 0,
        invalid: 0,
        validRecords: [] as any[],
        invalidRecords: [] as (any & { errors: string[] })[]
    };

    // Track within-batch duplicates
    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();
    const seenAadhars = new Set<string>();
    const seenRollNumbers = new Set<string>();  // rollNumber must be unique within batch

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const errors: string[] = [];

        // 1. Required field presence
        if (!row.student?.name)         errors.push('student.name is required');
        if (!row.student?.phone)        errors.push('student.phone is required');
        if (!row.student?.aadharNumber) errors.push('student.aadharNumber is required');
        if (!row.student?.dob)          errors.push('student.dob is required');
        if (!row.student?.quotaType)    errors.push('student.quotaType is required');
        if (!row.course?.allottedCourseId) errors.push('course.allottedCourseId is required');
        if (!row.entry?.academicYearId) errors.push('entry.academicYearId is required');
        if (!row.entry?.yearOfStudy)    errors.push('entry.yearOfStudy is required');
        if (!row.enrollment?.sectionId) errors.push('enrollment.sectionId is required');
        if (!row.enrollment?.rollNumber) errors.push('enrollment.rollNumber is required');

        // 2. Lateral-specific rules
        if (row.entry?.type === 'LATERAL' && (row.entry?.yearOfStudy ?? 1) < 2) {
            errors.push('LATERAL entry requires yearOfStudy >= 2');
        }
        if (row.entry?.type === 'LATERAL' && row.scholarship?.percentage !== undefined) {
            const pct = row.scholarship.percentage;
            if (![0, 15, 25, 50].includes(pct)) {
                errors.push(`LATERAL entry scholarship must be 0/15/25/50; got ${pct}`);
            }
        }

        // 3. Within-batch duplicates
        if (row.student?.email) {
            if (seenEmails.has(row.student.email)) errors.push(`Duplicate email '${row.student.email}' within batch`);
            else seenEmails.add(row.student.email);
        }
        if (row.student?.phone) {
            if (seenPhones.has(row.student.phone)) errors.push(`Duplicate phone '${row.student.phone}' within batch`);
            else seenPhones.add(row.student.phone);
        }
        if (row.student?.aadharNumber) {
            if (seenAadhars.has(row.student.aadharNumber)) errors.push(`Duplicate aadhar '${row.student.aadharNumber}' within batch`);
            else seenAadhars.add(row.student.aadharNumber);
        }
        if (row.enrollment?.rollNumber) {
            if (seenRollNumbers.has(row.enrollment.rollNumber)) errors.push(`Duplicate rollNumber '${row.enrollment.rollNumber}' within batch`);
            else seenRollNumbers.add(row.enrollment.rollNumber);
        }

        // 4. Resolve academic year code → id (in-place for the row, so process step doesn't redo it)
        if (row.entry?.academicYearId) {
            const resolvedId = await resolveAcademicYearId(row.entry.academicYearId);
            if (!resolvedId) {
                errors.push(`Academic year not found: '${row.entry.academicYearId}'`);
            } else {
                row.entry.academicYearId = resolvedId;
            }
        }

        // 5. DB existence checks (only if no critical errors so far)
        if (errors.length === 0) {
            const [course, section, dbDuplicate] = await Promise.all([
                prisma.course.findUnique({ where: { id: row.course.allottedCourseId } }),
                prisma.section.findUnique({ where: { id: row.enrollment.sectionId } }),
                prisma.student.findFirst({
                    where: {
                        OR: [
                            row.student.email ? { email: row.student.email } : undefined,
                            row.student.phone ? { phone: row.student.phone } : undefined,
                            row.student.aadharNumber ? { aadharNumber: row.student.aadharNumber } : undefined,
                        ].filter(Boolean) as any
                    }
                })
            ]);
            if (!course)  errors.push(`Invalid courseId: ${row.course.allottedCourseId}`);
            if (!section) errors.push(`Invalid sectionId: ${row.enrollment.sectionId}`);
            if (dbDuplicate) errors.push(`Student already exists (email/phone/aadhar match)`);

            // Backdated check: academic year startDate must be < NOW()
            if (row.entry?.isBackdated) {
                const ay = await prisma.academicYear.findUnique({ where: { id: row.entry.academicYearId } });
                if (ay && ay.startDate > new Date()) {
                    errors.push('isBackdated=true but academic year has not started yet');
                }
            }
        }

        if (errors.length > 0) {
            results.invalid++;
            results.invalidRecords.push({ ...row, _rowIndex: i, errors });
        } else {
            results.valid++;
            results.validRecords.push(row);
        }
    }

    return results;
};

// Process a validated batch of manual-entry admissions. Re-runs validation on
// the backend (can't trust the client), then invokes
// AdminStudentService.manualEntryAdmission per valid row sequentially. Lazy
// import is used to dodge any circular-dep risk between admin services.
export const processBulkManualEntry = async (rows: any[], adminId: string) => {
    // Re-validate on backend
    const validation = await validateBulkManualEntry(rows);

    const results = {
        total: rows.length,
        success: 0,
        failed: validation.invalid,
        errors: validation.invalidRecords.map(r => ({
            rowIndex: r._rowIndex,
            email: r.student?.email,
            phone: r.student?.phone,
            errors: r.errors
        })),
        created: [] as { rowIndex: number, studentId: string, applicationId: string, entryType: string }[]
    };

    // Process valid rows one at a time (the underlying service uses transactions; running in parallel
    // would multiply DB connection use and complicate error attribution)
    for (let i = 0; i < validation.validRecords.length; i++) {
        const row = validation.validRecords[i];
        try {
            // Lazy-import to avoid circular dep risk
            const { AdminStudentService } = await import('./adminStudent.service');
            const result = await AdminStudentService.manualEntryAdmission(row, adminId);
            results.success++;
            results.created.push({
                rowIndex: rows.indexOf(row),
                studentId: result.studentId,
                applicationId: result.applicationId ?? '',
                entryType: result.entryType
            });
        } catch (err: any) {
            results.failed++;
            results.errors.push({
                rowIndex: rows.indexOf(row),
                email: row.student?.email,
                phone: row.student?.phone,
                errors: [err?.message ?? 'Unknown error']
            });
            logger.error(`[processBulkManualEntry] Row ${rows.indexOf(row)} failed: ${err?.message}`);
        }
    }

    logger.info(`[processBulkManualEntry] Completed: total=${results.total}, success=${results.success}, failed=${results.failed}`);
    return results;
};

/**
 * Generate a CSV template for the bulk manual-entry import.
 *
 * The template uses a flat (non-nested) header structure for ease of editing in
 * Excel. Frontend parses CSV → re-nests into the manualEntryAdmissionSchema shape
 * before POSTing to /admin/bulk-import/manual-entry. The header names match the
 * dot-paths of the validator schema fields.
 */
export const generateManualEntryTemplate = (): string => {
    const headers = [
        // Student profile
        'student.name', 'student.fatherName', 'student.motherName', 'student.gender', 'student.dob',
        'student.phone', 'student.email', 'student.aadharNumber', 'student.category',
        'student.country', 'student.address', 'student.address2', 'student.city',
        'student.state', 'student.pincode', 'student.profilePhotoUrl', 'student.quotaType',
        // Course allocation
        'course.allottedCourseId',
        // Entry context
        'entry.type', 'entry.yearOfStudy', 'entry.academicYearId',
        'entry.currentSemester', 'entry.reason', 'entry.isBackdated',
        // Enrollment
        'enrollment.sectionId', 'enrollment.rollNumber',
        // Scholarship (optional)
        'scholarship.percentage', 'scholarship.ruleId',
        // Accommodation (optional)
        'accommodation.type', 'accommodation.hostelId', 'accommodation.hostelType',
        'accommodation.hostelPaymentMode', 'accommodation.transportRouteId',
        // Prior payment (optional)
        'priorPayment.amount', 'priorPayment.method', 'priorPayment.component',
        'priorPayment.referenceNumber', 'priorPayment.date', 'priorPayment.feeHeadId',
    ];

    // One example row showing a lateral-entry management-quota student with 50% scholarship
    const exampleRow = [
        'Ravi Kumar', 'Mohan Kumar', 'Sita Devi', 'MALE', '2003-06-15',
        '9876543210', 'ravi@example.com', '123456789012', 'OC',
        'India', 'Plot 12, Main Road', '', 'Vijayawada',
        'AP', '520001', '', 'MANAGEMENT',
        // course.allottedCourseId — paste a course UUID from your DB
        '00000000-0000-0000-0000-000000000000',
        // entry
        'LATERAL', '2', '2025-26', '3', 'Diploma → BTech 2nd year', 'false',
        // enrollment
        '00000000-0000-0000-0000-000000000000', 'L25BTC001',
        // scholarship
        '50', '',
        // accommodation
        'NONE', '', '', '', '',
        // prior payment
        '', '', '', '', '', '',
    ];

    // Properly escape commas/quotes/newlines in CSV cells
    const escapeCsv = (cell: string): string => {
        if (cell == null) return '';
        const s = String(cell);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    };

    const headerLine = headers.map(escapeCsv).join(',');
    const exampleLine = exampleRow.map(escapeCsv).join(',');

    // Add a leading explanatory comment row (CSVs commonly tolerate this; admins can delete it)
    const notesLine = [
        '# Bulk manual-entry template. Replace the example row below with real data, then upload via your admin UI.',
        '# entry.academicYearId can be either a UUID or a code like "2025-26".',
        '# entry.type ∈ REGULAR | LATERAL | TRANSFER. LATERAL requires yearOfStudy >= 2.',
        '# scholarship.percentage for LATERAL must be 0, 15, 25, or 50.',
        '# Optional fields can be left blank. Date format: ISO 8601 (YYYY-MM-DD).',
    ].join('\n');

    return `${notesLine}\n${headerLine}\n${exampleLine}\n`;
};
