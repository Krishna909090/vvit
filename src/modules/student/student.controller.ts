import { Request, Response, NextFunction } from 'express';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AdmissionStatus, RequestStatus } from '@prisma/client';
import { Role } from '../../constants/roles';
import { v4 as uuidv4 } from 'uuid';
import { registerStudent as registerStudentService, getHallTicket as getHallTicketService, uploadDocumentsAndPreferences as uploadDocsService, addAcademicDetails as addAcademicDetailsService, getStudentByUserId as getStudentByUserIdService, updatePersonalDetails as updatePersonalDetailsService } from './student.service';
import { bookExamSlot } from '../exam/exam.service';
import QRCode from 'qrcode';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';

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

// Request Course Change
export const requestCourseChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestCourseChange] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[requestCourseChange] params=${JSON.stringify(req.params)} payload=${JSON.stringify(req.body)}`);

    const { studentId } = req.params;
    const { newCourseId, reason } = req.body;
    if (!studentId || !newCourseId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_NEWCOURSE_REASON_REQUIRED, 400);

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });
    if (!student) {
        logger.warn(`[requestCourseChange] student not found id=${studentId}`);
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    if (!student.admissionDetails?.allottedCourseId) {
        logger.warn(`[requestCourseChange] no allotted course for student=${studentId}`);
        throw new AppError(MESSAGES.ERROR.NO_COURSE_ALLOTTED, 400);
    }

    const existingRequest = await prisma.courseChangeRequest.findFirst({
        where: {
            studentId,
            status: { in: [RequestStatus.REQUESTED, RequestStatus.FORWARDED] }
        }
    });

    if (existingRequest) {
        throw new AppError(MESSAGES.ERROR.COURSE_CHANGE_ALREADY_REQUESTED || 'Course change request already pending', 409);
    }

    const request = await prisma.courseChangeRequest.create({
        data: {
            studentId,
            fromCourse: student.admissionDetails.allottedCourseId,
            toCourse: newCourseId,
            reason,
            status: RequestStatus.REQUESTED,
            forwardedTo: 'SUPER_ADMIN', // Direct to Super Admin as per requirement
            createdBy: req.user?.userId || null
        }
    });

    logger.info(`[requestCourseChange] created requestId=${request.id} for student=${studentId}`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.COURSE_CHANGE_REQUESTED,
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

export const updatePersonalDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updatePersonalDetails] by=${req.user?.userId || 'anonymous'}`);

    const { studentId } = req.params;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const currentUserId = req.user?.userId || null;
    
    // Call service with ownership verification inside
    const result = await updatePersonalDetailsService(studentId, req.body, currentUserId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message
    });
});



