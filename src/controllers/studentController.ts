import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import logger from '../utils/logger';
import { Role, AdmissionStatus, RequestStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { registerStudent as registerStudentService, payTestFee as payTestFeeService, getHallTicket as getHallTicketService, uploadDocumentsAndPreferences as uploadDocsService, payCollegeFee as payCollegeFeeService, requestDiscount as requestDiscountService, addAcademicDetails as addAcademicDetailsService, getStudentByUserId as getStudentByUserIdService } from '../services/studentService';
import { bookExamSlot } from '../services/examService';
import QRCode from 'qrcode';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';
import { sendResponse } from '../utils/response';

// Phase 1: Registration
export const registerStudent = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[registerStudent] attempt by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[registerStudent] payload=${JSON.stringify(req.body)}`);

    const agentId = req.user?.role === Role.AGENT ? (req.user?.userId || null) : null;
    const userId = req.user?.role === Role.STUDENT ? (req.user?.userId || null) : null;
    const currentUserId = req.user?.userId || null;
    const student = await registerStudentService(req.body, agentId, userId, currentUserId);

    logger.info(`[registerStudent] success applicationId=${student.applicationId}`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.STUDENT_REGISTERED,
        data: student
    });
});

// Phase 1: Pay Test Fee
export const payTestFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[payTestFee] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[payTestFee] params=${JSON.stringify(req.params)}`);

    const { studentId } = req.params;
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

// Phase 2: Download Hall Ticket (Student)
export const getHallTicket = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getHallTicket] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[getHallTicket] params=${JSON.stringify(req.params)}`);

    const { studentId } = req.params;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const hallTicketUrl = await getHallTicketService(studentId);

    logger.info(`[getHallTicket] fetched for studentId=${studentId}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: hallTicketUrl
    });
});

// Phase 4: Branch Preference & Documents
export const uploadDocumentsAndPreferences = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[uploadDocumentsAndPreferences] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[uploadDocumentsAndPreferences] params=${JSON.stringify(req.params)} payload=${JSON.stringify(req.body)}`);

    const { studentId } = req.params;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const currentUserId = req.user?.userId || null;
    const updatedStudent = await uploadDocsService(studentId, req.body, currentUserId);

    logger.info(`[uploadDocumentsAndPreferences] success for studentId=${studentId}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.FILE_UPLOADED,
        data: updatedStudent
    });
});

// Phase 6: Final Fee Payment
export const payCollegeFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[payCollegeFee] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[payCollegeFee] params=${JSON.stringify(req.params)}`);

    const { studentId } = req.params;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const currentUserId = req.user?.userId || null;
    const student = await payCollegeFeeService(studentId, currentUserId);

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

// Select Exam Date and Center
// Select Exam Date and Center (via Slot)
export const selectExam = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[selectExam] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[selectExam] params=${JSON.stringify(req.params)} payload=${JSON.stringify(req.body)}`);

    const { studentId } = req.params;
    const { slotId } = req.body;
    if (!studentId || !slotId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_SLOT_ID_REQUIRED, 400);

    // Use examService to book slot and generate hall ticket
    const result = await bookExamSlot(studentId, slotId);

    logger.info(`[selectExam] Hall ticket generated for student=${studentId}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.SLOT_BOOKED,
        data: result
    });
});

// Request Branch Change
export const requestBranchChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestBranchChange] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[requestBranchChange] params=${JSON.stringify(req.params)} payload=${JSON.stringify(req.body)}`);

    const { studentId } = req.params;
    const { newBranch, reason } = req.body;
    if (!studentId || !newBranch || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_NEWBRANCH_REASON_REQUIRED, 400);

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });
    if (!student) {
        logger.warn(`[requestBranchChange] student not found id=${studentId}`);
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    if (!student.admissionDetails?.allottedBranch) {
        logger.warn(`[requestBranchChange] no allotted branch for student=${studentId}`);
        throw new AppError(MESSAGES.ERROR.NO_BRANCH_ALLOTTED, 400);
    }

    const existingRequest = await prisma.branchChangeRequest.findFirst({
        where: {
            studentId,
            status: { in: [RequestStatus.REQUESTED, RequestStatus.FORWARDED] }
        }
    });

    if (existingRequest) {
        throw new AppError(MESSAGES.ERROR.BRANCH_CHANGE_ALREADY_REQUESTED || 'Branch change request already pending', 409);
    }

    const request = await prisma.branchChangeRequest.create({
        data: {
            studentId,
            fromBranch: student.admissionDetails.allottedBranch,
            toBranch: newBranch,
            reason,
            status: RequestStatus.REQUESTED,
            forwardedTo: 'SUPER_ADMIN', // Direct to Super Admin as per requirement
            createdBy: req.user?.userId || null
        }
    });

    logger.info(`[requestBranchChange] created requestId=${request.id} for student=${studentId}`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.BRANCH_CHANGE_REQUESTED,
        data: request
    });
});

export const addAcademicDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[addAcademicDetails] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[addAcademicDetails] params=${JSON.stringify(req.params)} payload=${JSON.stringify(req.body)}`);

    const { studentId } = req.params;
    const { details } = req.body; // Expecting an array of objects

    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    if (!details || !Array.isArray(details) || details.length === 0) {
        logger.warn('[addAcademicDetails] invalid details array');
        throw new AppError(MESSAGES.ERROR.DETAILS_ARRAY_REQUIRED, 400);
    }

    const currentUserId = req.user?.userId || null;
    const result = await addAcademicDetailsService(studentId, details, currentUserId);

    logger.info(`[addAcademicDetails] added for student=${studentId}`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.ACADEMIC_DETAILS_ADDED,
        data: result
    });
});

// Get Student Details (Comprehensive)
// Get Student Details (Logged-in User)
export const getStudentDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getStudentDetails] by=${req.user?.userId || 'anonymous'}`);

    const userId = req.user?.userId;
    if (!userId) {
        throw new AppError(MESSAGES.ERROR.UNAUTHORIZED, 401);
    }

    const student = await getStudentByUserIdService(userId);

    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.STUDENT_DETAILS_FETCHED,
        data: student
    });
});



