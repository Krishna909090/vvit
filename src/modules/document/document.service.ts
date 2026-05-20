import prisma from '../../config/prisma';
import logger from '../../utils/logger';

import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import { StudentDocumentStatus, AdmissionStatus } from '@prisma/client';
import { deleteFileFromS3, convertToPresignedUrl } from '../../utils/s3Utils';
import { getActiveAcademicYear } from '../../utils/studentContext';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import axios from 'axios';

/** Create a per-degree document requirement (e.g. "B.Tech students must upload 10th memo"). Rejects duplicates by (degreeType, documentKey). */
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

/** List requirements, optionally narrowed by degree type. Used to render the upload checklist. */
export const getDocumentRequirements = async (degreeType?: string) => {
    const where = degreeType ? { degreeType } : {};
    const requirements = await prisma.documentRequirement.findMany({
        where,
        orderBy: { createdAt: 'asc' }
    });
    logger.info(`Fetched ${requirements.length} document requirements for degreeType=${degreeType || 'ALL'}`);
    return requirements;
};

/** Update fields on a requirement row. Throws 400 if no actual change is present (avoid no-op writes). */
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

/** Soft-delete a requirement (sets isDeleted=true). Preserves history for already-uploaded student documents that referenced it. */
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

/**
 * Bulk-upsert a student's documents keyed by `documentKey`. Re-upload of an
 * existing doc resets its status to PENDING + clears prior remarks so the
 * admin re-verifies it. Bumps admission status to DOCUMENTS_SUBMITTED at end.
 * Year-tags new rows with the resolved academic year.
 */
export const upsertStudentDocuments = async (
    studentId: string,
    documentData: any,
    currentUserId: string | null,
    academicYearId?: string | null
) => {
    // Resolve a year tag once: caller-provided wins; else fall back to the active
    // academic year so new documents are year-tagged going forward.
    // academicYearId is now required on StudentDocument — error if neither resolves.
    const resolvedYearId: string = academicYearId ?? (await getActiveAcademicYear()).id;

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
                    academicYearId: resolvedYearId,
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

/** Soft-delete a specific student document + remove its S3 object. Idempotent on invalid S3 URLs (warns and continues). */
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

/** Set a student document's verification status (APPROVED / REJECTED / PENDING) with optional admin remarks. */
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

/**
 * Get every document for a student, presigned for S3 access. Pass
 * `academicYearId` to scope to a specific year, otherwise returns all years.
 * Includes profile photo + hall ticket URLs, presigned alongside.
 */
export const getStudentDocuments = async (studentId: string, academicYearId?: string) => {
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            documents: academicYearId
                ? { where: { academicYearId } }
                : true,
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

/**
 * Pull every student document (profile photo, hall ticket, uploaded docs,
 * discount-request attachment) from S3 and stream them into a single zip on
 * local /tmp. Used by the "download all" admin button. Returns the path so the
 * controller can stream it to the response then unlink.
 */
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
