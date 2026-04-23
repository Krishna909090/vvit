import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { sendResponse } from '../../utils/response';
import logger from '../../utils/logger';
import { getMyProProfile, getMyProStudents, getMyProCommissionSummary } from './pro.service';

export const getMyProfile = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.userId) throw new AppError('Unauthorized', 401);
    logger.info(`[PRO.getMyProfile] by=${req.user.userId}`);
    const pro = await getMyProProfile(req.user.userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'PRO profile fetched', data: pro });
});

export const getMyStudents = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.userId) throw new AppError('Unauthorized', 401);
    logger.info(`[PRO.getMyStudents] by=${req.user.userId}, query=${JSON.stringify(req.query)}`);
    const result = await getMyProStudents(req.user.userId, req.query);
    sendResponse({ res, statusCode: 200, success: true, message: 'Students fetched', data: result });
});

export const getMyCommissionSummary = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.userId) throw new AppError('Unauthorized', 401);
    logger.info(`[PRO.getMyCommissionSummary] by=${req.user.userId}`);
    const summary = await getMyProCommissionSummary(req.user.userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Commission summary fetched', data: summary });
});
