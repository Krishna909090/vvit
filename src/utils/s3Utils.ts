import { s3Client } from '../config/awsConfig';
import { DeleteObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import logger from '../utils/logger';
import { AppError } from './AppError';

const BUCKET_NAME = process.env.AWS_BUCKET_NAME || '';

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
            ContentType: contentType
        });

        await s3Client.send(command);

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

export const downloadFileFromS3 = async (key: string): Promise<Buffer> => {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        const response = await s3Client.send(command);
        const byteArray = await response.Body!.transformToByteArray();
        return Buffer.from(byteArray);
    } catch (error) {
        logger.error(`Error downloading file from S3: ${error}`);
        throw new AppError('Failed to download file from S3', 500);
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

export const convertToPresignedUrl = async (s3Url: string | null | undefined, expiresIn: number = 3600): Promise<string | null> => {
    if (!s3Url) return null;

    if (s3Url.includes('X-Amz-Algorithm')) {
        return s3Url;
    }

    const isS3Url = s3Url.includes('amazonaws.com') || s3Url.startsWith('students/');
    
    if (!isS3Url) {

        logger.debug(`URL is not an S3 URL, returning as-is: ${s3Url}`);
        return s3Url;
    }
    
    try {

        const urlParts = s3Url.split('.amazonaws.com/');
        if (urlParts.length > 1) {
            const key = decodeURIComponent(urlParts[1]);
            return await getPresignedUrl(key, expiresIn);
        }

        const keyMatch = s3Url.match(/(students?\/.*)/)
        if (keyMatch && keyMatch[1]) {
            return await getPresignedUrl(keyMatch[1], expiresIn);
        }

        if (s3Url.startsWith('students/')) {
            return await getPresignedUrl(s3Url, expiresIn);
        }

        logger.warn(`Could not extract key from S3 URL: ${s3Url}, returning original`);
        return s3Url;
    } catch (error) {
        logger.error(`Error converting S3 URL to presigned URL: ${error}`);

        return s3Url;
    }
};

export const transformS3UrlsInObject = async (obj: any, expiresIn: number = 3600): Promise<any> => {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (Array.isArray(obj)) {
        return Promise.all(obj.map(item => transformS3UrlsInObject(item, expiresIn)));
    }

    if (typeof obj === 'object') {
        const transformed: any = {};
        
        for (const [key, value] of Object.entries(obj)) {

            const isUrlField = key.toLowerCase().includes('url') || 
                              key.toLowerCase().includes('photo') ||
                              key === 'location';
            
            if (isUrlField && typeof value === 'string' && value.includes('amazonaws.com')) {
                transformed[key] = await convertToPresignedUrl(value, expiresIn);
            } else if (typeof value === 'object') {
                transformed[key] = await transformS3UrlsInObject(value, expiresIn);
            } else {
                transformed[key] = value;
            }
        }
        
        return transformed;
    }

    return obj;
};
