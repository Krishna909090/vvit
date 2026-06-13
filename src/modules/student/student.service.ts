import prisma from '../../config/prisma';
import { resolveInstitutionCodeId } from '../../utils/institutionCodeCache';
import QRCode from 'qrcode';
import {
    AdmissionStatus,
    StudentDocumentStatus,
    Prisma
} from '@prisma/client';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { verifyAadhar } from '../integration/integration.service';
import { deleteFileFromS3, convertToPresignedUrl } from '../../utils/s3Utils';
import { MESSAGES } from '../../constants/messages';
import { formatDate, formatTime } from '../../utils/dateFormatter';
import { maskAadhaar } from '../../utils/mask';
import { getActiveAcademicYear } from '../../utils/studentContext';

const resolveActiveYearId = async (): Promise<string> => {
    return (await getActiveAcademicYear()).id;
};

export const registerStudent = async (data: any, userId: string | null, _currentUserId: string | null) => {

    const dobDate = data.dob ? new Date(data.dob) : undefined;

    if (data.aadharNumber) {
        const isValidAadhar = await verifyAadhar(data.aadharNumber);
        if (!isValidAadhar) {
            throw new AppError(MESSAGES.ERROR.INVALID_AADHAR, 400);
        }

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

        data.aadharNumber = maskAadhaar(data.aadharNumber);
    }

    const orConditions: any[] = [
        { email: data.email }

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

    let prefix = 'VON';
    if (data.entryType === 'LATERAL') {
        prefix = 'VLE';
    } else if (data.applicationMode === 'OFFLINE' || (data.isOffline && data.applicationMode !== 'SEAT_BOOKING')) {
        prefix = 'VOF';
    }

    let applicationId = '';
    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {

        const lastStudent = await prisma.student.findFirst({
            where: {
                applicationId: { startsWith: prefix }
            },
            orderBy: { createdAt: 'desc' }

        });

        let nextIdNumber = 2600001;
        if (lastStudent && lastStudent.applicationId) {
            const lastIdPart = lastStudent.applicationId.replace(prefix, '');
            const lastNumber = parseInt(lastIdPart, 10);
            if (!isNaN(lastNumber)) {
                nextIdNumber = lastNumber + 1;

                if (nextIdNumber < 2600001) {
                    nextIdNumber = 2600001;
                }
            }
        }

        applicationId = `${prefix}${nextIdNumber}`;

        const existingWithId = await prisma.student.findUnique({
            where: { applicationId }
        });

        if (!existingWithId) {

            break;
        }

        attempts++;
        logger.warn(`[registerStudent] ApplicationId ${applicationId} already exists, retrying... (attempt ${attempts}/${maxAttempts})`);
        
        if (attempts >= maxAttempts) {
            throw new AppError('Failed to generate unique application ID after multiple attempts. Please try again.', 500);
        }
    }

    logger.info(`[registerStudent] Generated applicationId: ${applicationId}`);

    const activeAcademicYear = await prisma.academicYear.findFirst({
        where: { isActive: true, isDeleted: false }
    });
    if (!activeAcademicYear) {
        throw new AppError('No active academic year is set. Configure one before registering students.', 400);
    }

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

    const student = await prisma.$transaction(async (tx) => {

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

        const entryType        = data.entryType ?? 'REGULAR';
        const entryYearOfStudy = data.entryYearOfStudy
            ?? (entryType === 'LATERAL' ? 2 : entryType === 'TRANSFER' ? 3 : 1);
        const entryAcademicYearId = activeAcademicYear.id;
        const feeCohortAcademicYearId = entryAcademicYearId;

        let batchAcademicYearId = activeAcademicYear.id;
        if (entryYearOfStudy > 1) {
            const years = await tx.academicYear.findMany({
                where: { isDeleted: false },
                orderBy: { startDate: 'asc' },
                select: { id: true },
            });
            const idx = years.findIndex((y: { id: string }) => y.id === activeAcademicYear.id);
            const batchIdx = idx - (entryYearOfStudy - 1);
            if (idx >= 0 && batchIdx >= 0) batchAcademicYearId = years[batchIdx].id;
        }

        const instituteCode = data.instituteCode ?? 'MGMT';

        await tx.studentAdmission.create({
            data: {
                studentId: newStudent.id,
                status: AdmissionStatus.REGISTERED,
                academicYearId: activeAcademicYear.id,
                entryType: entryType as any,
                entryYearOfStudy,
                entryAcademicYearId,
                feeCohortAcademicYearId,
                batchAcademicYearId,
                instituteCode,
                institutionCodeId: await resolveInstitutionCodeId(instituteCode),
            }
        });

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
            applicationId: true,
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

export const uploadDocumentsAndPreferences = async (studentId: string, data: any, _currentUserId: string | null) => {
    const { id, applicationId, email, phone, pref1, pref2, pref3, ...documentData } = data;

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

    if (pref1 || pref2 || pref3) {
        await prisma.student.update({
            where: { id: studentId },
            data: { pref1, pref2, pref3 }
        });
    }

    const uploadYearId = await resolveActiveYearId();
    const docPromises = Object.keys(documentData).map(key => {

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
                    isDeleted: false
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

    const currentStatus = student.admissionDetails?.status as AdmissionStatus | undefined;
    if (currentStatus === AdmissionStatus.DOCUMENTS_PENDING) {
        await prisma.studentAdmission.update({
            where: { studentId },
            data: { status: AdmissionStatus.DOCUMENTS_SUBMITTED }
        });
    }

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

    const urlParts = doc.url.split('.com/');
    if (urlParts.length < 2) {

        logger.warn(`Invalid S3 URL for document deletion: ${doc.url}`);
    } else {
        const key = urlParts[1];
        await deleteFileFromS3(key);
    }

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

export const addAcademicDetails = async (studentId: string, details: any[], _currentUserId: string | null) => {

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

    const incomingLevels = details.map(d => String(d.level).trim().toLowerCase());
    const seen = new Set<string>();
    for (const lvl of incomingLevels) {
        if (seen.has(lvl)) {
            throw new AppError(`Duplicate level "${lvl}" in the submitted details. Each academic level must be unique.`, 400);
        }
        seen.add(lvl);
    }

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
            applicationId: true,
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
                    entryType: true,
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

    const documentsWithPresignedUrls = await Promise.all(
        student.documents.map(async (doc: any) => ({
            ...doc,
            url: await convertToPresignedUrl(doc.url)
        }))
    );

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

    const student = await prisma.student.findUnique({
        where: { id: studentId }
    });

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    if (student.userId !== currentUserId) {
        throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
    }

    const { phone, aadharNumber, phoneNumber, aadhar, applicationId, proNumber, pro, ...updateData } = data;

    let proIdToUpdate: string | null = null;
    const finalProNum = proNumber || pro;
    if (finalProNum) {

        const proRecord = await prisma.pRO.findUnique({
            where: { proNumber: finalProNum }
        });
        if (!proRecord) {
            throw new AppError('Invalid PRO number provided', 400);
        }
        proIdToUpdate = proRecord.id;
    }

    if (updateData.email && updateData.email !== student.email) {

        const existingStudentEmail = await prisma.student.findFirst({
            where: { 
                email: updateData.email,
                id: { not: studentId }
            }
        });
        if (existingStudentEmail) {
            throw new AppError('Email already in use by another student', 400);
        }

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

    const student = await prisma.student.findUnique({
        where: { id: studentId }
    });

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    if (currentUserId && student.userId !== currentUserId) {
         throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
    }

    if (student.profilePhotoUrl) {
        const urlParts = student.profilePhotoUrl.split('.com/');
        if (urlParts.length >= 2) {
            const key = urlParts[1];
            try {
                await deleteFileFromS3(key);
                logger.info(`Deleted old profile photo for student ${studentId}: ${key}`);
            } catch (err) {
                logger.warn(`Failed to delete old profile photo from S3: ${err}`);

            }
        }
    }

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

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    if (currentUserId && student.userId !== currentUserId) {

         throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
    }

    if (type === 'PAYMENT_MODE') {

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

        const pendingRequest = await prisma.serviceChangeRequest.findFirst({
            where: {
                studentId,
                type: 'FACILITY',
                status: 'REQUESTED'
            }
        });

        if (pendingRequest) {
            throw new AppError('A facility change request is already pending', 409);
        }

        const targetValue = value === 'HOSTEL' ? 'HOSTEL' : (value === 'TRANSPORT' ? 'TRANSPORT' : null);
        if (!targetValue) {
             throw new AppError('Invalid facility type. Must be HOSTEL or TRANSPORT', 400);
        }

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
