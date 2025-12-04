import { s3Client } from '../config/awsConfig';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import logger from '../utils/logger';
import { AppError } from './AppError';

export const deleteFileFromS3 = async (key: string): Promise<void> => {
    try {
        const command = new DeleteObjectCommand({
            Bucket: 'vvitu-uploads',
            Key: key
        });
        await s3Client.send(command);
        logger.info(`File deleted from S3: ${key}`);
    } catch (error) {
        logger.error(`Error deleting file from S3: ${error}`);
        throw new AppError('Failed to delete file from S3', 500);
    }
};
