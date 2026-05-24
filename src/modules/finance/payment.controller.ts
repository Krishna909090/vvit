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
    getStudentFinancialFlow,
    getStudentCompleteHistory,
    initiateTokenPayment,
    recordOfflineApplicationFeePayment,
    initiateMultiComponentPayment,
    getAllSuccessPayments,
    getPaymentCreators,
    getPaymentComponents,
    exportSuccessPaymentsCsv
} from './payment.service';

export const getAllSuccessPaymentsController = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getAllSuccessPayments] by=${req.user?.userId || 'anonymous'}`);
    const result = await getAllSuccessPayments(req.query);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Payment transactions fetched successfully',
        data: result
    });
});

export const getPaymentCreatorsController = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const creators = await getPaymentCreators();
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Payment creators fetched',
        data: creators
    });
});

export const getPaymentComponentsController = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const components = await getPaymentComponents();
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Payment components fetched',
        data: components
    });
});

export const exportSuccessPaymentsCsvController = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[exportSuccessPaymentsCsv] by=${req.user?.userId || 'anonymous'}`);
    const csv = await exportSuccessPaymentsCsv(req.query);
    const filename = `payment-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
});

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
// @deprecated — use POST /finance/pay-component { component: 'APPLICATION_FEE', mode: 'ONLINE', ... }
export const payTestFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Warning', `299 - "Deprecated: use POST /finance/pay-component { component: 'APPLICATION_FEE', mode: 'ONLINE' }"`);
    logger.warn(`[payTestFee] DEPRECATED endpoint hit by=${req.user?.userId || 'anonymous'} — migrate FE to /pay-component`);
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

/**
 * IDOR guard — a STUDENT may only access their OWN financial data. Any non-STUDENT
 * role (admin/staff that already passed authorizePermission) is allowed through.
 * Without this, a student holding `finance.read.own` could pass another student's
 * id/paymentId/txnId and read their financials.
 */
const assertStudentOwns = async (req: Request, studentId: string) => {
    if (req.user?.role === 'STUDENT') {
        const { getStudentByUserId } = await import('../student/student.service');
        const s = await getStudentByUserId(req.user.userId);
        if (!s || s.id !== studentId) {
            logger.warn(`[Security] Student ${req.user?.userId} attempted to access financial data of ${studentId}`);
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
    }
};

export const getInvoice = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getInvoice] params=${JSON.stringify(req.params)}`);
    const { paymentId } = req.params;
    if (!paymentId) throw new AppError("Payment ID is required", 400);

    // IDOR guard: resolve the payment's owner and ensure a student only sees their own.
    const { default: prisma } = await import('../../config/prisma');
    const pay = await prisma.payment.findUnique({ where: { id: paymentId }, select: { studentId: true } });
    if (!pay) throw new AppError("Payment not found", 404);
    await assertStudentOwns(req, pay.studentId);

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

    // IDOR guard: this endpoint also auto-reconciles (can mark SUCCESS/FAILED), so a
    // student must not be able to poll/trigger it for another student's transaction.
    const { default: prisma } = await import('../../config/prisma');
    const pay = await prisma.payment.findFirst({
        where: { OR: [{ providerTxId: txnId }, { merchantOrderId: txnId }] },
        select: { studentId: true },
    });
    if (pay) await assertStudentOwns(req, pay.studentId);

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

    // Optional ?academicYearId=<id> filters the breakdown / payments / demands /
    // ledger / corrections to only that year. Useful for year-end reports.
    const academicYearId = typeof req.query.academicYearId === 'string'
        ? req.query.academicYearId
        : undefined;

    const history = await getStudentFinancialHistory(studentId, { academicYearId });

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

    await assertStudentOwns(req, studentId); // IDOR guard

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

// @deprecated — use POST /finance/pay-component { component: 'APPLICATION_FEE', mode: 'OFFLINE', method, referenceNumber, ... }
export const payOfflineApplicationFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Warning', `299 - "Deprecated: use POST /finance/pay-component { component: 'APPLICATION_FEE', mode: 'OFFLINE' }"`);
    logger.warn(`[payOfflineApplicationFee] DEPRECATED endpoint hit by=${req.user?.userId || 'anonymous'} — migrate FE to /pay-component`);
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

// @deprecated — thin wrapper around processUnifiedPayment. Use POST /finance/pay-component instead.
export const initiateAdminPayment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Warning', `299 - "Deprecated: use POST /finance/pay-component"`);
    logger.warn(`[initiateAdminPayment] DEPRECATED endpoint hit by=${req.user?.userId} — migrate FE to /pay-component`);
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

export const getFinancialFlow = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    let { studentId } = req.params;

    if (!studentId && req.user?.role === 'STUDENT') {
        const { getStudentByUserId } = await import('../student/student.service');
        const student = await getStudentByUserId(req.user.userId);
        if (!student) throw new AppError('Student not found', 404);
        studentId = student.id;
    }

    if (!studentId) throw new AppError('Student ID is required', 400);

    await assertStudentOwns(req, studentId); // IDOR guard

    const flow = await getStudentFinancialFlow(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Financial flow retrieved successfully',
        data: flow
    });
});

/** Complete, audit-grade student history — every record (incl. deleted/reversed/superseded),
 *  grouped into sections + a merged chronological timeline + one reconciled summary. */
export const getCompleteHistory = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    let { studentId } = req.params;

    if (!studentId && req.user?.role === 'STUDENT') {
        const { getStudentByUserId } = await import('../student/student.service');
        const student = await getStudentByUserId(req.user.userId);
        if (!student) throw new AppError('Student not found', 404);
        studentId = student.id;
    }

    if (!studentId) throw new AppError('Student ID is required', 400);

    await assertStudentOwns(req, studentId); // IDOR guard

    const history = await getStudentCompleteHistory(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Complete student history retrieved successfully',
        data: history
    });
});
