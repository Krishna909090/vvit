import prisma from '../../config/prisma';
import logger from '../../utils/logger';

import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import { StudentDocumentStatus, AdmissionStatus } from '@prisma/client';
import { deleteFileFromS3, convertToPresignedUrl } from '../../utils/s3Utils';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import axios from 'axios';

export const createDocumentRequirement = async (data: any) => {
    const existingRequirement = await prisma.documentRequirement.findFirst({
        where: {
            degreeType: data.degreeType,
            documentKey: data.documentKey
        }
    });

    if (existingRequirement) {
        throw new AppError(MESSAGES.ERROR.DOCUMENT_REQUIREMENT_EXISTS || 'Document requirement already exists for this course', 409);
    }

    const requirement = await prisma.documentRequirement.create({
        data: {
            degreeType: data.degreeType,
            documentName: data.documentName,
            documentKey: data.documentKey,
            isRequired: data.isRequired
        }
    });
    logger.info(`Document requirement created: ${requirement.id}`);
    return requirement;
};

export const getDocumentRequirements = async (degreeType?: string) => {
    const where = degreeType ? { degreeType } : {};
    const requirements = await prisma.documentRequirement.findMany({
        where,
        orderBy: { createdAt: 'asc' }
    });
    logger.info(`Fetched ${requirements.length} document requirements for degreeType=${degreeType || 'ALL'}`);
    return requirements;
};

export const updateDocumentRequirement = async (id: string, data: any) => {
    const existing = await prisma.documentRequirement.findUnique({ where: { id } });
    if (!existing) {
        throw new AppError(MESSAGES.ERROR.REQUIREMENT_NOT_FOUND, 404);
    }

    // Check if there are actual changes
    const hasChanges = Object.keys(data).some(key => {
        return data[key] !== undefined && existing[key as keyof typeof existing] !== data[key];
    });

    if (!hasChanges) {
        throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
    }

    const requirement = await prisma.documentRequirement.update({
        where: { id },
        data
    });
    logger.info(`Document requirement updated: ${id}`);
    return requirement;
};

export const deleteDocumentRequirement = async (id: string) => {
    const existing = await prisma.documentRequirement.findUnique({ where: { id } });
    if (!existing) {
        throw new AppError(MESSAGES.ERROR.REQUIREMENT_NOT_FOUND, 404);
    }

    await prisma.documentRequirement.update({
        where: { id },
        data: { isDeleted: true }
    });
    logger.info(`Document requirement deleted: ${id}`);
    return { message: 'Requirement deleted' };
};

export const upsertStudentDocuments = async (studentId: string, documentData: any, currentUserId: string | null) => {
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
                    isDeleted: false
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

export const deleteStudentDocument = async (studentId: string, documentKey: string) => {
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
        logger.warn(`Invalid S3 URL for document deletion: ${doc.url}`);
    } else {
        const key = urlParts[1];
        await deleteFileFromS3(key);
    }

    // Soft Delete
    await prisma.studentDocument.update({
        where: { id: doc.id },
        data: { isDeleted: true }
    });

    logger.info(`Document ${documentKey} removed for student: ${studentId}`);
    return { message: 'Document deleted successfully' };
};

export const verifyStudentDocument = async (studentId: string, documentKey: string, status: StudentDocumentStatus, remarks?: string) => {
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

export const getStudentDocuments = async (studentId: string) => {
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            documents: true,
            examDetails: true
        }
    });

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    // Convert all document URLs to presigned URLs
    const documentMapPromises = student.documents.map(async (doc: any) => {
        const presignedUrl = await convertToPresignedUrl(doc.url);
        return { key: doc.documentKey, url: presignedUrl };
    });

    const documentMapArray = await Promise.all(documentMapPromises);
    const documentMap = documentMapArray.reduce((acc: any, item) => {
        acc[item.key] = item.url;
        return acc;
    }, {});

    // Convert profile photo and hall ticket URLs
    const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);
    const hallTicketUrl = await convertToPresignedUrl(student.examDetails?.hallTicketUrl);

    return {
        ...student,
        profilePhotoUrl,
        examDetails: student.examDetails ? {
            ...student.examDetails,
            hallTicketUrl
        } : null,
        documentMap
    };
};

export const createStudentDocumentZip = async (studentId: string) => {
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            documents: true,
            examDetails: true
        }
    });

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    const documents = [
        { name: 'profile_photo', url: student.profilePhotoUrl },
        { name: 'hall_ticket', url: student.examDetails?.hallTicketUrl },
        ...student.documents.map((doc: any) => ({ name: doc.documentKey, url: doc.url })),
    ];
    
    // Add discount doc
     const discountReq = await prisma.discountRequest.findFirst({ where: { studentId } });
     if (discountReq?.documentUrl) {
         documents.push({ name: 'discount_doc', url: discountReq.documentUrl });
     }

    const validDocuments = documents.filter(doc => doc.url);

    if (validDocuments.length === 0) {
        throw new AppError(MESSAGES.ERROR.NO_DOCUMENTS_FOUND, 400);
    }

    const zipFileName = `${student.applicationId}_documents.zip`;
    // Use /tmp for lambda/cloud compatibility if needed, but sticking to local structure for now
    const tempDir = path.join(__dirname, '../../../temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    const zipFilePath = path.join(tempDir, zipFileName);

    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    return new Promise<{ filePath: string, fileName: string }>((resolve, reject) => {
        output.on('close', () => {
            resolve({ filePath: zipFilePath, fileName: zipFileName });
        });

        archive.on('error', (err: any) => {
            reject(err);
        });

        archive.pipe(output);

        (async () => {
            for (const doc of validDocuments) {
                if (doc.url) {
                    try {
                        const response = await axios.get(doc.url, { responseType: 'stream' });
                        const ext = path.extname(doc.url) || '.pdf';
                        archive.append(response.data, { name: `${doc.name}${ext}` });
                    } catch (err: any) {
                        logger.error(`Failed to download ${doc.name} from ${doc.url}`);
                    }
                }
            }
            await archive.finalize();
        })();
    });
};
