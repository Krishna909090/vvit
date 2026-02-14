import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { DashboardService } from './dashboard.service';

export const DashboardController = {
    getApplicationStats: catchAsync(async (req: Request, res: Response) => {
        const { range, startDate, endDate } = req.query;
        const stats = await DashboardService.getApplicationStats(range as string, startDate as string, endDate as string);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: stats
        });
    }),

    getFinancialStats: catchAsync(async (req: Request, res: Response) => {
        const { range, startDate, endDate } = req.query;
        const stats = await DashboardService.getFinancialStats(range as string, startDate as string, endDate as string);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: stats
        });
    }),

    getAdmissionStats: catchAsync(async (req: Request, res: Response) => {
        const { range, startDate, endDate } = req.query;
        const stats = await DashboardService.getAdmissionStats(range as string, startDate as string, endDate as string);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: stats
        });
    }),

    getExamStats: catchAsync(async (req: Request, res: Response) => {
        const { range, startDate, endDate } = req.query;
        const stats = await DashboardService.getExamStats(range as string, startDate as string, endDate as string);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: stats
        });
    }),

    getVerificationStats: catchAsync(async (req: Request, res: Response) => {
        const { range, startDate, endDate } = req.query;
        const stats = await DashboardService.getVerificationStats(range as string, startDate as string, endDate as string);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: stats
        });
    }),

    getDegreeSeatAllocatedStats: catchAsync(async (req: Request, res: Response) => {
        const { range, startDate, endDate } = req.query;
        const stats = await DashboardService.getDegreeSeatAllocatedStats(range as string, startDate as string, endDate as string);
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
        const { type, page, limit, search } = req.query;
        const stats = await DashboardService.getSeatAllocationStats(
            type as string, 
            parseInt(page as string) || 1, 
            parseInt(limit as string) || 10,
            search as string
        );
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: stats
        });
    }),

    getCourseCodes: catchAsync(async (req: Request, res: Response) => {
        const codes = await DashboardService.getCourseCodes();
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: codes
        });
    }),

    getSeatAllocationCounts: catchAsync(async (req: Request, res: Response) => {
        const { filter } = req.query;
        const counts = await DashboardService.getSeatAllocationCounts(filter as string);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: counts
        });
    }),

    getCourseStats: catchAsync(async (req: Request, res: Response) => {
        const stats = await DashboardService.getCourseSeatStats();
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: stats
        });
    })
};
