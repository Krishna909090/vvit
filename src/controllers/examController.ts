import { Request, Response, NextFunction } from 'express';
import * as examService from '../services/examService';
import logger from '../utils/logger';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import { sendResponse } from '../utils/response';
import { MESSAGES } from '../constants/messages';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

export const createExamDate = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[createExamDate] request by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[createExamDate] payload=${JSON.stringify(req.body)}`);

    const examDate = await examService.createExamDate(req.body);
    logger.info(`[createExamDate] created id=${examDate.id}`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.EXAM_DATE_CREATED,
        data: examDate
    });
});

export const createExamCenter = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[createExamCenter] request by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[createExamCenter] payload=${JSON.stringify(req.body)}`);

    const examCenter = await examService.createExamCenter(req.body);
    logger.info(`[createExamCenter] created id=${examCenter.id}`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.EXAM_CENTER_CREATED,
        data: examCenter
    });
});

export const generateInvigilatorCredentials = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const adminId = req.user?.userId;
    if (!adminId) {
        logger.warn('[generateInvigilatorCredentials] unauthorized access attempt');
        throw new AppError(MESSAGES.ERROR.UNAUTHORIZED, 401);
    }

    // Extra role check for safety (route should already guard)
    if (req.user?.role !== 'ADMIN' && req.user?.role !== 'SUPER_ADMIN') {
        logger.warn(`[generateInvigilatorCredentials] forbidden user=${adminId} role=${req.user?.role}`);
        throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
    }

    logger.info(`[generateInvigilatorCredentials] admin=${adminId}`);
    logger.debug && logger.debug(`[generateInvigilatorCredentials] payload=${JSON.stringify(req.body)}`);

    const result = await examService.generateInvigilatorCredentials(adminId, req.body);
    logger.info('[generateInvigilatorCredentials] generated credentials');
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.INVIGILATOR_CREDENTIALS_GENERATED,
        data: result
    });
});

export const loginInvigilator = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info('[loginInvigilator] attempt');
    logger.debug && logger.debug(`[loginInvigilator] payload=${JSON.stringify(req.body)}`);

    const { token } = req.body;
    const credential = await examService.verifyInvigilatorToken(token);

    const jwtToken = jwt.sign(
        { userId: credential.id, role: 'INVIGILATOR' },
        JWT_SECRET,
        { expiresIn: '12h' }
    );

    logger.info(`[loginInvigilator] success invigilator=${credential.id}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.LOGIN_SUCCESS,
        data: { token: jwtToken }
    });
});

export const scanAttendance = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const invigilatorId = req.user?.userId;
    if (!invigilatorId) {
        logger.warn('[scanAttendance] unauthorized attempt');
        throw new AppError(MESSAGES.ERROR.UNAUTHORIZED, 401);
    }

    if (req.user?.role !== 'INVIGILATOR') {
        logger.warn(`[scanAttendance] forbidden user=${invigilatorId} role=${req.user?.role}`);
        throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
    }

    const { qrHash } = req.body;
    if (!qrHash) {
        logger.warn('[scanAttendance] missing qrHash');
        throw new AppError(MESSAGES.ERROR.QR_HASH_REQUIRED, 400);
    }

    logger.info(`[scanAttendance] invigilator=${invigilatorId} scanning`);
    const result = await examService.markAttendanceByScan(qrHash, invigilatorId);

    logger.info(`[scanAttendance] attendance marked`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ATTENDANCE_MARKED,
        data: result
    });
});

export const createExamSlot = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[createExamSlot] by=${req.user?.userId || 'anonymous'}`);
    const slot = await examService.createExamSlot(req.body);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.EXAM_SLOT_CREATED,
        data: slot
    });
});

export const getAvailableSlots = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getAvailableSlots] by=${req.user?.userId || 'anonymous'}`);
    const slots = await examService.getAvailableSlots();
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: slots
    });
});

export const bookExamSlot = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[bookExamSlot] by=${req.user?.userId || 'anonymous'}`);
    const { slotId } = req.body;
    const studentId = req.params.studentId;

    if (!studentId || !slotId) {
        throw new AppError(MESSAGES.ERROR.STUDENT_ID_SLOT_ID_REQUIRED, 400);
    }

    const result = await examService.bookExamSlot(studentId, slotId);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.SLOT_BOOKED,
        data: result
    });
});
