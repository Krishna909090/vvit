import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "../../config/awsConfig";
import { convertToPresignedUrl } from '../../utils/s3Utils';
import prisma from '../../config/prisma';
import { Role } from '../../constants/roles';

export interface UploadResult {
    url: string;
    key: string;
    filename: string;
    presignedUrl?: string;
}

export const uploadFileToS3 = async (
    file: Express.Multer.File,
    _folder: string = 'documents'
): Promise<UploadResult> => {

    const s3File = file as any;

    if (!s3File.location || !s3File.key) {
        throw new AppError('File upload to S3 failed (missing location/key)', 500);
    }

    logger.info(`File uploaded to S3: ${s3File.key}`);

    let presignedUrl: string | undefined;
    try {
        presignedUrl = await convertToPresignedUrl(s3File.location) || undefined;
    } catch (err) {
        logger.warn(`Failed to generate presigned URL for uploaded file: ${err}`);
    }

    return {
        url: s3File.location,
        key: s3File.key,
        filename: file.originalname,
        presignedUrl
    };
};

export const uploadMultipleFilesToS3 = async (
    files: Express.Multer.File[],
    folder: string = 'documents'
): Promise<UploadResult[]> => {
    const uploadPromises = files.map(file => uploadFileToS3(file, folder));
    const results = await Promise.all(uploadPromises);
    logger.info(`Uploaded ${results.length} files to S3`);
    return results;
};

export const generatePresignedUrl = async (
    fileUrl: string,
    callerRole?: string,
    callerUserId?: string,
) => {
    let key = '';
    try {
        const urlObj = new URL(fileUrl);

        key = decodeURIComponent(urlObj.pathname.substring(1));
    } catch (e) {
        throw new AppError('Invalid URL format', 400);
    }

    if (!key) throw new AppError('Could not extract key from URL', 400);

    const isAdminRole = callerRole && callerRole !== Role.STUDENT;

    if (!isAdminRole && callerUserId) {

        const student = await prisma.student.findFirst({
            where: { userId: callerUserId },
            select: { id: true },
        });

        const studentId = student?.id;

        if (studentId) {

            const keyBelongsToStudent = key.startsWith(`students/${studentId}/`) || key.includes(`/${studentId}/`);

            const docMatch = !keyBelongsToStudent
                ? await prisma.studentDocument.findFirst({
                    where: { studentId, url: { contains: key } },
                    select: { id: true },
                })
                : null;

            const paymentMatch = !keyBelongsToStudent && !docMatch
                ? await prisma.payment.findFirst({
                    where: { studentId, invoiceUrl: { contains: key } },
                    select: { id: true },
                })
                : null;

            if (!keyBelongsToStudent && !docMatch && !paymentMatch) {
                logger.warn(`[generatePresignedUrl] Access denied: user ${callerUserId} (student ${studentId}) requested key "${key}" which does not belong to them.`);
                throw new AppError('Access denied to this resource', 403);
            }
        }
    }

    const bucketName = process.env.AWS_BUCKET_NAME || '';

    const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key
    });

    try {
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        return { presignedUrl: url };
    } catch (error) {
        logger.error(`Error generating presigned URL: ${error}`);
        throw new AppError('Failed to generate access URL', 500);
    }
};
