import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import * as ExamService from '../../services/examService';
import fs from 'fs';

export const markAttendance = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[markAttendance] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[markAttendance] payload=${JSON.stringify(req.body)}`);

    const { studentId, attended } = req.body;
    
    await ExamService.markAttendanceManually(studentId, attended, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ATTENDANCE_MARKED
    });
});

export const updateExamScore = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateExamScore] by=${req.user?.userId || 'anonymous'}`);
    
    const { studentId, score, cutoff } = req.body;
    
    const result = await ExamService.updateStudentExamScore(studentId, score, cutoff, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.EXAM_SCORE_UPDATED,
        data: result
    });
});

export const generateInvigilatorCredentials = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[generateInvigilatorCredentials] by=${req.user?.userId || 'anonymous'}`);
    
    const { count, validFrom, validUntil } = req.body;
    if (!count || !validFrom || !validUntil) {
        throw new AppError(MESSAGES.ERROR.COUNT_VALID_FROM_UNTIL_REQUIRED, 400);
    }
    
    // Using service method which expects an object with validFrom, validUntil, count
    const result = await ExamService.generateInvigilatorCredentials(req.user?.userId || 'system', req.body);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.CREDENTIALS_GENERATED,
        data: result.tokens // Mapping to match previous response structure if needed, or just return result
    });
});

export const uploadBulkResults = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) throw new AppError(MESSAGES.ERROR.NO_FILE_UPLOADED, 400);
    const { cutoff } = req.body;
    if (!cutoff) throw new AppError(MESSAGES.ERROR.CUTOFF_REQUIRED, 400);

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    
    try {
        const results = await ExamService.processBulkResults(fileContent, cutoff);
        
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.BULK_RESULTS_PROCESSED,
            data: results
        });
    } finally {
        fs.unlinkSync(req.file.path);
    }
});
