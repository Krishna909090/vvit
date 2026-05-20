import prisma from '../../config/prisma';
import QRCode from 'qrcode';
import {
    AdmissionStatus,
    StudentDocumentStatus,
    Prisma
} from '@prisma/client';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { verifyAadhar } from '../integration/integration.service';
import { deleteFileFromS3, getPresignedUrl, convertToPresignedUrl } from '../../utils/s3Utils';
import { MESSAGES } from '../../constants/messages';
import { formatDate, formatTime, formatDateTime } from '../../utils/dateFormatter';
import { maskAadhaar } from '../../utils/mask';
import { getActiveAcademicYear } from '../../utils/studentContext';

// Resolve the active academic year id for year-tagging new rows. Throws (via getActiveAcademicYear)
// if no active year is configured — academicYearId is required on StudentDocument since the
// year-tag migration.
const resolveActiveYearId = async (): Promise<string> => {
    return (await getActiveAcademicYear()).id;
};

export const registerStudent = async (data: any, userId: string | null, currentUserId: string | null) => {
    // Check for duplicate registration
    const dobDate = data.dob ? new Date(data.dob) : undefined;

    // Verify Aadhaar BEFORE masking
    if (data.aadharNumber) {
        const isValidAadhar = await verifyAadhar(data.aadharNumber);
        if (!isValidAadhar) {
            throw new AppError(MESSAGES.ERROR.INVALID_AADHAR, 400);
        }

        // Duplicate check: last 4 digits of Aadhaar + DOB
        if (dobDate) {
            const last4 = data.aadharNumber.toString().trim().replace(/\s/g, '').slice(-4);
            const maskedPattern = `XXXX XXXX ${last4}`;
            const dobStart = new Date(dobDate.getFullYear(), dobDate.getMonth(), dobDate.getDate());
            const dobEnd = new Date(dobDate.getFullYear(), dobDate.getMonth(), dobDate.getDate(), 23, 59, 59, 999);

            const duplicateStudent = await prisma.student.findFirst({
                where: {
                    aadharNumber: maskedPattern,
                    dob: { gte: dobStart, lte: dobEnd }
                }
            });

            if (duplicateStudent) {
                throw new AppError(
                    `Student Record Already Exist`,
                    409
                );
            }
        }

        // Mask Aadhaar for storage
        data.aadharNumber = maskAadhaar(data.aadharNumber);
    }

    const orConditions: any[] = [
        { email: data.email }
        // { aadharNumber: data.aadharNumber } // Removed: Cannot check uniqueness on masked values
    ];

    if (userId) {
        orConditions.push({ userId });
    }

    const existingStudent = await prisma.student.findFirst({
        where: {
            OR: orConditions    
        }
    });

    if (existingStudent) {
        let conflict = 'details';
        if (existingStudent.email === data.email) conflict = 'Email';
        else if (userId && existingStudent.userId === userId) conflict = 'User Account';
        
        throw new AppError(`Student conflict: A student is already registered with this ${conflict}`, 400);
    }

    const isOffline = data.isOffline || data.applicationMode === 'SEAT_BOOKING' || data.applicationMode === 'OFFLINE';
    
    // Determine prefix:
    //   LATERAL entry -> VLE (overrides mode; lateral has its own series)
    //   Offline       -> VOF
    //   Default       -> VON (online + seat booking)
    let prefix = 'VON';
    if (data.entryType === 'LATERAL') {
        prefix = 'VLE';
    } else if (data.applicationMode === 'OFFLINE' || (data.isOffline && data.applicationMode !== 'SEAT_BOOKING')) {
        prefix = 'VOF';
    }

    // Generate unique applicationId with retry logic to handle race conditions
    let applicationId = '';
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
        // Find the last student with the same prefix to determine the next ID
        // Note: isOffline filter removed from query to ensure we look for the last ID of that series regardless of exact offline flag status in DB
        // (though usually they match)
        const lastStudent = await prisma.student.findFirst({
            where: {
                applicationId: { startsWith: prefix }
            },
            orderBy: { createdAt: 'desc' } // or orderBy applicationId length then value to get true max?
            // Simple string sort might fail if lengths differ (VON9 vs VON10), but here we are jumping to 7 digits.
            // Best to sort by createdAt to get the latest one.
        });

        let nextIdNumber = 2600001;
        if (lastStudent && lastStudent.applicationId) {
            const lastIdPart = lastStudent.applicationId.replace(prefix, '');
            const lastNumber = parseInt(lastIdPart, 10);
            if (!isNaN(lastNumber)) {
                nextIdNumber = lastNumber + 1;
                // Ensure we respect the minimum starting number
                if (nextIdNumber < 2600001) {
                    nextIdNumber = 2600001;
                }
            }
        }

        applicationId = `${prefix}${nextIdNumber}`;

        // Check if this applicationId already exists (race condition check)
        const existingWithId = await prisma.student.findUnique({
            where: { applicationId }
        });

        if (!existingWithId) {
            // ID is unique, break the loop
            break;
        }

        // ID already exists, increment and retry
        attempts++;
        logger.warn(`[registerStudent] ApplicationId ${applicationId} already exists, retrying... (attempt ${attempts}/${maxAttempts})`);
        
        if (attempts >= maxAttempts) {
            throw new AppError('Failed to generate unique application ID after multiple attempts. Please try again.', 500);
        }
    }

    logger.info(`[registerStudent] Generated applicationId: ${applicationId}`);

    // Fetch Active Academic Year — required for StudentAdmission since the year-tag migration.
    const activeAcademicYear = await prisma.academicYear.findFirst({
        where: { isActive: true, isDeleted: false }
    });
    if (!activeAcademicYear) {
        throw new AppError('No active academic year is set. Configure one before registering students.', 400);
    }

    // Handle PRO Number mapping
    let proIdToStore: string | null = null;
    const incomingPro = data.proNumber || data.pro;
    if (incomingPro) {
        const proRecord = await prisma.pRO.findUnique({
            where: { proNumber: incomingPro }
        });
        if (!proRecord) {
            throw new AppError('Invalid PRO number provided', 400);
        }
        proIdToStore = proRecord.id;
    }

    // Transaction to create Student and related tables
    const student = await prisma.$transaction(async (tx) => {
        // Double-check uniqueness within transaction
        const existingInTx = await tx.student.findUnique({
            where: { applicationId }
        });

        if (existingInTx) {
            throw new AppError('Application ID conflict detected. Please try again.', 409);
        }

        const newStudent = await tx.student.create({
            data: {
                applicationId,
                name: data.name,
                fatherName: data.fatherName,
                motherName: data.motherName,
                gender: data.gender,
                dob: data.dob instanceof Date ? data.dob : new Date(data.dob),
                phone: data.phone,
                email: data.email,
                aadharNumber: data.aadharNumber,
                category: data.category,
                country: data.country,
                address: data.address,
                address2: data.address2,
                city: data.city,
                state: data.state,
                pincode: data.pincode,
                profilePhotoUrl: data.profilePhotoUrl,
                isOffline: data.isOffline || data.applicationMode === 'SEAT_BOOKING' || data.applicationMode === 'OFFLINE' || false,
                degreeType: data.degreeType,
                applicationMode: data.applicationMode,
                quotaType: data.quotaType,
                pref1: data.pref1 || undefined,
                pref2: data.pref2 || undefined,
                pref3: data.pref3 || undefined,
                userId: userId,
                isKycVerified: data.isKycVerified,
                proId: proIdToStore
            }
        });

        // Create Admission Details. Defaults to REGULAR year-1 if caller doesn't
        // specify; laterals pass entryType=LATERAL, entryYearOfStudy=2 so the
        // admission record carries the right cohort tag from day one.
        const entryType        = data.entryType ?? 'REGULAR';
        const entryYearOfStudy = data.entryYearOfStudy
            ?? (entryType === 'LATERAL' ? 2 : entryType === 'TRANSFER' ? 3 : 1);
        const entryAcademicYearId = activeAcademicYear.id;
        const feeCohortAcademicYearId = entryAcademicYearId;

        // Default to VVIG. Admin sets VVITU/VVITPU explicitly only for 2025-26 batch students.
        const instituteCode = data.instituteCode ?? 'VVIG';

        await tx.studentAdmission.create({
            data: {
                studentId: newStudent.id,
                status: AdmissionStatus.REGISTERED,
                academicYearId: activeAcademicYear.id,
                entryType: entryType as any,
                entryYearOfStudy,
                entryAcademicYearId,
                feeCohortAcademicYearId,
                instituteCode,
            }
        });

        // Create Exam Details
        await tx.studentExam.create({
            data: {
                studentId: newStudent.id
            }
        });

        return newStudent;
    });

    const fullStudentDetails = await prisma.student.findUnique({
        where: { id: student.id },
        select: {
            id:true,
            name: true,
            fatherName: true,
            motherName: true,
            gender: true,
            dob: true,
            phone: true,
            email: true,
            aadharNumber: true,
            category: true,
            country: true,
            address: true,
            address2: true,
            city: true,
            state: true,
            pincode: true,
            profilePhotoUrl: true,
            isKycVerified: true,
            pref1: true,
            pref2: true,
            pref3: true,
            degreeType: true,
            userId: true,
            applicationId: true, // Needed for logger and likely client
            proId: true,
            pro: true
        }
    });

    if (!fullStudentDetails) {
        throw new AppError("Failed to retrieve registered student details", 500);
    }

    logger.info(`Student registered: ${student.applicationId}`);
    return fullStudentDetails;
};





export const getHallTicket = async (studentId: string) => {
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { 
            admissionDetails: true, 
            examDetails: {
                include: { examSlot: true }
            },
            hallTickets: {
                orderBy: { generatedAt: 'desc' },
                take: 1
            }
        }
    });

    if (!student || !student.admissionDetails || !student.examDetails) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    const status = student.admissionDetails.status;

    if (status !== AdmissionStatus.EXAM_SCHEDULED &&
        status !== AdmissionStatus.EXAM_ATTENDED &&
        status !== AdmissionStatus.DOCUMENTS_SUBMITTED &&
        status !== AdmissionStatus.SEAT_ALLOTTED &&
        status !== AdmissionStatus.ADMISSION_CONFIRMED
    ) {
        throw new AppError(MESSAGES.ERROR.HALL_TICKET_NOT_GENERATED, 400);
    }

    let qrCodeImage = null;
    const latestHallTicket = student.hallTickets[0];
    
    if (latestHallTicket && latestHallTicket.qrHash) {
        try {
            qrCodeImage = await QRCode.toDataURL(latestHallTicket.qrHash);
        } catch (err) {
            logger.error(`Failed to generate QR code for student ${studentId}: ${err}`);
        }
    }

    // Convert URLs to presigned URLs
    const hallTicketDownloadUrl = await convertToPresignedUrl(latestHallTicket?.url);
    const photoUrl = await convertToPresignedUrl(student.profilePhotoUrl);

    logger.info(`Hall ticket retrieved for student: ${studentId}`);
    
    return {
        qrCodeImage,
        studentName: student.name,
        applicationId: student.applicationId,
        photoUrl,
        examCenter: student.examDetails.testCenter,
        examDate: formatDate(student.examDetails.testDate),
        startTime: formatTime(student.examDetails.examSlot?.startTime),
        endTime: formatTime(student.examDetails.examSlot?.endTime),
        hallTicketDownloadUrl
    };
};

export const getHallTicketByApplicationId = async (applicationId: string) => {
    const student = await prisma.student.findUnique({ where: { applicationId } });
    if (!student) throw new AppError('Student not found for this application ID', 404);
    return getHallTicket(student.id);
};

export const uploadDocumentsAndPreferences = async (studentId: string, data: any, currentUserId: string | null) => {
    const { id, applicationId, email, phone, pref1, pref2, pref3, ...documentData } = data;

    // Validate student exists and check qualification status
    const student = await prisma.student.findUnique({ 
        where: { id: studentId },
        include: {
            admissionDetails: true,
            examDetails: true
        }
    });
    
    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    // Check if student is qualified to upload documents
    // Bypass checks for Seat Booking / Offline students
    // Check if student is qualified to upload documents
    // Bypass checks for Seat Booking / Offline students
    // NOTE: Requirement changed - Allow upload even if not qualified/attended.
    /*
    if (!student.isOffline) {
        if (!student.examDetails?.examAttended) {
            throw new AppError('Cannot upload documents: Exam not attended yet', 400);
        }

        if (!student.examDetails?.isQualified) {
            throw new AppError('Cannot upload documents: Student not qualified in entrance exam', 400);
        }

        // Check admission status - must be EXAM_ATTENDED or later
        const validStatuses: AdmissionStatus[] = [
            AdmissionStatus.EXAM_ATTENDED,
            AdmissionStatus.EXAM_QUALIFIED,
            AdmissionStatus.DOCUMENTS_PENDING,
            AdmissionStatus.DOCUMENTS_SUBMITTED,
            AdmissionStatus.SEAT_ALLOTTED,
            AdmissionStatus.ADMISSION_CONFIRMED
        ];

        if (!student.admissionDetails || !validStatuses.includes(student.admissionDetails.status)) {
            throw new AppError(
                `Cannot upload documents: Current status is ${student.admissionDetails?.status || 'UNKNOWN'}. Must be EXAM_ATTENDED or later.`,
                400
            );
        }
    }
    */

    // Update Preferences
    if (pref1 || pref2 || pref3) {
        await prisma.student.update({
            where: { id: studentId },
            data: { pref1, pref2, pref3 }
        });
    }

    // Upsert Documents — tag new rows with the active academic year (NULL if none).
    const uploadYearId = await resolveActiveYearId();
    const docPromises = Object.keys(documentData).map(key => {
        // Accept keys that either end in 'Url' OR start with 'DOC_' (common pattern) OR just treating all remaining string values as potential docs
        const value = documentData[key];
        if (typeof value === 'string' && (key.endsWith('Url') || key.startsWith('DOC_'))) {
            return prisma.studentDocument.upsert({
                where: {
                    studentId_documentKey: {
                        studentId,
                        documentKey: key
                    }
                },
                update: {
                    url: documentData[key],
                    status: StudentDocumentStatus.PENDING,
                    remarks: null,
                    isDeleted: false // Reactivate if it was soft deleted
                },
                create: {
                    studentId,
                    documentKey: key,
                    url: documentData[key],
                    status: StudentDocumentStatus.PENDING,
                    academicYearId: uploadYearId,
                    isDeleted: false
                }
            });
        }
        return Promise.resolve();
    });

    await Promise.all(docPromises);

    // Update Admission Status — skip if student is already at a later stage
    const protectedStatuses: AdmissionStatus[] = [
        AdmissionStatus.SEAT_ALLOTTED,
        AdmissionStatus.ADMISSION_CONFIRMED,
        AdmissionStatus.ENROLLED
    ];
    const currentAdmissionStatus = student.admissionDetails?.status as AdmissionStatus | undefined;
    let admissionStatus = currentAdmissionStatus;

    if (!currentAdmissionStatus || !protectedStatuses.includes(currentAdmissionStatus)) {
        const admission = await prisma.studentAdmission.update({
            where: { studentId },
            data: { status: AdmissionStatus.DOCUMENTS_SUBMITTED }
        });
        admissionStatus = admission.status as AdmissionStatus;
    }

    logger.info(`Documents uploaded for student: ${studentId}`);
    return { studentId, status: admissionStatus };
};

export const reUploadDocument = async (studentId: string, documentKey: string, url: string) => {
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });

    if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

    const doc = await prisma.studentDocument.upsert({
        where: { studentId_documentKey: { studentId, documentKey } },
        update: { url, status: StudentDocumentStatus.PENDING, remarks: null, isDeleted: false },
        create: { studentId, documentKey, url, status: StudentDocumentStatus.PENDING, academicYearId: await resolveActiveYearId(), isDeleted: false }
    });

    // If rejected previously, move back to DOCUMENTS_SUBMITTED so admin can re-verify.
    // Never downgrade a student who is already at SEAT_ALLOTTED / ADMISSION_CONFIRMED / ENROLLED.
    const protectedStatuses: AdmissionStatus[] = [
        AdmissionStatus.SEAT_ALLOTTED,
        AdmissionStatus.ADMISSION_CONFIRMED,
        AdmissionStatus.ENROLLED
    ];
    const currentStatus = student.admissionDetails?.status as AdmissionStatus | undefined;
    if (currentStatus === AdmissionStatus.DOCUMENTS_PENDING) {
        await prisma.studentAdmission.update({
            where: { studentId },
            data: { status: AdmissionStatus.DOCUMENTS_SUBMITTED }
        });
    }
    // Protected statuses (SEAT_ALLOTTED, ADMISSION_CONFIRMED, ENROLLED) and all
    // other statuses are left unchanged.

    logger.info(`[reUploadDocument] student=${studentId} documentKey=${documentKey}`);
    return doc;
};

export const removeDocument = async (studentId: string, documentKey: string) => {
    const doc = await prisma.studentDocument.findUnique({
        where: {

            studentId_documentKey: {
                studentId,
                documentKey
            }
        }
    });

    if (!doc) throw new AppError(MESSAGES.ERROR.DOCUMENT_NOT_FOUND, 404);

    // Extract S3 key from URL
    const urlParts = doc.url.split('.com/');
    if (urlParts.length < 2) {
        // Just delete record if URL is invalid or local
        logger.warn(`Invalid S3 URL for document deletion: ${doc.url}`);
    } else {
        const key = urlParts[1];
        await deleteFileFromS3(key);
    }

    // Soft Delete DB record
    await prisma.studentDocument.update({
        where: { id: doc.id },
        data: { isDeleted: true }
    });

    logger.info(`Document ${documentKey} removed for student: ${studentId}`);
    return { message: 'Document deleted successfully' };
};

export const verifyDocument = async (studentId: string, documentKey: string, status: StudentDocumentStatus, remarks?: string) => {
    const existingDoc = await prisma.studentDocument.findUnique({
        where: {
            studentId_documentKey: {
                studentId,
                documentKey
            }
        }
    });

    if (!existingDoc) {
        throw new AppError(MESSAGES.ERROR.DOCUMENT_NOT_FOUND, 404);
    }

    const doc = await prisma.studentDocument.update({
        where: {
            studentId_documentKey: {
                studentId,
                documentKey
            }
        },
        data: {
            status,
            remarks
        }
    });

    logger.info(`Document ${documentKey} verified for student: ${studentId} status=${status}`);
    return doc;
};





export const addAcademicDetails = async (studentId: string, details: any[], currentUserId: string | null) => {
    // 1. Validate student exists
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            admissionDetails: true,
            examDetails: true
        }
    });

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    // 2. Check duplicate levels WITHIN the submitted payload (case-insensitive)
    const incomingLevels = details.map(d => String(d.level).trim().toLowerCase());
    const seen = new Set<string>();
    for (const lvl of incomingLevels) {
        if (seen.has(lvl)) {
            throw new AppError(`Duplicate level "${lvl}" in the submitted details. Each academic level must be unique.`, 400);
        }
        seen.add(lvl);
    }

    // 3. Check duplicate levels against EXISTING qualifications in DB (case-insensitive)
    const existingQualifications = await prisma.academicQualification.findMany({
        where: { studentId },
        select: { level: true }
    });
    const existingLevelsLower = new Set(existingQualifications.map(q => q.level.trim().toLowerCase()));
    for (const lvl of incomingLevels) {
        if (existingLevelsLower.has(lvl)) {
            throw new AppError(`Academic qualification for level "${lvl}" already exists for this student.`, 409);
        }
    }

    // Use transaction to create multiple records
    const result = await prisma.$transaction(
        details.map((detail) =>
            prisma.academicQualification.create({
                data: {
                    studentId,
                    level: detail.level,
                    board: detail.board || "",
                    yearOfPassing: detail.yearOfPassing.toString(),
                    hallTicketNumber: detail.hallTicketNumber,
                    gpaOrMarks: detail.gpaOrMarks.toString()
                }
            })
        )
    );

    logger.info(`Academic details added for student: ${studentId}`);
    return result;
};

export const getStudentByUserId = async (userId: string) => {
    const student = await prisma.student.findUnique({
        where: { userId },
        select: {
            id:true,
            name: true,
            fatherName: true,
            motherName: true,
            gender: true,
            dob: true,
            phone: true,
            email: true,
            aadharNumber: true,
            category: true,
            country: true,
            address: true,
            address2: true,
            city: true,
            state: true,
            pincode: true,
            profilePhotoUrl: true,
            isKycVerified: true,
            isOffline: true,
            userId:true,
            pref1: true,
            pref1Course: {
                select: { name: true }
            },
            pref2: true,
            pref2Course: {
                select: { name: true }
            },
            pref3: true,
            pref3Course: {
                select: { name: true }
            },
            degreeType: true,
            applicationId: true, // Generally useful
            proId: true,
            pro: true,
            examDetails: {
                select: {
                    isQualified: true,
                    examScore: true,
                    hallTicketUrl: true,
                    testDate: true,
                    testCenter: true,
                    examAttended: true
                }
            },
            admissionDetails: {
                select: {
                    id: true,
                    studentId: true,
                    status: true,
                    allottedCourseId: true,
                    allottedCourse: {
                        select: { name: true }
                    },
                    totalFee: true,
                    paidFee: true,
                    feeStatus: true,
                    accommodationType: true,
                    hostelType: true,
                    hostelId: true,
                    hostel: {
                        select: { name: true }
                    },
                    roomNumber: true,
                    transportRouteId: true,
                    transportRoute: {
                        select: { name: true }
                    },
                    createdAt: true,
                    updatedAt: true
                }
            },
            documents: {
                where: { isDeleted: false },
                select: {
                    id: true,
                    documentKey: true,
                    url: true,
                    status: true,
                    remarks: true,
                    updatedAt: true
                }
            },
            academicQualifications: {
                orderBy: { createdAt: 'asc' }
            },
            studentScholarship: true
        }
    });

    if (!student) return null;

    // Convert all document URLs to presigned URLs
    const documentsWithPresignedUrls = await Promise.all(
        student.documents.map(async (doc: any) => ({
            ...doc,
            url: await convertToPresignedUrl(doc.url)
        }))
    );

    // Convert profile photo and hall ticket URLs
    const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);
    const hallTicketUrl = await convertToPresignedUrl(student.examDetails?.hallTicketUrl);

    const ADMISSION_FLOW_ORDER: AdmissionStatus[] = [
        AdmissionStatus.REGISTERED,
        AdmissionStatus.ENTRANCE_FEE_PAID,
        AdmissionStatus.EXAM_SCHEDULED,
        AdmissionStatus.EXAM_ATTENDED,
        AdmissionStatus.EXAM_QUALIFIED,
        AdmissionStatus.DOCUMENTS_PENDING,
        AdmissionStatus.DOCUMENTS_SUBMITTED,
        AdmissionStatus.DOCUMENTS_VERIFIED,
        AdmissionStatus.SEAT_ALLOTTED,
        AdmissionStatus.ADMISSION_CONFIRMED,
        AdmissionStatus.ENROLLED
    ];

    const currentStatus = student.admissionDetails?.status;
    let completedStatuses: string[] = [];

    if (currentStatus) {
        if (currentStatus === AdmissionStatus.EXAM_NOT_QUALIFIED) {
             const attendedIndex = ADMISSION_FLOW_ORDER.indexOf(AdmissionStatus.EXAM_ATTENDED);
             if (attendedIndex !== -1) {
                 completedStatuses = [
                    ...ADMISSION_FLOW_ORDER.slice(0, attendedIndex + 1),
                    AdmissionStatus.EXAM_NOT_QUALIFIED
                 ];
             }
        } else {
            const currentIndex = ADMISSION_FLOW_ORDER.indexOf(currentStatus);
            if (currentIndex !== -1) {
                completedStatuses = ADMISSION_FLOW_ORDER.slice(0, currentIndex + 1);
            }
        }
    }

    return {
        ...student,
        pref1CourseName: student.pref1Course?.name,
        pref2CourseName: student.pref2Course?.name,
        pref3CourseName: student.pref3Course?.name,
        profilePhotoUrl,
        aadharNumber: maskAadhaar(student.aadharNumber),
        documents: documentsWithPresignedUrls,
        examDetails: student.examDetails ? {
            ...student.examDetails,
            hallTicketUrl
        } : null,
        admissionDetails: {
            ...student.admissionDetails,
            allottedCourseName: student.admissionDetails?.allottedCourse?.name,
            hostelName: student.admissionDetails?.hostel?.name,
            transportRouteName: student.admissionDetails?.transportRoute?.name,
            completedStatuses,
            currentStatus
        }
    };
};

export const searchStudents = async (query: string, page: number = 1, limit: number = 10) => {
    const skip = (page - 1) * limit;

    const where: Prisma.StudentWhereInput = {
        OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
            { phone: { contains: query, mode: 'insensitive' } },
            { applicationId: { contains: query, mode: 'insensitive' } },
            { aadharNumber: { contains: query, mode: 'insensitive' } }
        ]
    };

    const [students, total] = await prisma.$transaction([
        prisma.student.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                applicationId: true,
                name: true,
                email: true,
                phone: true,
                degreeType: true,
                createdAt: true,
                profilePhotoUrl: true,
                admissionDetails: {
                    select: {
                        status: true
                    }
                }
            }
        }),
        prisma.student.count({ where })
    ]);

    return {
        students,
        total,
        page,
        totalPages: Math.ceil(total / limit)
    };
};


export const updatePersonalDetails = async (studentId: string, data: any, currentUserId: string | null) => {
    // 1. Verify Ownership
    const student = await prisma.student.findUnique({
        where: { id: studentId }
    });

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    if (student.userId !== currentUserId) {
        throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
    }

    // 2. Filter forbidden fields (just in case validator missed something or direct call)
    const { phone, aadharNumber, phoneNumber, aadhar, applicationId, proNumber, pro, ...updateData } = data;

    // 3. Handle PRO Number mapping
    let proIdToUpdate: string | null = null;
    const finalProNum = proNumber || pro;
    if (finalProNum) {
        // Just verify it exists
        const proRecord = await prisma.pRO.findUnique({
            where: { proNumber: finalProNum }
        });
        if (!proRecord) {
            throw new AppError('Invalid PRO number provided', 400);
        }
        proIdToUpdate = proRecord.id;
    }

    // 4. Check Email Uniqueness if changing
    if (updateData.email && updateData.email !== student.email) {
        // Check Student table
        const existingStudentEmail = await prisma.student.findFirst({
            where: { 
                email: updateData.email,
                id: { not: studentId }
            }
        });
        if (existingStudentEmail) {
            throw new AppError('Email already in use by another student', 400);
        }

        // Check User table
        const existingUserEmail = await prisma.user.findFirst({
            where: { 
                email: updateData.email,
                id: { not: currentUserId || undefined } 
            }
        });
        if (existingUserEmail) {
            throw new AppError('Email already in use by another user', 400);
        }
    }

    // 5. Update
    await prisma.$transaction(async (tx) => {
        const finalUpdateData: any = { ...updateData };
        if (proIdToUpdate) {
            finalUpdateData.proId = proIdToUpdate;
        }

        await tx.student.update({
            where: { id: studentId },
            data: finalUpdateData
        });

        if (currentUserId && updateData.email && updateData.email !== student.email) {
            await tx.user.update({
                where: { id: currentUserId },
                data: { email: updateData.email }
            });
        }
    });

    return { message: 'Personal details updated successfully' };
};

export const updateProfilePhoto = async (studentId: string, newPhotoUrl: string, currentUserId: string | null) => {
    // 1. Verify Student
    const student = await prisma.student.findUnique({
        where: { id: studentId }
    });

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }
    
    // Ownership check
    if (currentUserId && student.userId !== currentUserId) {
         throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
    }

    // 2. Delete Old Photo from S3 if exists
    if (student.profilePhotoUrl) {
        const urlParts = student.profilePhotoUrl.split('.com/');
        if (urlParts.length >= 2) {
            const key = urlParts[1];
            try {
                await deleteFileFromS3(key);
                logger.info(`Deleted old profile photo for student ${studentId}: ${key}`);
            } catch (err) {
                logger.warn(`Failed to delete old profile photo from S3: ${err}`);
                // Proceed anyway to update the record
            }
        }
    }

    // 3. Update DB
    await prisma.student.update({
        where: { id: studentId },
        data: {
            profilePhotoUrl: newPhotoUrl,
            updatedAt: new Date()
        }
    });

    const presignedUrl = await convertToPresignedUrl(newPhotoUrl) || newPhotoUrl;
    return { message: 'Profile photo updated successfully', url: presignedUrl };
};

export const changeServicePreferences = async (studentId: string, data: any, currentUserId: string | null) => {
    const { type, value, reason } = data;

    // 1. Verify Student
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }
    
    // Ownership check (unless admin, but assuming this is student facing primarily)
    if (currentUserId && student.userId !== currentUserId) {
         // Add role check if needed, strictly student for now based on flow
         // If admin calls this service, pass null or handle upstream. 
         // For now, strict ownership:
         throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
    }

    if (type === 'PAYMENT_MODE') {
        // Direct Update
        if (!['SEMWISE', 'YEARWISE'].includes(value)) {
            throw new AppError('Invalid payment mode. Must be SEMWISE or YEARWISE', 400);
        }

        await prisma.studentAdmission.update({
            where: { studentId },
            data: {
                hostelPaymentMode: value,
                updatedAt: new Date()
            }
        });


        return { success: true, message: 'Payment mode updated successfully', status: 'UPDATED' };

    } else if (type === 'FACILITY') {
        // Request Based
        // Check pending requests
        const pendingRequest = await prisma.serviceChangeRequest.findFirst({
            where: {
                studentId,
                type: 'FACILITY', // Using the enum mapped string
                status: 'REQUESTED'
            }
        });

        if (pendingRequest) {
            throw new AppError('A facility change request is already pending', 409);
        }

        // Validate target value
        const targetValue = value === 'HOSTEL' ? 'HOSTEL' : (value === 'TRANSPORT' ? 'TRANSPORT' : null);
        if (!targetValue) {
             throw new AppError('Invalid facility type. Must be HOSTEL or TRANSPORT', 400);
        }
        
        // Check current value
        const currentVal = student.admissionDetails?.accommodationType || 'NONE';
        
        if (currentVal === targetValue) {
            throw new AppError(`You are already allocated to ${targetValue}`, 400);
        }

        const svcReqYear = await getActiveAcademicYear();
        await prisma.serviceChangeRequest.create({
            data: {
                studentId,
                academicYearId: svcReqYear.id,
                type: 'FACILITY',
                fromValue: currentVal,
                toValue: targetValue,
                reason,
                status: 'REQUESTED'
            }
        });

        return { success: true, message: 'Facility change request submitted successfully', status: 'REQUESTED' };

    } else {
        throw new AppError('Invalid request type', 400);
    }
};
