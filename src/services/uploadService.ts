import { AppError } from '../utils/AppError';
import logger from '../utils/logger';

export interface UploadResult {
    url: string;
    key: string;
    filename: string;
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
    return {
        url: s3File.location,
        key: s3File.key,
        filename: file.originalname
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
