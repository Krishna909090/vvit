import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import logger from '../../utils/logger';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { AdminService } from '../../services/adminService';
import { Role } from '@prisma/client';

export const getDashboardStats = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getDashboardStats] by=${req.user?.userId || 'anonymous'}`);
    
    const stats = await AdminService.getDashboardStats();

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: stats
    });
});

export const addAdmin = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[addAdmin] by=${req.user?.userId || "anonymous"}`);

    const user = await AdminService.addAdmin(req.body as {
        phone?: string;
        name?: string;
        email?: string;
        role?: Role;
    }, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ADMIN_ADDED,
        data: user,
    });
});

export const getAgentCommissions = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { agentId } = req.query;
    
    const commissions = await AdminService.getAgentCommissions(agentId as string);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.COMMISSIONS_FETCHED,
        data: commissions
    });
});

export const getUserDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getUserDetails] by=${req.user?.userId || 'anonymous'}`);
    const { phone, email } = req.query;

    const user = await AdminService.getUserDetails(phone as string, email as string);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.USER_DETAILS_FETCHED,
        data: user
    });
});

export const addInvigilator = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[addInvigilator] by=${req.user?.userId || "anonymous"}`);

    const payload = { ...req.body, role: Role.INVIGILATOR };

    const user = await AdminService.addAdmin(payload, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Invigilator added successfully',
        data: user,
    });
});
