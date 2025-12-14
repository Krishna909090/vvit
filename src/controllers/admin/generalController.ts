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

/**
 * Get all staff users (excluding students)
 * Returns users with roles: SUPER_ADMIN, ADMIN, AGENT, INVIGILATOR, STAFF
 */
export const getStaffUsers = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getStaffUsers] by=${req.user?.userId || 'anonymous'}`);
    
    const { role, search } = req.query;
    
    const users = await AdminService.getStaffUsers({
        role: role as Role | undefined,
        search: search as string | undefined
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Staff users retrieved successfully',
        data: users
    });
});

/**
 * Update staff user details
 */
export const updateStaffUser = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateStaffUser] by=${req.user?.userId || 'anonymous'}`);
    
    const { userId } = req.params;
    const { name, email, role } = req.body;
    
    const updatedUser = await AdminService.updateStaffUser(
        userId,
        { name, email, role },
        req.user?.userId
    );

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Staff user updated successfully',
        data: updatedUser
    });
});
