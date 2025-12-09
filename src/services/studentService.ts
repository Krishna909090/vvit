import prisma from '../config/prisma';
import {
    AdmissionStatus,
    StudentDocumentStatus,
    Prisma
} from '@prisma/client';
import logger from '../utils/logger';
import { AppError } from '../utils/AppError';
import { verifyAadhar } from './integrationService';
import { deleteFileFromS3 } from '../utils/s3Utils';
import { MESSAGES } from '../constants/messages';
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

    const prefix = data.isOffline ? 'VOF' : 'VON';

    // Find the last student with the same offline status to determine the next ID
    const lastStudent = await prisma.student.findFirst({
        where: {
            isOffline: data.isOffline || false,
            applicationId: { startsWith: prefix }
        },
        orderBy: { createdAt: 'desc' }
    });

    let nextIdNumber = 1;
    if (lastStudent && lastStudent.applicationId) {
        const lastIdPart = lastStudent.applicationId.replace(prefix, '');
        const lastNumber = parseInt(lastIdPart, 10);
        if (!isNaN(lastNumber)) {
            nextIdNumber = lastNumber + 1;
        }
    }

    const applicationId = `${prefix}${nextIdNumber}`;

    // Transaction to create Student and related tables
    const student = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
                isOffline: data.isOffline || false,
                courseType: data.courseType,
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
            courseType: true,
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
        include: { admissionDetails: true, examDetails: true }
    });

    if (!student || !student.admissionDetails || !student.examDetails) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    const status = student.admissionDetails.status;

    if (status !== AdmissionStatus.HALL_TICKET_GENERATED &&
        status !== AdmissionStatus.EXAM_ATTENDED &&
        status !== AdmissionStatus.DOCUMENTS_UPLOADED &&
        status !== AdmissionStatus.SEAT_ALLOTTED &&
        status !== AdmissionStatus.ADMISSION_CONFIRMED
    ) {
        throw new AppError(MESSAGES.ERROR.HALL_TICKET_NOT_GENERATED, 400);
    }

    logger.info(`Hall ticket retrieved for student: ${studentId}`);
    return student.examDetails.hallTicketUrl;
};

export const uploadDocumentsAndPreferences = async (studentId: string, data: any, currentUserId: string | null) => {
    const { id, applicationId, email, phone, pref1, pref2, pref3, ...documentData } = data;

    const studentExists = await prisma.student.findUnique({ where: { id: studentId } });
    if (!studentExists) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
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
        if (key.endsWith('Url')) {
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
        data: { status: AdmissionStatus.DOCUMENTS_UPLOADED }
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
    // Validate student exists
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    // Use transaction to create multiple records
    const result = await prisma.$transaction(
        details.map((detail) =>
            prisma.academicQualification.create({
                data: {
                    studentId,
                    level: detail.level,
                    board: detail.board,
                    yearOfPassing: detail.yearOfPassing,
                    hallTicketNumber: detail.hallTicketNumber,
                    gpaOrMarks: detail.gpaOrMarks,
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
            pref2: true,
            pref3: true,
            courseType: true,
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
            admissionDetails: true
        }
    });

    return student;
};
