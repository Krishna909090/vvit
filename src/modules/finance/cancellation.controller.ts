import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { sendResponse } from '../../utils/response';
import { CancellationService, calculateFeeAdjustment } from './cancellation.service';
import { CancellationStatus } from '@prisma/client';

export const previewAdjustment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[previewAdjustment] by=${req.user?.userId || 'anonymous'}`);

    const { conditionType, totalPaid, componentPaid, oldQuotaFee, newQuotaFee } = req.body;

    const result = calculateFeeAdjustment({
        conditionType,
        totalPaid,
        componentPaid,
        oldQuotaFee,
        newQuotaFee,
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Fee adjustment preview calculated successfully',
        data: result,
    });
});

export const requestCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestCancellation] by=${req.user?.userId || 'anonymous'}`);

    const {
        studentId,
        reason,
        conditionType,
        oldQuotaFee,
        newQuotaFee,
        remarks,
        fileUrl,
        recommendedByManagement,
        cancellationFee,
    } = req.body;

    const adminId = req.user?.userId;
    if (!adminId) throw new AppError('Unauthorized', 401);

    const result = await CancellationService.createCancellationRequest(
        { studentId, reason, conditionType, oldQuotaFee, newQuotaFee, remarks, fileUrl, recommendedByManagement, cancellationFee },
        adminId,
    );

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: 'Cancellation request created successfully',
        data: result,
    });
});

export const approveCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveCancellation] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, approved, remarks, cancellationFee } = req.body;

    const adminId = req.user?.userId;
    if (!adminId) throw new AppError('Unauthorized', 401);

    const result = await CancellationService.approveCancellation(requestId, approved, adminId, remarks, cancellationFee);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: approved ? 'Cancellation approved successfully' : 'Cancellation rejected',
        data: result,
    });
});

export const listCancellationRequests = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[listCancellationRequests] by=${req.user?.userId || 'anonymous'}`);

    const { status, conditionType, page, limit, applicationid, applicationId } = req.query;
    const searchAppId = (applicationid || applicationId) as string | undefined;

    const result = await CancellationService.listCancellationRequests({
        status:        status as CancellationStatus | undefined,
        conditionType: conditionType as string | undefined,
        applicationId: searchAppId,
        page:          page  ? parseInt(page  as string, 10) : 1,
        limit:         limit ? parseInt(limit as string, 10) : 20,
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Cancellation requests fetched successfully',
        data: result,
    });
});

export const downloadCancellationInvoice = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    logger.info(`[downloadCancellationInvoice] id=${req.params.id} by=${req.user?.userId || 'anonymous'}`);

    const presignedUrl = await CancellationService.getInvoiceUrl(req.params.id);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Cancellation receipt URL generated',
        data: { invoiceUrl: presignedUrl },
    });
});

export const getCancellationById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getCancellationById] id=${req.params.id} by=${req.user?.userId || 'anonymous'}`);

    const result = await CancellationService.getCancellationById(req.params.id);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Cancellation request fetched successfully',
        data: result,
    });
});
