import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3Client } from "../../config/awsConfig";

export interface UploadResult {
    url: string;
    key: string;
    filename: string;
    presignedUrl?: string;
}


export const uploadFileToS3 = async (
    file: Express.Multer.File,
    folder: string = 'documents'
): Promise<UploadResult> => {
    // Since we are using multer-s3, the file is already uploaded to S3
    // and the file object contains the location (url) and key.
    const s3File = file as any; // multer-s3 adds 'location' and 'key' to file object

    if (!s3File.location || !s3File.key) {
        throw new AppError('File upload to S3 failed (missing location/key)', 500);
    }

    logger.info(`File uploaded to S3: ${s3File.key}`);

    // Generate presigned URL for immediate use
    let presignedUrl: string | undefined;
    try {
        const command = new GetObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME!,
            Key: s3File.key,
        });
        presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
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

export const generatePresignedUrl = async (fileUrl: string) => {
    let key = '';
    try {
        const urlObj = new URL(fileUrl);
        // Extracts the pathname without the leading slash. works for both path-style and virtual-hosted style if key is in path.
        // decoding to handle spaces/special chars
        key = decodeURIComponent(urlObj.pathname.substring(1));
    } catch (e) {
        throw new AppError('Invalid URL format', 400);
    }

    if (!key) throw new AppError('Could not extract key from URL', 400);

    const bucketName = process.env.AWS_BUCKET_NAME || '';
    
    // Create the command
    const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key
    });

    try {
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 }); // 1 hour expiration
        return { presignedUrl: url };
    } catch (error) {
        logger.error(`Error generating presigned URL: ${error}`);
        throw new AppError('Failed to generate access URL', 500);
    }
};
