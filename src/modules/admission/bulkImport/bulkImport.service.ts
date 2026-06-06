import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import prisma from '../../../config/prisma';
import {
    AdmissionStatus,
    AdmissionEntryType,
    ApplicationMode,
    PaymentStatus,
    PaymentComponent,
    PaymentMethod,
    FeeStatus
} from '@prisma/client';
import { Role } from '../../../constants/roles';
import { AppError } from '../../../utils/AppError';
import logger from '../../../utils/logger';

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

const resolveAcademicYearId = async (codeOrId: string): Promise<string | null> => {
    if (!codeOrId) return null;

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

    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        const values = row.values as any[]; 

        if (!values[1] || !values[4] || !values[5]) {

             return; 
        }

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
            amount: values[15] ? Number(values[15]) : 10000
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

const registerSingleStudent = async (data: StudentImportRow, mode: ApplicationMode, adminId: string) => {

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

    const prefix = mode === ApplicationMode.OFFLINE ? 'VOF' : 'VSB';

    const applicationId = `${prefix}${Date.now()}${randomBytes(4).toString('hex')}`;

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
                applicationMode: mode,
                isOffline: mode === ApplicationMode.OFFLINE,
                userId: user.id,
                createdBy: adminId
            }
        });

        const activeYear = await tx.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });
        await tx.studentAdmission.create({
            data: {
                studentId: student.id,
                academicYearId: activeYear.id,
                status: AdmissionStatus.REGISTERED,

                entryType: AdmissionEntryType.REGULAR,
                entryYearOfStudy: 1,
                entryAcademicYearId: activeYear.id,
                feeCohortAcademicYearId: activeYear.id,
                batchAcademicYearId: activeYear.id,
                instituteCode: 'MGMT',
            }
        });

        await tx.studentExam.create({
            data: { studentId: student.id }
        });

        return student;
    });
};

const registerSeatBookingStudent = async (data: StudentImportRow, adminId: string) => {

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

    const applicationId = `VSB${Date.now()}${randomBytes(4).toString('hex')}`;
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
                applicationMode: 'SEAT_BOOKING' as ApplicationMode,
                isOffline: true, 
                userId: user.id,
                createdBy: adminId
            }
        });

        const tokenAmount = data.amount || 10000;
        
        const activeYear = await tx.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });
        await tx.studentAdmission.create({
            data: {
                studentId: student.id,
                academicYearId: activeYear.id,
                status: AdmissionStatus.ENTRANCE_FEE_PAID,
                feeStatus: FeeStatus.PARTIAL,
                paidFee: tokenAmount,
                totalFee: 0,
                entryType: AdmissionEntryType.REGULAR,
                entryYearOfStudy: 1,
                entryAcademicYearId: activeYear.id,
                feeCohortAcademicYearId: activeYear.id,
                batchAcademicYearId: activeYear.id,
                instituteCode: 'MGMT',
            }
        });

        await tx.studentExam.create({
            data: { studentId: student.id }
        });

        const tokenTxnId = `OFF_TOK_${Date.now()}_${student.applicationId}`;
        await tx.payment.create({
            data: {
                studentId: student.id,
                amount: tokenAmount,
                status: PaymentStatus.SUCCESS,
                component: PaymentComponent.SCHOLARSHIP_TOKEN,
                method: PaymentMethod.CASH,
                providerTxId: tokenTxnId,
                idempotencyKey: `${tokenTxnId}_SCHOLARSHIP_TOKEN`,
                yearOfStudy: 1,
                academicYearId: activeYear.id,
                metadata: { notes: 'Bulk Upload Seat Booking' }
            }
        });

        await tx.studentLedger.create({
            data: {
                studentId: student.id,
                type: 'CREDIT',
                amount: tokenAmount,
                description: 'Seat Booking Token Fee (Offline)',
                referenceType: 'PAYMENT',
                academicYearId: activeYear.id,
                yearOfStudy: 1,
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
    const academicYearId = student.admissionDetails.academicYearId;

    return await prisma.$transaction(async (tx) => {

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

        await tx.studentAdmission.update({
            where: { studentId },
            data: {
                status: nextStatus,
                feeStatus: FeeStatus.PARTIAL,
                paidFee: { increment: amount }
            }
        });

        await tx.studentLedger.create({
            data: {
                studentId,
                type: 'CREDIT',
                amount,
                description: `${type} Fee Verified by Admin`,
                referenceType: 'PAYMENT',
                referenceId: payment.id,
                academicYearId,
                yearOfStudy: 1,
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

    const seenApplicationIds = new Set<string>();
    const seenPhones = new Set<string>();
    const seenEmails = new Set<string>();

    for (let i = 0; i < applications.length; i++) {
        const data = applications[i];
        const rowErrors: string[] = [];

        if (!data.applicationId) rowErrors.push('applicationId is required');
        if (!data.name) rowErrors.push('name is required');
        if (!data.phone) rowErrors.push('phone is required');

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

        if (data.dob) {
            const dobDate = new Date(data.dob);
            if (isNaN(dobDate.getTime())) {
                rowErrors.push(`Invalid date of birth: '${data.dob}'`);
            }
        }

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

    const activeAcademicYear = await prisma.academicYear.findFirst({
        where: { isActive: true, isDeleted: false }
    });
    if (!activeAcademicYear) {
        throw new AppError('No active academic year is set. Configure one before bulk-importing applications.', 400);
    }

    const uniqueProNumbers = [...new Set(applications.map(a => a.pro).filter(Boolean))] as string[];
    const proRecords = uniqueProNumbers.length > 0
        ? await prisma.pRO.findMany({ where: { proNumber: { in: uniqueProNumbers } } })
        : [];
    const proMap = new Map(proRecords.map(p => [p.proNumber, p.id]));

    const hashedPassword = await bcrypt.hash('Welcome@123', 10);

    const studentGroup = await prisma.group.findUnique({ where: { name: 'StudentGroup' } });
    if (!studentGroup) {
        logger.error('[processOfflineApplications] CRITICAL: StudentGroup not found. Users will be created without group.');
    }

    if (applications.length === validation.invalid) {
        return results;
    }

    for (let index = 0; index < applications.length; index++) {
        const data = applications[index];
        if (invalidAppIds.has(data.applicationId)) continue;
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
                        academicYearId: activeAcademicYear.id,
                        entryType: AdmissionEntryType.REGULAR,
                        entryYearOfStudy: 1,
                        entryAcademicYearId: activeAcademicYear.id,
                        feeCohortAcademicYearId: activeAcademicYear.id,
                        batchAcademicYearId: activeAcademicYear.id,
                        instituteCode: 'MGMT',
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
                        academicYearId: activeAcademicYear.id,
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
                        academicYearId: activeAcademicYear.id,
                        yearOfStudy: 1,
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

export const validateBulkManualEntry = async (rows: any[]) => {
    const results = {
        total: rows.length,
        valid: 0,
        invalid: 0,
        validRecords: [] as any[],
        invalidRecords: [] as (any & { errors: string[] })[]
    };

    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();
    const seenAadhars = new Set<string>();
    const seenRollNumbers = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const errors: string[] = [];

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

        if (row.entry?.type === 'LATERAL' && (row.entry?.yearOfStudy ?? 1) < 2) {
            errors.push('LATERAL entry requires yearOfStudy >= 2');
        }
        if (row.entry?.type === 'LATERAL' && row.scholarship?.percentage !== undefined) {
            const pct = row.scholarship.percentage;
            if (![0, 15, 25, 50].includes(pct)) {
                errors.push(`LATERAL entry scholarship must be 0/15/25/50; got ${pct}`);
            }
        }

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

        if (row.entry?.academicYearId) {
            const resolvedId = await resolveAcademicYearId(row.entry.academicYearId);
            if (!resolvedId) {
                errors.push(`Academic year not found: '${row.entry.academicYearId}'`);
            } else {
                row.entry.academicYearId = resolvedId;
            }
        }

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

export const processBulkManualEntry = async (rows: any[], adminId: string) => {

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

    for (let i = 0; i < validation.validRecords.length; i++) {
        const row = validation.validRecords[i];
        try {

            const { AdminStudentService } = await import('../../studentManagement/adminStudent.service');
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

export const generateManualEntryTemplate = (): string => {
    const headers = [

        'student.name', 'student.fatherName', 'student.motherName', 'student.gender', 'student.dob',
        'student.phone', 'student.email', 'student.aadharNumber', 'student.category',
        'student.country', 'student.address', 'student.address2', 'student.city',
        'student.state', 'student.pincode', 'student.profilePhotoUrl', 'student.quotaType',

        'course.allottedCourseId',

        'entry.type', 'entry.yearOfStudy', 'entry.academicYearId',
        'entry.currentSemester', 'entry.reason', 'entry.isBackdated',

        'enrollment.sectionId', 'enrollment.rollNumber',

        'scholarship.percentage', 'scholarship.ruleId',

        'accommodation.type', 'accommodation.hostelId', 'accommodation.hostelType',
        'accommodation.hostelPaymentMode', 'accommodation.transportRouteId',

        'priorPayment.amount', 'priorPayment.method', 'priorPayment.component',
        'priorPayment.referenceNumber', 'priorPayment.date', 'priorPayment.feeHeadId',
    ];

    const exampleRow = [
        'Ravi Kumar', 'Mohan Kumar', 'Sita Devi', 'MALE', '2003-06-15',
        '9876543210', 'ravi@example.com', '123456789012', 'OC',
        'India', 'Plot 12, Main Road', '', 'Vijayawada',
        'AP', '520001', '', 'MANAGEMENT',

        '00000000-0000-0000-0000-000000000000',

        'LATERAL', '2', '2025-26', '3', 'Diploma → BTech 2nd year', 'false',

        '00000000-0000-0000-0000-000000000000', 'L25BTC001',

        '50', '',

        'NONE', '', '', '', '',

        '', '', '', '', '', '',
    ];

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

    const notesLine = [
        '# Bulk manual-entry template. Replace the example row below with real data, then upload via your admin UI.',
        '# entry.academicYearId can be either a UUID or a code like "2025-26".',
        '# entry.type ∈ REGULAR | LATERAL | TRANSFER. LATERAL requires yearOfStudy >= 2.',
        '# scholarship.percentage for LATERAL must be 0, 15, 25, or 50.',
        '# Optional fields can be left blank. Date format: ISO 8601 (YYYY-MM-DD).',
    ].join('\n');

    return `${notesLine}\n${headerLine}\n${exampleLine}\n`;
};
