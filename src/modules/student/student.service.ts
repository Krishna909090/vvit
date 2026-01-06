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
export const registerStudent = async (data: any, agentId: string | null, userId: string | null, currentUserId: string | null) => {
    // Check for duplicate registration
    const dobDate = data.dob ? new Date(data.dob) : undefined;

    const orConditions: any[] = [
        { email: data.email },
        { aadharNumber: data.aadharNumber }
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
        throw new AppError(MESSAGES.ERROR.STUDENT_ALREADY_REGISTERED, 400);
    }

    if (data.aadharNumber) {
        const isValidAadhar = await verifyAadhar(data.aadharNumber);
        if (!isValidAadhar) {
            throw new AppError(MESSAGES.ERROR.INVALID_AADHAR, 400);
        }
    }

    const isOffline = data.isOffline || data.applicationMode === 'SEAT_BOOKING' || data.applicationMode === 'OFFLINE';
    
    // Determine prefix based on application mode
    // Seat Booking and Online -> VON
    // Offline -> VOF
    let prefix = 'VON';
    if (data.applicationMode === 'OFFLINE' || (data.isOffline && data.applicationMode !== 'SEAT_BOOKING')) {
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

    // Transaction to create Student and related tables
    const student = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
                agentId,
                isOffline: data.isOffline || data.applicationMode === 'SEAT_BOOKING' || data.applicationMode === 'OFFLINE' || false,
                degreeType: data.degreeType,
                applicationMode: data.applicationMode,
                quotaType: data.quotaType,
                pref1: data.pref1,
                pref2: data.pref2,
                pref3: data.pref3,
                userId: userId,
                isKycVerified: data.isKycVerified,
                createdBy: currentUserId,
                updatedBy: currentUserId
            }
        });

        // Create Admission Details
        await tx.studentAdmission.create({
            data: {
                studentId: newStudent.id,
                status: AdmissionStatus.REGISTERED
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
            applicationId: true // Needed for logger and likely client
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

    // Update Preferences
    if (pref1 || pref2 || pref3) {
        await prisma.student.update({
            where: { id: studentId },
            data: { pref1, pref2, pref3, updatedBy: currentUserId }
        });
    }

    // Upsert Documents
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
                    updatedBy: currentUserId,
                    isDeleted: false // Reactivate if it was soft deleted
                },
                create: {
                    studentId,
                    documentKey: key,
                    url: documentData[key],
                    status: StudentDocumentStatus.PENDING,
                    createdBy: currentUserId,
                    updatedBy: currentUserId,
                    isDeleted: false
                }
            });
        }
        return Promise.resolve();
    });

    await Promise.all(docPromises);

    // Update Admission Status
    const admission = await prisma.studentAdmission.update({
        where: { studentId },
        data: { status: AdmissionStatus.DOCUMENTS_SUBMITTED }
    });

    logger.info(`Documents uploaded for student: ${studentId}`);
    return { studentId, status: admission.status };
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
    // Validate student exists and check admission status
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

    // Requirement Update: Allow adding academic details at any stage (Online/Offline/SeatBooking)
    // Exam attendance/qualification checks removed.

    // Use transaction to create multiple records
    const result = await prisma.$transaction(
        details.map((detail) =>
            prisma.academicQualification.create({
                data: {
                    studentId,
                    level: detail.level,
                    board: detail.board,
                    yearOfPassing: detail.yearOfPassing.toString(),
                    hallTicketNumber: detail.hallTicketNumber,
                    gpaOrMarks: detail.gpaOrMarks.toString(),
                    createdBy: currentUserId,
                    updatedBy: currentUserId
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
                    qualificationMode: true,
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
            academicQualifications: true
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
    const { phone, aadharNumber, phoneNumber, aadhar, applicationId, ...updateData } = data;

    // 3. Check Email Uniqueness if changing
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

    // 4. Update
    await prisma.$transaction(async (tx) => {
        await tx.student.update({
            where: { id: studentId },
            data: {
                ...updateData,
                updatedBy: currentUserId
            }
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
