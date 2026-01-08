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
            ContentType: contentType,
            ACL: 'public-read' // Depending on bucket settings
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

/**
 * Convert an S3 URL to a presigned URL
 * @param s3Url - Full S3 URL (e.g., https://bucket.s3.region.amazonaws.com/key)
 * @param expiresIn - Expiration time in seconds (default: 3600)
 * @returns Presigned URL
 */
export const convertToPresignedUrl = async (s3Url: string | null | undefined, expiresIn: number = 3600): Promise<string | null> => {
    if (!s3Url) return null;
    
    // If it's already a presigned URL (contains X-Amz-Algorithm), return as is
    if (s3Url.includes('X-Amz-Algorithm')) {
        return s3Url;
    }
    
    // Check if this is actually an S3 URL
    // Only process URLs that contain 'amazonaws.com' or match S3 key patterns
    const isS3Url = s3Url.includes('amazonaws.com') || s3Url.startsWith('students/');
    
    if (!isS3Url) {
        // Not an S3 URL (e.g., placeholder images, external URLs), return as-is
        logger.debug(`URL is not an S3 URL, returning as-is: ${s3Url}`);
        return s3Url;
    }
    
    try {
        // Extract key from URL
        // Format: https://bucket.s3.region.amazonaws.com/key
        const urlParts = s3Url.split('.amazonaws.com/');
        if (urlParts.length > 1) {
            const key = decodeURIComponent(urlParts[1]);
            return await getPresignedUrl(key, expiresIn);
        }
        
        // Try regex pattern for key extraction (for students/ paths)
        const keyMatch = s3Url.match(/(students?\/.*)/)
        if (keyMatch && keyMatch[1]) {
            return await getPresignedUrl(keyMatch[1], expiresIn);
        }
        
        // If it starts with students/, treat it as a key directly
        if (s3Url.startsWith('students/')) {
            return await getPresignedUrl(s3Url, expiresIn);
        }
        
        // If we can't parse it, return the original URL
        logger.warn(`Could not extract key from S3 URL: ${s3Url}, returning original`);
        return s3Url;
    } catch (error) {
        logger.error(`Error converting S3 URL to presigned URL: ${error}`);
        // Return original URL as fallback
        return s3Url;
    }
};

/**
 * Recursively transform all S3 URLs in an object to presigned URLs
 * @param obj - Object or array containing S3 URLs
 * @param expiresIn - Expiration time in seconds (default: 3600)
 * @returns Transformed object with presigned URLs
 */
export const transformS3UrlsInObject = async (obj: any, expiresIn: number = 3600): Promise<any> => {
    if (obj === null || obj === undefined) {
        return obj;
    }
    
    // Handle arrays
    if (Array.isArray(obj)) {
        return Promise.all(obj.map(item => transformS3UrlsInObject(item, expiresIn)));
    }
    
    // Handle objects
    if (typeof obj === 'object') {
        const transformed: any = {};
        
        for (const [key, value] of Object.entries(obj)) {
            // Check if the key suggests it's a URL field
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
    
    // Return primitive values as is
    return obj;
};
