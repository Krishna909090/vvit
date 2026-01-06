
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
    approveDiscount as approveDiscountService,
    rejectDiscount as rejectDiscountService,
    getInvoiceUrl,
    checkPaymentStatus as checkPaymentStatusService,
    getStudentFinancialHistory,
    initiateTokenPayment
} from './payment.service';

// Phase 1: Pay Test Fee
export const payTestFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[payTestFee] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[payTestFee] params=${JSON.stringify(req.params)}`);

    let { studentId } = req.params;
    if (!studentId && req.body.studentId) {
        studentId = req.body.studentId;
    }
    
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

export const payTokenFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[payTokenFee] by=${req.user?.userId || 'anonymous'}`);

    let { studentId } = req.params;
    if (!studentId && req.body.studentId) studentId = req.body.studentId;

    if (!studentId && req.user?.role === 'STUDENT') {
         const { getStudentByUserId } = await import('../student/student.service');
         const s = await getStudentByUserId(req.user.userId);
         if (s) studentId = s.id;
    }

    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const result = await initiateTokenPayment(studentId, req.body);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Token payment initiated",
        data: { redirectUrl: result }
    });
});

// Phase 6: Final Fee Payment
export const payCollegeFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[payCollegeFee] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[payCollegeFee] params=${JSON.stringify(req.params)}`);

    let { studentId } = req.params;
    if (!studentId && req.body.studentId) {
        studentId = req.body.studentId;
    }
    
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


    const { studentId,reason, documentUrl, amount } = req.body;
    if (!studentId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_REASON_REQUIRED, 400);

    const currentUserId = req.user?.userId || null;
    const discountRequest = await requestDiscountService(studentId, reason, amount || 0, documentUrl, currentUserId || undefined);

    logger.info(`[requestDiscount] created for studentId=${studentId}`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_REQUESTED,
        data: discountRequest
    });
});

export const approveDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { requestId } = req.params;
    const { approvedAmount, component, remarks } = req.body;
    
    if (!approvedAmount || !component) throw new AppError("Approved Amount and Component are required", 400);

    const result = await approveDiscountService(requestId, approvedAmount, component, req.user!.userId, remarks);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Discount Approved",
        data: result
    });
});

export const rejectDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { requestId } = req.params;
    const { remarks } = req.body; 
    
    const result = await rejectDiscountService(requestId, remarks, req.user!.userId);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Discount Rejected",
        data: result
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

export const checkPaymentStatus = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[checkPaymentStatus] params=${JSON.stringify(req.params)}`);
    const { txnId } = req.params;
    if (!txnId) throw new AppError("Transaction ID is required", 400);

    const status = await checkPaymentStatusService(txnId);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Payment status check completed",
        data: status
    });
});

export const getPaymentHistory = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    let { studentId } = req.params;
    
    // Self-service fallback
    if (!studentId && req.user?.role === 'STUDENT') {
         const { getStudentByUserId } = await import('../student/student.service');
         const s = await getStudentByUserId(req.user.userId);
         if (s) studentId = s.id;
    }

    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const history = await getStudentFinancialHistory(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Financial history retrieved successfully",
        data: history
    });
});

export const getFinancialSummary = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    let { studentId } = req.params;
    
    if (!studentId && req.user?.role === 'STUDENT') {
         const { getStudentByUserId } = await import('../student/student.service');
         const s = await getStudentByUserId(req.user.userId);
         if (s) studentId = s.id;
    }

    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const { getStudentFinancialSummary } = await import('./payment.service');
    const summary = await getStudentFinancialSummary(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Financial summary retrieved successfully",
        data: summary
    });
});
