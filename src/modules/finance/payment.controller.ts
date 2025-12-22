
import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import {
    payTestFee as payTestFeeService,
    payCollegeFee as payCollegeFeeService,
    requestDiscount as requestDiscountService,
    getInvoiceUrl // Added import
} from './payment.service';

// Phase 1: Pay Test Fee
export const payTestFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[payTestFee] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[payTestFee] params=${JSON.stringify(req.params)}`);

    let { studentId } = req.params;
    
    // Self-service fallback
    if (!studentId && req.user?.role === 'STUDENT') {
        const { getStudentByUserId } = await import('../student/student.service');
        const s = await getStudentByUserId(req.user.userId);
        if (s) studentId = s.id;
    }

    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const currentUserId = req.user?.userId || null;
    const student = await payTestFeeService(studentId, currentUserId);

    logger.info(`[payTestFee] initiated for studentId=${studentId}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.PAYMENT_SUCCESS,
        data: student
    });
});

// Phase 6: Final Fee Payment
export const payCollegeFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[payCollegeFee] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[payCollegeFee] params=${JSON.stringify(req.params)}`);

    let { studentId } = req.params;
    
    // Self-service fallback
    if (!studentId && req.user?.role === 'STUDENT') {
        const { getStudentByUserId } = await import('../student/student.service');
        const s = await getStudentByUserId(req.user.userId);
        if (s) studentId = s.id;
    }

    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const currentUserId = req.user?.userId || null;
    const student = await payCollegeFeeService(studentId, req.body, currentUserId);

    logger.info(`[payCollegeFee] initiated for studentId=${studentId}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.PAYMENT_SUCCESS,
        data: student
    });
});

// Fee Reduction Request
export const requestDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestDiscount] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[requestDiscount] params=${JSON.stringify(req.params)} payload=${JSON.stringify(req.body)}`);

    const { studentId } = req.params;
    const { reason, documentUrl } = req.body;
    if (!studentId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_REASON_REQUIRED, 400);

    const currentUserId = req.user?.userId || null;
    const discountRequest = await requestDiscountService(studentId, reason, documentUrl, currentUserId);

    logger.info(`[requestDiscount] created for studentId=${studentId}`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_REQUESTED,
        data: discountRequest
    });
});

export const getInvoice = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getInvoice] params=${JSON.stringify(req.params)}`);
    const { paymentId } = req.params;
    if (!paymentId) throw new AppError("Payment ID is required", 400);

    const url = await getInvoiceUrl(paymentId);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Invoice URL retrieved successfully",
        data: { url }
    });
});
