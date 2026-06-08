

import { Request, Response, NextFunction } from 'express';
import prisma from '../../config/prisma';
import * as examService from './exam.service';
import logger from '../../utils/logger';
import { AdmissionStatus } from '@prisma/client';
import { Role } from '../../constants/roles';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { sendResponse } from '../../utils/response';
import { MESSAGES } from '../../constants/messages';
import fs from 'fs';

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

export const scanAttendance = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?.userId;
        if (!userId) {
            logger.warn('[scanAttendance] unauthorized attempt');
            throw new AppError(MESSAGES.ERROR.UNAUTHORIZED, 401);
        }

        const { qrHash } = req.body;

        logger.info(`[scanAttendance] user=${userId} role=${req.user?.role} scanning`);
        
        try {
            const result = await examService.markAttendanceByScan(qrHash, userId);

            const { logAttendanceOperation, AuditAction } = await import('../../utils/auditLogger');
            await logAttendanceOperation(
                AuditAction.ATTENDANCE_SCANNED,
                userId,
                result.student.id,
                result.attendanceRecordId,
                true,
                {
                    studentName: result.student.name,
                    applicationId: result.student.applicationId,
                    examCenter: result.examDetails.examCenter
                }
            );

            logger.info('[scanAttendance] student details retrieved');
            sendResponse({
                res,
                statusCode: 200,
                success: true,
                message: 'Student details retrieved for validation',
                data: result,
            });
        } catch (error: any) {

            const { logSecurityEvent, AuditAction } = await import('../../utils/auditLogger');
            await logSecurityEvent(
                AuditAction.SUSPICIOUS_ACTIVITY,
                req,
                { error: error.message, qrHash: qrHash?.substring(0, 20) + '...' }
            );
            throw error;
        }
    }
);

export const manualScan = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?.userId;
        if (!userId) {
            logger.warn('[manualScan] unauthorized attempt');
            throw new AppError(MESSAGES.ERROR.UNAUTHORIZED, 401);
        }

        const { applicationId } = req.body;

        logger.info(`[manualScan] user=${userId} role=${req.user?.role} manually scanning appId=${applicationId}`);
        
        try {
            const result = await examService.markAttendanceByApplicationId(applicationId, userId);

            const { logAttendanceOperation, AuditAction } = await import('../../utils/auditLogger');
            await logAttendanceOperation(
                AuditAction.ATTENDANCE_SCANNED,
                userId,
                result.student.id,
                result.attendanceRecordId,
                true,
                {
                    studentName: result.student.name,
                    applicationId: result.student.applicationId,
                    examCenter: result.examDetails.examCenter,
                    method: 'MANUAL_SCAN'
                }
            );

            logger.info('[manualScan] student details retrieved');
            sendResponse({
                res,
                statusCode: 200,
                success: true,
                message: 'Student details retrieved for validation',
                data: result,
            });
        } catch (error: any) {

            const { logSecurityEvent, AuditAction } = await import('../../utils/auditLogger');
            await logSecurityEvent(
                AuditAction.SUSPICIOUS_ACTIVITY,
                req,
                { error: error.message, applicationId, method: 'MANUAL_SCAN' }
            );
            throw error;
        }
    }
);

export const verifyAttendance = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const userId = req.user?.userId;
        if (!userId) {
            logger.warn('[verifyAttendance] unauthorized attempt');
            throw new AppError(MESSAGES.ERROR.UNAUTHORIZED, 401);
        }

        const { attendanceRecordId } = req.body;

        logger.info(`[verifyAttendance] user=${userId} role=${req.user?.role} verifying record=${attendanceRecordId}`);
        
        try {
            const result = await examService.verifyStudentAttendance(attendanceRecordId, userId);

            const { logAttendanceOperation, AuditAction } = await import('../../utils/auditLogger');
            await logAttendanceOperation(
                AuditAction.ATTENDANCE_VERIFIED,
                userId,
                result.studentId,
                attendanceRecordId,
                true,
                {
                    studentName: result.studentName,
                    applicationId: result.applicationId,
                    examCenter: result.examCenter,
                    verifiedAt: result.verifiedAt
                }
            );

            logger.info('[verifyAttendance] attendance verified and marked');
            sendResponse({
                res,
                statusCode: 200,
                success: true,
                message: MESSAGES.SUCCESS.ATTENDANCE_MARKED,
                data: result,
            });
        } catch (error: any) {

            const { logSecurityEvent, AuditAction } = await import('../../utils/auditLogger');
            await logSecurityEvent(
                AuditAction.ATTENDANCE_REJECTED,
                req,
                { error: error.message, attendanceRecordId }
            );
            throw error;
        }
    }
);

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

export const bookExamSlot = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[bookExamSlot] by=${req.user?.userId || 'anonymous'}`);
        const { slotId, studentId: bodyStudentId } = req.body;
        let studentId = bodyStudentId;

        if (!studentId && req.user?.role === Role.STUDENT) {
            const student = await prisma.student.findUnique({
                 where: { userId: req.user.userId }
            });
            if (!student) throw new AppError('Student profile not found', 404);
            studentId = student.id;
        }

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

export const getStudentsByStatus = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[getStudentsByStatus] by=${req.user?.userId || 'anonymous'}`);
        const { status } = req.params;

        if (!Object.values(AdmissionStatus).includes(status as any)) {
            throw new AppError(`Invalid status. Allowed: ${Object.values(AdmissionStatus).join(', ')}`, 400);
        }

        const result = await examService.getStudentsByAdmissionStatus(status as any);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: `Students with status ${status} retrieved`,
            data: result,
        });
    }
);

export const getHallTicketDetails = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[getHallTicketDetails] by=${req.user?.userId || 'anonymous'}`);
        const { studentId } = req.params;

        if (req.user?.role === Role.STUDENT) {

            const student = await prisma.student.findUnique({
                where: { userId: req.user.userId }
            });
            
            if (student?.id !== studentId) {
                 throw new AppError(MESSAGES.ERROR.UNAUTHORIZED, 403);
            }
        }

        const result = await examService.getHallTicketDetails(studentId);
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: 'Hall ticket details retrieved',
            data: result,
        });
    }
);

export const markAttendance = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[markAttendance] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[markAttendance] payload=${JSON.stringify(req.body)}`);

    const { studentId, attended } = req.body;
    
    await examService.markAttendanceManually(studentId, attended, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ATTENDANCE_MARKED
    });
});

export const updateExamScore = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateExamScore] by=${req.user?.userId || 'anonymous'}`);
    
    const { studentId, score, cutoff } = req.body;
    
    const result = await examService.updateStudentExamScore(studentId, score, cutoff, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.EXAM_SCORE_UPDATED,
        data: result
    });
});

export const uploadBulkResults = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) throw new AppError(MESSAGES.ERROR.NO_FILE_UPLOADED, 400);
    const { cutoff } = req.body;

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    
    try {
        const results = await examService.processBulkResults(fileContent, cutoff);

        const successCount = results.filter((r: any) => r.status === 'Success').length;
        const failedCount = results.filter((r: any) => r.status === 'Failed').length;
        const failedRecords = results.filter((r: any) => r.status === 'Failed');
        
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.BULK_RESULTS_PROCESSED,
            data: {
                summary: {
                    total: results.length,
                    successful: successCount,
                    failed: failedCount
                },
                failedRecords: failedRecords,
                allResults: results
            }
        });
    } finally {
        fs.unlinkSync(req.file.path);
    }
});

export const uploadBulkResultsJSON = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const records = req.body?.records;

    if (!Array.isArray(records) || records.length === 0) {
        throw new AppError('Request body must contain a non-empty "records" array', 400);
    }

    const results = await examService.processBulkResultsJSON(records);

    const successCount = results.filter((r: any) => r.result === 'Success').length;
    const failedCount = results.filter((r: any) => r.result === 'Failed').length;

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: `Processed ${results.length} records: ${successCount} success, ${failedCount} failed`,
        data: {
            summary: { total: results.length, successful: successCount, failed: failedCount },
            failedRecords: results.filter((r: any) => r.result === 'Failed'),
            successRecords: results.filter((r: any) => r.result === 'Success')
        }
    });
});
