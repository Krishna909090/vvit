import { Request, Response, NextFunction } from 'express';
import { searchTransactionLogs, searchLocalLogs } from './logs.service';
import { AppError } from '../../../utils/AppError';

export const searchLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { q, from, to, source } = req.query;

        const searchTerm = typeof q === 'string' ? q.trim() : '';
        const startTime = from ? new Date(from as string) : undefined;
        const endTime = to ? new Date(to as string) : undefined;

        if (searchTerm.length > 0 && searchTerm.length < 3) {
            throw new AppError('Search query must be at least 3 characters', 400);
        }
        if (searchTerm.length === 0 && !startTime) {
            throw new AppError('Provide a search term (q) or a date range (from/to)', 400);
        }

        let result;

        if (source === 'local' || !process.env.CW_LOG_GROUP) {

            const days = startTime ? Math.ceil((Date.now() - startTime.getTime()) / (24 * 60 * 60 * 1000)) + 1 : 7;
            result = await searchLocalLogs(searchTerm || null, days, startTime, endTime);
        } else {

            result = await searchTransactionLogs(searchTerm || null, startTime, endTime);
        }

        res.status(200).json({
            status: 'success',
            data: result
        });
    } catch (error) {
        next(error);
    }
};
