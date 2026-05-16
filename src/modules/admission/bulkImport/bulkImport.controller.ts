import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../../utils/catchAsync';
import { AppError } from '../../../utils/AppError';
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

export const validateOfflineApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const applications = req.body;
    if (!Array.isArray(applications) || applications.length === 0) {
        throw new AppError('Request body must be a non-empty array of applications', 400);
    }
    const results = await bulkImportService.validateOfflineApplications(applications);
    res.status(200).json({
        status: 'success',
        message: results.invalid === 0 ? 'All records are valid and ready to import' : `${results.invalid} record(s) have errors`,
        data: results
    });
});

export const importOfflineApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const applications = req.body;
    if (!Array.isArray(applications) || applications.length === 0) {
        throw new AppError('Request body must be a non-empty array of applications', 400);
    }
    const results = await bulkImportService.processOfflineApplications(applications, req.user?.userId || 'ADMIN');
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

// ═══════════════════════════════════════════════════════════
//  BULK MANUAL ENTRY (lateral / transfer / back-dated)
// ═══════════════════════════════════════════════════════════

export const validateBulkManualEntry = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new AppError('Request body must be a non-empty array of admission records', 400);
    }
    if (rows.length > 500) {
        throw new AppError('Batch size limit exceeded: maximum 500 rows per request', 400);
    }
    const results = await bulkImportService.validateBulkManualEntry(rows);
    res.status(200).json({
        status: 'success',
        message: results.invalid === 0
            ? 'All records are valid and ready to import'
            : `${results.invalid} record(s) have errors`,
        data: results
    });
});

export const importBulkManualEntry = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new AppError('Request body must be a non-empty array of admission records', 400);
    }
    if (rows.length > 500) {
        throw new AppError('Batch size limit exceeded: maximum 500 rows per request', 400);
    }
    const results = await bulkImportService.processBulkManualEntry(rows, req.user?.userId || 'ADMIN');
    res.status(200).json({
        status: 'success',
        data: results
    });
});

export const downloadManualEntryTemplate = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const csv = bulkImportService.generateManualEntryTemplate();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="manual-entry-template.csv"');
    res.status(200).send(csv);
});
