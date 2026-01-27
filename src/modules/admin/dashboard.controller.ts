import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { DashboardService } from './dashboard.service';

export const DashboardController = {
    getGlobalStats: catchAsync(async (req: Request, res: Response) => {
        const stats = await DashboardService.getGlobalStats();
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: stats
        });
    }),

    getRegistrationTrends: catchAsync(async (req: Request, res: Response) => {
        const { range } = req.query;
        const trends = await DashboardService.getRegistrationTrends(range as string || '7d');
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: trends
        });
    }),

    getRecentStudents: catchAsync(async (req: Request, res: Response) => {
        const { range } = req.query;
        const students = await DashboardService.getRecentStudents(range as string || '7d');
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: students
        });
    }),

    getSeatAllocationStats: catchAsync(async (req: Request, res: Response) => {
        const { type, page, limit } = req.query;
        const stats = await DashboardService.getSeatAllocationStats(
            type as string, 
            parseInt(page as string) || 1, 
            parseInt(limit as string) || 10
        );
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: stats
        });
    })
};
