import { Request, Response, NextFunction } from 'express';
import { uploadFileToS3, uploadMultipleFilesToS3, generatePresignedUrl } from './upload.service';
import logger from '../../utils/logger';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { sendResponse } from '../../utils/response';
import { MESSAGES } from '../../constants/messages';

export const uploadSingleFile = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[uploadSingleFile] by=${req.user?.userId || 'anonymous'}`);
    logger.debug(`[uploadSingleFile] file=${req.file?.originalname || 'n/a'} query=${JSON.stringify(req.query)}`);

    if (!req.file) {
        logger.warn('[uploadSingleFile] no file uploaded');
        throw new AppError(MESSAGES.ERROR.NO_FILE_UPLOADED, 400);
    }

    const folder = (req.query.folder as string) || 'documents';
    const result = await uploadFileToS3(req.file, folder);

    logger.info(`File uploaded successfully: ${result.key}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.FILE_UPLOADED,
        data: result
    });
});

export const uploadMultipleFiles = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[uploadMultipleFiles] by=${req.user?.userId || 'anonymous'}`);
    logger.debug(`[uploadMultipleFiles] files=${Array.isArray(req.files) ? (req.files as any[]).length : 0} query=${JSON.stringify(req.query)}`);

    if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        logger.warn('[uploadMultipleFiles] no files uploaded');
        throw new AppError(MESSAGES.ERROR.NO_FILES_UPLOADED, 400);
    }

    const folder = (req.query.folder as string) || 'documents';
    const results = await uploadMultipleFilesToS3(req.files as Express.Multer.File[], folder);

    logger.info(`${results.length} files uploaded successfully`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.FILES_UPLOADED,
        data: results
    });
});

export const getPresignedUrl = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { url } = req.body;
    
    if (!url) {
        throw new AppError("URL is required", 400);
    }

    const result = await generatePresignedUrl(url, req.user?.role, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Presigned URL generated successfully",
        data: result
    });
});
