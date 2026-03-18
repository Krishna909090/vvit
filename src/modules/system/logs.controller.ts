import { Request, Response, NextFunction } from 'express';
import { searchTransactionLogs, searchLocalLogs } from './logs.service';
import { AppError } from '../../utils/AppError';

/**
 * GET /system/logs/search?q=abc-123&from=2026-03-10&to=2026-03-17&source=cloudwatch
 * Search transaction logs by correlationId, studentId, applicationId, or txnId.
 */
export const searchLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { q, from, to, source } = req.query;

        if (!q || typeof q !== 'string' || q.trim().length < 3) {
            throw new AppError('Search query (q) is required and must be at least 3 characters', 400);
        }

        const searchTerm = q.trim();
        const startTime = from ? new Date(from as string) : undefined;
        const endTime = to ? new Date(to as string) : undefined;

        let result;

        if (source === 'local' || !process.env.CW_LOG_GROUP) {
            // Use local log files
            const days = startTime ? Math.ceil((Date.now() - startTime.getTime()) / (24 * 60 * 60 * 1000)) : 7;
            result = await searchLocalLogs(searchTerm, days);
        } else {
            // Use CloudWatch
            result = await searchTransactionLogs(searchTerm, startTime, endTime);
        }

        res.status(200).json({
            status: 'success',
            data: result
        });
    } catch (error) {
        next(error);
    }
};
