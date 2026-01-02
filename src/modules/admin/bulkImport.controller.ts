import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import * as bulkImportService from './bulkImport.service';

export const importOfflineStudents = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) {
        throw new AppError('Please upload an Excel file', 400);
    }
    const results = await bulkImportService.processOfflineRegistration(req.file.buffer, req.user?.userId || 'ADMIN');
    res.status(200).json({
        status: 'success',
        data: results
    });
});

export const importSeatBookingStudents = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) {
        throw new AppError('Please upload an Excel file', 400);
    }
    const results = await bulkImportService.processSeatBookingRegistration(req.file.buffer, req.user?.userId || 'ADMIN');
    res.status(200).json({
        status: 'success',
        data: results
    });
});

export const verifyPayment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, amount, type } = req.body;
    if (!studentId || !amount || !type) {
        throw new AppError('Missing required fields: studentId, amount, type', 400);
    }
    const result = await bulkImportService.verifyOfflinePayment(studentId, amount, type, req.user?.userId || 'ADMIN');
    res.status(200).json({
        status: 'success',
        data: result
    });
});
