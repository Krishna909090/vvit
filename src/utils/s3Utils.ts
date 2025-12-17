import { s3Client } from '../config/awsConfig';
import { DeleteObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import logger from '../utils/logger';
import { AppError } from './AppError';

const BUCKET_NAME = process.env.AWS_BUCKET_NAME || 'vvitu-uploads';

export const uploadFileToS3 = async (
    fileContent: Buffer | string,
    key: string,
    contentType: string = 'application/pdf'
): Promise<string> => {
    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: fileContent,
            ContentType: contentType,
            // ACL: 'public-read' // Depending on bucket settings
        });

        await s3Client.send(command);
        
        // Construct the URL. Assuming standard region-based URL structure.
        // Or if using CloudFront, that would differ.
        const region = process.env.AWS_REGION || 'ap-south-1';
        const url = `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
        
        logger.info(`File uploaded to S3: ${key}`);
        return url;
    } catch (error) {
        logger.error(`Error uploading file to S3: ${error}`);
        throw new AppError('Failed to upload file to S3', 500);
    }
};

export const deleteFileFromS3 = async (key: string): Promise<void> => {
    try {
        const command = new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        await s3Client.send(command);
        logger.info(`File deleted from S3: ${key}`);
    } catch (error) {
        logger.error(`Error deleting file from S3: ${error}`);
        throw new AppError('Failed to delete file from S3', 500);
    }
};

export const getPresignedUrl = async (key: string, expiresIn: number = 3600): Promise<string> => {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        
        const url = await getSignedUrl(s3Client, command, { expiresIn });
        logger.info(`Generated presigned URL for key: ${key}`);
        return url;
    } catch (error) {
        logger.error(`Error generating presigned URL: ${error}`);
        throw new AppError('Failed to generate presigned URL', 500);
    }
};
