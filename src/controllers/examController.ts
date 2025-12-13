// controllers/examController.ts
// Express controllers for exam-related APIs, using services for business logic.

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

/* -------------------------------------------------------------------------- */
/*                               CONTROLLER APIS                              */
/* -------------------------------------------------------------------------- */

/**
 * Controller: Create a new exam center.
 * Route: POST /exam/centers
 * Roles: ADMIN, SUPER_ADMIN
 */
export const createExamCenter = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[createExamCenter] request by=${req.user?.userId || 'anonymous'}`);
        logger.debug && logger.debug(`[createExamCenter] payload=${JSON.stringify(req.body)}`);

        const examCenter = await examService.createExamCenter(req.body, req.user?.userId);
        logger.info(`[createExamCenter] created id=${examCenter.id}`);
        sendResponse({
            res,
            statusCode: 201,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_CENTER_CREATED,
            data: examCenter,
        });
    }
);



/**
 * Controller: Mark attendance for a student by QR scan.
 * Route: POST /exam/attendance/scan
 * Roles: INVIGILATOR
 */
export const scanAttendance = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
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

        logger.info(`[scanAttendance] invigilator=${invigilatorId} scanning`);
        const result = await examService.markAttendanceByScan(qrHash, invigilatorId);

        logger.info('[scanAttendance] attendance marked');
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.ATTENDANCE_MARKED,
            data: result,
        });
    }
);

/**
 * Controller: Create a new exam slot for a center.
 * Route: POST /exam/slots
 * Roles: ADMIN, SUPER_ADMIN
 */
export const createExamSlot = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[createExamSlot] by=${req.user?.userId || 'anonymous'}`);
        logger.debug && logger.debug(`[createExamSlot] payload=${JSON.stringify(req.body)}`);

        const slot = await examService.createExamSlot(req.body, req.user?.userId);
        sendResponse({
            res,
            statusCode: 201,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_SLOT_CREATED,
            data: slot,
        });
    }
);

/**
 * Controller: Get available exam slots (future & booking-enabled & not full).
 * Route: GET /exam/slots/available
 * Roles: typically STUDENT
 */
export const getAvailableSlots = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[getAvailableSlots] by=${req.user?.userId || 'anonymous'}`);
        const slots = await examService.getAvailableSlots();
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            data: slots,
        });
    }
);

/**
 * Controller: Book an exam slot for a specific student.
 * Route: POST /students/:studentId/exam/slots
 * Roles: STUDENT (or ADMIN in special flows)
 */
export const bookExamSlot = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[bookExamSlot] by=${req.user?.userId || 'anonymous'}`);
        const { slotId } = req.body;
        const { studentId } = req.params;

        const result = await examService.bookExamSlot(studentId, slotId, req.user?.userId);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.SLOT_BOOKED,
            data: result,
        });
    }
);

/**
 * Controller: Toggle booking status (enable/disable) for an exam slot.
 * Route: PATCH /exam/slots/:slotId/booking
 * Roles: ADMIN, SUPER_ADMIN
 */
export const toggleSlotBooking = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[toggleSlotBooking] by=${req.user?.userId || 'anonymous'}`);
        const { slotId } = req.params;
        const { isBookingEnabled } = req.body;

        const result = await examService.toggleSlotBooking(
            slotId,
            isBookingEnabled,
            req.user?.userId
        );
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: isBookingEnabled ? 'Slot booking enabled' : 'Slot booking disabled',
            data: result,
        });
    }
);

/**
 * Controller: Fetch all exam centers (with slots).
 * Route: GET /exam/centers
 * Roles: ADMIN, SUPER_ADMIN
 */
export const getExamCenters = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[getExamCenters] by=${req.user?.userId || 'anonymous'}`);
        const centers = await examService.getExamCenters();
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_CENTERS_FETCHED,
            data: centers,
        });
    }
);

/**
 * Controller: Update an exam center.
 * Route: PUT /exam/centers/:id
 * Roles: ADMIN, SUPER_ADMIN
 */
export const updateExamCenter = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[updateExamCenter] by=${req.user?.userId || 'anonymous'}`);
        const { id } = req.params;
        const center = await examService.updateExamCenter(id, req.body, req.user?.userId);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_CENTER_UPDATED,
            data: center,
        });
    }
);

/**
 * Controller: Delete an exam center.
 * Route: DELETE /exam/centers/:id
 * Roles: ADMIN, SUPER_ADMIN
 */
export const deleteExamCenter = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[deleteExamCenter] by=${req.user?.userId || 'anonymous'}`);
        const { id } = req.params;
        await examService.deleteExamCenter(id);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_CENTER_DELETED,
        });
    }
);

/**
 * Controller: Fetch all exam slots (for admin management UI).
 * Route: GET /exam/slots
 * Roles: ADMIN, SUPER_ADMIN
 */
export const getExamSlots = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[getExamSlots] by=${req.user?.userId || 'anonymous'}`);
        const slots = await examService.getExamSlots();
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_SLOTS_FETCHED,
            data: slots,
        });
    }
);

/**
 * Controller: Fetch slots for a particular center.
 * Route: GET /exam/centers/:centerId/slots
 * Roles: ADMIN, SUPER_ADMIN
 */
export const getExamSlotsByCenter = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[getExamSlotsByCenter] by=${req.user?.userId || 'anonymous'}`);
        const { centerId } = req.params;
        const slots = await examService.getExamSlotsByCenter(centerId);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_SLOTS_FETCHED,
            data: slots,
        });
    }
);

/**
 * Controller: Fetch a single exam slot.
 * Route: GET /exam/slots/:id
 * Roles: ADMIN, SUPER_ADMIN
 */
export const getExamSlot = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[getExamSlot] by=${req.user?.userId || 'anonymous'}`);
        const { id } = req.params;
        const slot = await examService.getExamSlot(id);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_SLOT_FETCHED,
            data: slot,
        });
    }
);

/**
 * Controller: Update a slot's timing/capacity/status.
 * Route: PUT /exam/slots/:id
 * Roles: ADMIN, SUPER_ADMIN
 */
export const updateExamSlot = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[updateExamSlot] by=${req.user?.userId || 'anonymous'}`);
        const { id } = req.params;
        const slot = await examService.updateExamSlot(id, req.body, req.user?.userId);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_SLOT_UPDATED,
            data: slot,
        });
    }
);

/**
 * Controller: Delete an exam slot (only if not booked).
 * Route: DELETE /exam/slots/:id
 * Roles: ADMIN, SUPER_ADMIN
 */
export const deleteExamSlot = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[deleteExamSlot] by=${req.user?.userId || 'anonymous'}`);
        const { id } = req.params;
        await examService.deleteExamSlot(id);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.EXAM_SLOT_DELETED,
        });
    }
);
