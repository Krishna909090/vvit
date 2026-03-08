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
    initiateTokenPayment,
    recordOfflineApplicationFeePayment,
    processUnifiedPayment,
    initiateMultiComponentPayment
} from './payment.service';

export const payMultiComponentFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const currentUserId = req.user?.userId || 'anonymous';
    logger.info(`[payMultiComponentFee] START - by=${currentUserId}`);
    const { studentId, components, paymentMethod, remarks, referenceNumber, mode } = req.body;
    logger.debug(`[payMultiComponentFee] Request body: ${JSON.stringify({ studentId, componentsCount: components?.length, paymentMethod, mode, hasReferenceNumber: !!referenceNumber })}`);
    
    if (!studentId || !components || !Array.isArray(components) || components.length === 0) {
        logger.error(`[payMultiComponentFee] Validation failed - Missing required fields`);
        throw new AppError("Student ID and components array are required", 400);
    }
    logger.info(`[payMultiComponentFee] Processing ${components.length} components for student: ${studentId}`);
    
    // Authorization: User ID should match student's User ID unless Admin (handled by RBAC usually but check logic)
    const currentUserIdForAuth = req.user?.userId || undefined;

    const result = await initiateMultiComponentPayment(studentId, components, currentUserIdForAuth, paymentMethod, remarks, referenceNumber, mode);
    logger.info(`[payMultiComponentFee] SUCCESS - Result: ${JSON.stringify({ success: result.success, paymentIds: result.paymentIds?.length, transactionId: result.transactionId })}`);

    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.success ? "Payment successfully recorded" : "Multi-component payment initiated",
        data: result
    });
});

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

    // SECURITY: Authorization Check
    // If user is STUDENT, ensure they are requesting their own data
    if (req.user?.role === 'STUDENT') {
        const { getStudentByUserId } = await import('../student/student.service');
        const s = await getStudentByUserId(req.user.userId);
        if (!s || s.id !== studentId) {
            logger.warn(`[Security] Student ${req.user.userId} attempted to access history of ${studentId}`);
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
    }
    // If user is AGENT, ensure student belongs to them (Optional/Future scope, currently strictly blocking cross-access)

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

export const payOfflineApplicationFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[payOfflineApplicationFee] by=${req.user?.userId || 'anonymous'}`);
    const { studentId, paymentMethod, transactionId, remarks, referenceNumber } = req.body;

    if (!studentId || !paymentMethod) throw new AppError("Student ID and Payment Method are required", 400);

    const result = await recordOfflineApplicationFeePayment(studentId, paymentMethod, transactionId, remarks, req.user?.userId, referenceNumber);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Offline application fee recorded successfully",
        data: result
    });
});

export const initiateAdminPayment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[initiateAdminPayment] by=${req.user?.userId}`);
    const { studentId, amount, component, feeHeadId, remarks } = req.body;

    if (!studentId || !amount || !component) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

    // Use unified processor
    const result = await import('./payment.service').then(s => s.processUnifiedPayment({
        studentId,
        amount: Number(amount),
        component,
        mode: 'ONLINE', // Admin initiated online payment
        method: 'UPI',  // Default to UPI/Online
        feeHeadId,
        remarks,
        initiatedBy: req.user!.userId
    }));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Admin payment initiated",
        data: result
    });
});

export const payFeeComponent = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const currentUserId = req.user?.userId || 'anonymous';
    const currentUserRole = req.user?.role || 'UNKNOWN';
    logger.info(`[payFeeComponent] START - by=${currentUserId}, role=${currentUserRole}`);
    
    const { studentId, amount, component, mode } = req.body;
    logger.debug(`[payFeeComponent] Request: StudentId=${studentId}, Amount=${amount}, Component=${component}, Mode=${mode}`);

    // 1. Basic Validation
    if (!studentId || !amount || !component) {
        logger.error(`[payFeeComponent] Validation failed - Missing required fields`);
        throw new AppError("Student ID, Amount, and Component are required", 400);
    }
    logger.info(`[payFeeComponent] Validated - Processing ₹${amount} for ${component}`);

    // 2. Security: Authorization & Mode Restrictions
    if (req.user?.role === 'STUDENT') {
        logger.debug(`[payFeeComponent] Student role detected - Verifying authorization`);
        const { getStudentByUserId } = await import('../student/student.service');
        const s = await getStudentByUserId(req.user.userId);
        
        // Ensure paying for self
        if (!s || s.id !== studentId) {
            logger.warn(`[payFeeComponent] SECURITY ALERT - Student ${req.user.userId} attempted to pay for ${studentId}`);
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
        logger.info(`[payFeeComponent] Authorization verified - Student paying for self`);

        // Students cannot initiate OFFLINE payments directly via API (usually Admin recorded)
        if (mode === 'OFFLINE') {
             logger.warn(`[payFeeComponent] SECURITY ALERT - Student attempted OFFLINE payment`);
             throw new AppError("Students cannot record OFFLINE payments. Please contact admin.", 403);
        }
    }
    
    logger.info(`[payFeeComponent] Calling processUnifiedPayment service`);

    
    const result = await import('./payment.service').then(s => s.processUnifiedPayment({
        ...req.body,
        initiatedBy: req.user?.userId || null
    }));

    sendResponse({
        res,
        statusCode: 200, 
        success: true,
        message: result.message || "Payment processed",
        data: result.data
    });
});
