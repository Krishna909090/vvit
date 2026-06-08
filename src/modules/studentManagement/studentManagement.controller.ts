import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { recomputeStudentTotals } from '../../utils/studentContext';
import { AdminStudentService } from './adminStudent.service';
import * as StudentService from '../student/student.service';
import prisma from '../../config/prisma';
import { Role } from '../../constants/roles';
import { assertPricingOverrideAllowed } from '../../middleware/rbac.middleware';
import { AuditAction, getClientIp } from '../../utils/auditLogger';
import fs from 'fs';
import path from 'path';

export const exportApplicationsCsv = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[exportApplicationsCsv] by=${req.user?.userId || 'anonymous'}`);
    const csv = await AdminStudentService.exportApplicationsCsv(req.query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=applications.csv');
    res.send(csv);
});

export const getAllApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getAllApplications] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[getAllApplications] query=${JSON.stringify(req.query)}`);

    const result = await AdminStudentService.getAllApplications(req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const getApplicationsExtended = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getApplicationsExtended] by=${req.user?.userId || 'anonymous'}`);
    const result = await AdminStudentService.getApplicationsExtended(req.query);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const uploadBulkApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[uploadBulkApplications] by=${req.user?.userId || 'anonymous'}`);

    if (!req.file) {
        logger.warn('[uploadBulkApplications] no file uploaded');
        throw new AppError(MESSAGES.ERROR.NO_FILE_UPLOADED, 400);
    }

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    
    try {
        const results = await AdminStudentService.processBulkApplications(fileContent, req.user?.userId);
        
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.BULK_UPLOAD_PROCESSED,
            data: results
        });
    } finally {
        try {
            fs.unlinkSync(req.file.path);
        } catch (e) {
            logger.warn(`[uploadBulkApplications] failed to delete temp file: ${e}`);
        }
    }
});

export const requestCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestCancellation] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, reason, refundAmount } = req.body;
    
    const cancellation = await AdminStudentService.requestCancellation(studentId, reason, refundAmount);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.CANCELLATION_REQUESTED,
        data: cancellation
    });
});

export const approveCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveCancellation] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, approved } = req.body;

    await AdminStudentService.approveCancellation(requestId, approved, req.user?.role, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: approved ? MESSAGES.SUCCESS.CANCELLATION_APPROVED : MESSAGES.SUCCESS.CANCELLATION_REJECTED
    });
});

export const verifyAndAllotSeat = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[verifyAndAllotSeat] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, approved, allottedCourseId, scholarshipPercentage } = req.body;

    const result = await AdminStudentService.verifyAndAllotSeat(studentId, approved, allottedCourseId, req.user?.userId, scholarshipPercentage);

    sendResponse({
        res,
        statusCode: 200,
        success: result.success,
        message: result.message
    });
});

export const reUploadDocument = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { documentKey, url } = req.body;

    if (!documentKey || !url) throw new AppError('documentKey and url are required', 400);

    const doc = await StudentService.reUploadDocument(studentId, documentKey, url);

    logger.info(`[admin.reUploadDocument] studentId=${studentId} documentKey=${documentKey}`);
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FILE_UPLOADED, data: doc });
});

export const verifyStudentDocument = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { documentKey, status, remarks } = req.body;

    const doc = await AdminStudentService.verifyStudentDocument(studentId, documentKey, status, remarks);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DOCUMENT_VERIFIED,
        data: doc
    });
});

export const requestCourseChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestCourseChange] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, newCourseId, reason } = req.body;
    
    const request = await AdminStudentService.requestCourseChange(studentId, newCourseId, reason);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.COURSE_CHANGE_FORWARDED,
        data: request
    });
});

export const requestBranchChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestBranchChange] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, newCourseId, reason, recommendedByManagement, branchChangeFee } = req.body;

    const request = await AdminStudentService.requestBranchChange(studentId, newCourseId, reason, recommendedByManagement, branchChangeFee);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Branch change request forwarded for approval',
        data: request
    });
});

export const requestProgramChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestProgramChange] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, newCourseId, reason } = req.body;

    const request = await AdminStudentService.requestProgramChange(studentId, newCourseId, reason);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Program change request forwarded for approval',
        data: request
    });
});

export const approveCourseChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveCourseChange] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, approved, recommendedByManagement, branchChangeFee } = req.body;

    await AdminStudentService.approveCourseChange(requestId, approved, req.user?.role, req.user?.userId, recommendedByManagement, branchChangeFee);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.COURSE_CHANGE_PROCESSED
    });
});

export const debugCourseAllotments = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[debugCourseAllotments] by=${req.user?.userId || 'anonymous'}`);
    const { courseId } = req.params;
    const result = await AdminStudentService.debugCourseAllotments(courseId);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Debug data fetched',
        data: result
    });
});

export const getCourseChangeRequests = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getCourseChangeRequests] by=${req.user?.userId || 'anonymous'}`);

    const result = await AdminStudentService.getCourseChangeRequests(req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const updateAdmissionDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateAdmissionDetails] by=${req.user?.userId || 'anonymous'}`);

    await AdminStudentService.updateAdmissionDetails(req.body, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ADMISSION_DETAILS_UPDATED
    });
});

export const bulkAllocateRoomBeds = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { roomId, studentIds, academicYearId } = req.body;
    logger.info(`[bulkAllocateRoomBeds] roomId=${roomId} count=${studentIds?.length} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot bulk-allocate beds', 403);
    }

    const result = await AdminStudentService.bulkAllocateRoomBeds(
        roomId, studentIds, academicYearId, req.user?.userId
    );

    sendResponse({
        res,
        statusCode: result.success ? 200 : 400,
        success: result.success,
        message: result.success
            ? `Allocated ${result.allocated} student(s) to room ${result.roomNumber}`
            : 'Pre-validation failed — no students were allocated',
        data: result
    });
});

export const reassignHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { hostelId, bedId, hostelPaymentMode, reason, customPricing } = req.body;
    logger.info(`[reassignHostel] studentId=${studentId} hostelId=${hostelId} bedId=${bedId} mode=${hostelPaymentMode} custom=${customPricing ? 'yes' : 'no'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot reassign their own hostel', 403);
    }
    assertPricingOverrideAllowed(req, !!customPricing);

    const result = await AdminStudentService.reassignHostel(
        studentId,
        { hostelId, bedId, hostelPaymentMode, reason, customPricing },
        req.user?.userId
    );

    await recomputeStudentTotals(studentId).catch(err => logger.error(`[reassignHostel] totals recompute failed for ${studentId}: ${err}`));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Hostel re-assigned successfully',
        data: result
    });
});

export const allocateBed = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { bedId, hostelId, academicYearId } = req.body;
    logger.info(`[allocateBed] studentId=${studentId} bedId=${bedId} hostelId=${hostelId ?? 'unset'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot allocate their own bed', 403);
    }

    const result = await AdminStudentService.allocateBed(studentId, bedId, hostelId, academicYearId, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Bed allocated successfully',
        data: result
    });
});

export const getPendingHostelAllocations = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getPendingHostelAllocations] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[getPendingHostelAllocations] query=${JSON.stringify(req.query)}`);

    const result = await AdminStudentService.getPendingHostelAllocations(req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const getTransportAllocatedStudents = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getTransportAllocatedStudents] by=${req.user?.userId || 'anonymous'}`);
    const result = await AdminStudentService.getTransportAllocatedStudents(req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const getBedAllocatedStudents = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getBedAllocatedStudents] by=${req.user?.userId || 'anonymous'}`);
    const result = await AdminStudentService.getBedAllocatedStudents(req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const getHostelPaidStudents = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getHostelPaidStudents] by=${req.user?.userId || 'anonymous'}`);
    const result = await AdminStudentService.getHostelPaidStudents(req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const getTransportPaidStudents = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getTransportPaidStudents] by=${req.user?.userId || 'anonymous'}`);
    const result = await AdminStudentService.getTransportPaidStudents(req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const getStudentsByHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { hostelId } = req.params;
    logger.info(`[getStudentsByHostel] hostelId=${hostelId} by=${req.user?.userId || 'anonymous'}`);

    const result = await AdminStudentService.getStudentsByHostel(hostelId, req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const switchHostelToTransport = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { withhold, cancellationFee, chargeRetained, reason, transportRouteId, customCost } = req.body;
    logger.info(`[switchHostelToTransport] studentId=${studentId} routeId=${transportRouteId} withhold=${withhold ? JSON.stringify(withhold) : 'none'} cancellationFee=${cancellationFee} chargeRetained=${chargeRetained} custom=${customCost != null ? 'yes' : 'no'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot switch their own accommodation', 403);
    }
    assertPricingOverrideAllowed(req, customCost != null);

    const result = await AdminStudentService.switchHostelToTransport(
        studentId,
        { withhold, cancellationFee, chargeRetained, reason, transportRouteId, customCost },
        req.user?.userId
    );

    await recomputeStudentTotals(studentId).catch(err => logger.error(`[switchHostelToTransport] totals recompute failed for ${studentId}: ${err}`));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Switched from hostel to transport',
        data: result
    });
});

export const switchTransportToHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { chargeRetained, reason, hostelId, hostelType, hostelPaymentMode, customPricing } = req.body;
    logger.info(`[switchTransportToHostel] studentId=${studentId} hostelId=${hostelId} type=${hostelType} mode=${hostelPaymentMode} chargeRetained=${chargeRetained} custom=${customPricing ? 'yes' : 'no'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot switch their own accommodation', 403);
    }
    assertPricingOverrideAllowed(req, !!customPricing);

    const result = await AdminStudentService.switchTransportToHostel(
        studentId,
        { chargeRetained, reason, hostelId, hostelType, hostelPaymentMode, customPricing },
        req.user?.userId
    );

    await recomputeStudentTotals(studentId).catch(err => logger.error(`[switchTransportToHostel] totals recompute failed for ${studentId}: ${err}`));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Switched from transport to hostel',
        data: result
    });
});

export const previewReassignHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { hostelId, bedId, hostelPaymentMode, customPricing } = req.body;
    logger.info(`[previewReassignHostel] studentId=${studentId} hostelId=${hostelId} bedId=${bedId} mode=${hostelPaymentMode} custom=${customPricing ? 'yes' : 'no'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot reassign their own hostel', 403);
    }
    assertPricingOverrideAllowed(req, !!customPricing);

    const result = await AdminStudentService.previewReassignHostel(studentId, { hostelId, bedId, hostelPaymentMode, customPricing });

    sendResponse({ res, statusCode: 200, success: true, message: 'Hostel re-assignment preview', data: result });
});

export const previewCancelHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { cancellationFee, withhold } = req.body;
    logger.info(`[previewCancelHostel] studentId=${studentId} cancellationFee=${cancellationFee} withhold=${withhold ? JSON.stringify(withhold) : 'none'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot cancel their own hostel', 403);
    }

    const result = await AdminStudentService.previewCancelHostel(studentId, { cancellationFee, withhold });

    sendResponse({ res, statusCode: 200, success: true, message: 'Hostel cancellation preview', data: result });
});

export const previewCancelTransport = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { cancellationFee } = req.body;
    logger.info(`[previewCancelTransport] studentId=${studentId} cancellationFee=${cancellationFee} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot cancel their own transport', 403);
    }

    const result = await AdminStudentService.previewCancelTransport(studentId, { cancellationFee });

    sendResponse({ res, statusCode: 200, success: true, message: 'Transport cancellation preview', data: result });
});

export const previewSwitchHostelToTransport = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { chargeRetained, transportRouteId, customCost } = req.body;
    logger.info(`[previewSwitchHostelToTransport] studentId=${studentId} routeId=${transportRouteId} chargeRetained=${chargeRetained} custom=${customCost != null ? 'yes' : 'no'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot switch their own accommodation', 403);
    }
    assertPricingOverrideAllowed(req, customCost != null);

    const result = await AdminStudentService.previewSwitchHostelToTransport(studentId, { chargeRetained, transportRouteId, customCost });

    sendResponse({ res, statusCode: 200, success: true, message: 'Hostel→Transport switch preview', data: result });
});

export const previewSwitchTransportToHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { chargeRetained, hostelId, hostelType, hostelPaymentMode, customPricing } = req.body;
    logger.info(`[previewSwitchTransportToHostel] studentId=${studentId} hostelId=${hostelId} type=${hostelType} mode=${hostelPaymentMode} chargeRetained=${chargeRetained} custom=${customPricing ? 'yes' : 'no'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot switch their own accommodation', 403);
    }
    assertPricingOverrideAllowed(req, !!customPricing);

    const result = await AdminStudentService.previewSwitchTransportToHostel(studentId, { chargeRetained, hostelId, hostelType, hostelPaymentMode, customPricing });

    sendResponse({ res, statusCode: 200, success: true, message: 'Transport→Hostel switch preview', data: result });
});

export const cancelHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { cancellationFee, withhold, reason } = req.body;
    logger.info(`[cancelHostel] studentId=${studentId} cancellationFee=${cancellationFee} withhold=${withhold ? JSON.stringify(withhold) : 'none'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot cancel their own hostel', 403);
    }

    const result = await AdminStudentService.cancelHostel(
        studentId,
        { cancellationFee, withhold, reason },
        req.user?.userId
    );

    await recomputeStudentTotals(studentId).catch(err => logger.error(`[cancelHostel] totals recompute failed for ${studentId}: ${err}`));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Hostel cancelled successfully',
        data: result
    });
});

export const cancelTransport = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { withhold, cancellationFee, reason } = req.body;
    logger.info(`[cancelTransport] studentId=${studentId} withhold=${withhold} cancellationFee=${cancellationFee} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot cancel their own transport', 403);
    }

    const result = await AdminStudentService.cancelTransport(
        studentId,
        { withhold, cancellationFee, reason },
        req.user?.userId
    );

    await recomputeStudentTotals(studentId).catch(err => logger.error(`[cancelTransport] totals recompute failed for ${studentId}: ${err}`));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Transport cancelled successfully',
        data: result
    });
});

export const reassignTransport = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { transportRouteId, reason, customCost } = req.body;
    logger.info(`[reassignTransport] studentId=${studentId} newRouteId=${transportRouteId} custom=${customCost != null ? 'yes' : 'no'} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot reassign transport', 403);
    }
    assertPricingOverrideAllowed(req, customCost != null);

    const result = await AdminStudentService.reassignTransport(
        studentId,
        { transportRouteId, reason, customCost },
        req.user?.userId
    );

    await recomputeStudentTotals(studentId).catch(err => logger.error(`[reassignTransport] totals recompute failed for ${studentId}: ${err}`));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Transport reassigned successfully',
        data: result
    });
});

export const assignTransport = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { transportRouteId, customCost } = req.body;
    logger.info(`[assignTransport] studentId=${studentId} routeId=${transportRouteId} custom=${customCost != null ? 'yes' : 'no'} by=${req.user?.userId || 'anonymous'} role=${req.user?.role || 'unknown'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot assign their own transport', 403);
    }
    assertPricingOverrideAllowed(req, customCost != null);

    const result = await AdminStudentService.assignTransport(studentId, transportRouteId, req.user?.userId, customCost);

    await recomputeStudentTotals(studentId).catch(err => logger.error(`[assignTransport] totals recompute failed for ${studentId}: ${err}`));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Transport assigned successfully',
        data: result
    });
});

export const getAvailableBeds = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { hostelId } = req.params;
    const { sharing, roomType, floor } = req.query as any;

    const result = await AdminStudentService.getAvailableBeds(hostelId, {
        sharing: sharing !== undefined ? Number(sharing) : undefined,
        roomType: roomType ? String(roomType).toUpperCase() : undefined,
        floor: floor !== undefined ? Number(floor) : undefined
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: result
    });
});

export const assignHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { hostelId, hostelPaymentMode, hostelType, customPricing } = req.body;
    logger.info(`[assignHostel] studentId=${studentId} hostelId=${hostelId ?? 'unset'} mode=${hostelPaymentMode} type=${hostelType ?? 'unset'} custom=${customPricing ? 'yes' : 'no'} by=${req.user?.userId || 'anonymous'} role=${req.user?.role || 'unknown'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot assign their own hostel', 403);
    }
    assertPricingOverrideAllowed(req, !!customPricing);

    const updated = await AdminStudentService.assignHostel(
        studentId,
        hostelId,
        hostelPaymentMode,
        hostelType,
        req.user?.userId,
        customPricing
    );

    await recomputeStudentTotals(studentId).catch(err => logger.error(`[assignHostel] totals recompute failed for ${studentId}: ${err}`));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Hostel assigned successfully',
        data: updated
    });
});

export const updateHostelId = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { studentId } = req.params;
    const { hostelId } = req.body;
    logger.info(`[updateHostelId] studentId=${studentId} hostelId=${hostelId} by=${req.user?.userId || 'anonymous'}`);

    const result = await AdminStudentService.updateHostelId(studentId, hostelId, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Hostel ID updated successfully',
        data: result,
    });
});

export const getStudentCertificates = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    
    const docs = await AdminStudentService.getStudentCertificates(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: docs
    });
});

export const downloadStudentDocuments = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    
    const zipFilePath = await AdminStudentService.generateStudentDocumentsZip(studentId);
    const zipFileName = path.basename(zipFilePath);

    res.download(zipFilePath, zipFileName, (err) => {
        if (err) logger.error(`Download error: ${err}`);
        try {
            fs.unlinkSync(zipFilePath); 
        } catch (e) {
            logger.warn(`Failed to delete zip file: ${zipFilePath}`);
        }
    });
});

export const downloadApplication = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;

    const pdfBuffer = await AdminStudentService.downloadApplication(studentId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=application_${studentId}.pdf`);
    res.send(pdfBuffer);
});

export const updateRollNumber = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateRollNumber] by=${req.user?.userId || 'anonymous'}`);
    const { studentId, rollNumber, sectionId, academicYearId } = req.body;
    
    const result = await AdminStudentService.updateRollNumber(studentId, rollNumber, sectionId, academicYearId, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Roll Number Updated Successfully",
        data: result
    });
});

export const updateStudentStatus = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateStudentStatus] by=${req.user?.userId || 'anonymous'}`);
    const { studentId, status } = req.body;
    
    const result = await AdminStudentService.updateStudentAdmissionStatus(studentId, status, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message
    });
});

export const setScholarshipEligibility = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[setScholarshipEligibility] by=${req.user?.userId || 'anonymous'}`);
    const { studentId, ruleId } = req.body;
    
    await AdminStudentService.setScholarshipEligibility(studentId, ruleId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Scholarship eligibility updated successfully'
    });
});

export const updateStudentPersonalDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateStudentPersonalDetails] by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        if (!req.user.userId) throw new AppError('User ID missing', 400);

        const student = await StudentService.getStudentByUserId(req.user.userId);
        if (!student) {
            throw new AppError('Student profile not found for this user', 404);
        }

        req.body.studentId = student.id;
    }

    const { studentId, ...updateData } = req.body;

    const result = await AdminStudentService.updateStudentPersonalDetails(studentId, updateData, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message,
        data: result.profilePhotoUrl ? { profilePhotoUrl: result.profilePhotoUrl } : undefined
    });
});

export const getStudentDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;

    const data = await AdminStudentService.getStudentDetails(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data
    });
});

export const getStudentDetailsByApplicationId = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { applicationId } = req.params;

    const data = await AdminStudentService.getStudentDetailsByApplicationId(applicationId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data
    });
});

export const updateAcademicQualification = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateAcademicQualification] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;

    if (req.user?.role === Role.STUDENT) {
        if (!req.user.userId) throw new AppError('User ID missing', 400);

        const student = await StudentService.getStudentByUserId(req.user.userId);
        if (!student) {
            throw new AppError('Student profile not found', 404);
        }

        const qualification = await prisma.academicQualification.findUnique({
            where: { id }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        if (qualification.studentId !== student.id) {
            logger.warn(`[Security] Student ${student.id} tried to update qualification ${id} belonging to ${qualification.studentId}`);
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
    }

    const { ...updateData } = req.body;

    const result = await AdminStudentService.updateAcademicQualification(id, updateData, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Academic qualification updated successfully',
        data: result
    });
});

export const deleteAcademicQualification = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[deleteAcademicQualification] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;

    if (req.user?.role === Role.STUDENT) {
        if (!req.user.userId) throw new AppError('User ID missing', 400);

        const student = await StudentService.getStudentByUserId(req.user.userId);
        if (!student) {
            throw new AppError('Student profile not found', 404);
        }

        const qualification = await prisma.academicQualification.findUnique({
            where: { id }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        if (qualification.studentId !== student.id) {
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
    }

    const result = await AdminStudentService.deleteAcademicQualification(id);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message
    });
});

export const validateAcademicQualification = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[validateAcademicQualification] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;
    const { status, remarks } = req.body;

    const result = await AdminStudentService.validateAcademicQualification(id, status, remarks, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message
    });
});

export const updateStudentScholarship = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateStudentScholarship] by=${req.user?.userId || 'anonymous'}`);
    const { studentId } = req.body;

    const result = await AdminStudentService.updateStudentScholarship(studentId, req.body, req.user?.userId, req.user?.role);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Student scholarship updated successfully',
        data: result
    });
});

export const getStudentScholarships = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getStudentScholarships] by=${req.user?.userId || 'anonymous'}`);
    const { studentId } = req.params;

    const results = await AdminStudentService.getStudentScholarships(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: results
    });
});

export const getScholarshipStats = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getScholarshipStats] by=${req.user?.userId || 'anonymous'}`);

    const stats = await AdminStudentService.getScholarshipStats();

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: stats
    });
});

export const editStudentScholarship = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[editStudentScholarship] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;

    const result = await AdminStudentService.editStudentScholarship(id, req.body, req.user?.userId, req.user?.role);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Student scholarship updated successfully',
        data: result
    });
});

export const reconcileStudentFees = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[reconcileStudentFees] by=${req.user?.userId || 'anonymous'}`);
    const { studentId } = req.params;
    const result = await AdminStudentService.reconcileStudentFees(studentId, req.user?.userId, req.user?.role);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Fee reconciliation complete',
        data: result,
    });
});

export const finalizeAdmission = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[finalizeAdmission] by=${req.user?.userId || 'anonymous'}`);

    const result = await AdminStudentService.finalizeAdmission(req.body, req.user?.userId!);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: result.message,
        data: result
    });
});

export const manualEntryAdmission = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[manualEntryAdmission] by=${req.user?.userId || 'anonymous'} entryType=${req.body?.entry?.type ?? 'REGULAR'} yearOfStudy=${req.body?.entry?.yearOfStudy ?? 1}`);

    const result = await AdminStudentService.manualEntryAdmission(req.body, req.user?.userId!);

    res.status(201).json({
        success: true,
        message: 'Manual entry admission completed successfully',
        data: result,
    });
});

export const assignEnrollment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { rollNumber, sectionId, currentSemester, yearOfStudy, seedFeeDemands } = req.body;
    logger.info(
        `[assignEnrollment] by=${req.user?.userId || 'anonymous'} studentId=${studentId} ` +
        `roll=${rollNumber} sectionId=${sectionId}`
    );

    const result = await AdminStudentService.assignEnrollment(
        studentId,
        rollNumber,
        sectionId,
        req.user!.userId,
        { currentSemester, yearOfStudy, seedFeeDemands },
    );

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: `Roll number ${rollNumber} assigned and enrollment created`,
        data: result,
    });
});

export const verifyPayment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[verifyPayment] by=${req.user?.userId || 'anonymous'}`);

    const { paymentId } = req.body;
    const result = await AdminStudentService.verifyAndCompletePayment(paymentId, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result?.message,
        data: result
    });
});

export const getAdmissionInvoice = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getAdmissionInvoice] by=${req.user?.userId || 'anonymous'}`);
    const { studentId } = req.params;

    if (req.user?.role === Role.STUDENT) {

        const userStudent = await StudentService.getStudentByUserId(req.user.userId!);
        if (userStudent && userStudent.id !== studentId) {
             throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
    }

    const result = await AdminStudentService.getAdmissionInvoice(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const sendStatusEmail = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[sendStatusEmail] by=${req.user?.userId || 'anonymous'}`);

    const result = await AdminStudentService.sendStatusEmail(req.body);

    sendResponse({
        res,
        statusCode: 200,
        success: result.success,
        message: 'Email sent successfully'
    });
});

export const reverseAdmissionPayment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[reverseAdmissionPayment] by=${req.user?.userId || 'anonymous'}`);

    const { paymentId, reason } = req.body;

    if (!paymentId) {
        throw new AppError('paymentId is required', 400);
    }

    const result = await AdminStudentService.reverseAdmissionPayment(
        paymentId,
        req.user?.userId!,
        reason
    );

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message,
        data: result.reversed
    });
});

export const getFinancialApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getFinancialApplications] by=${req.user?.userId || 'anonymous'}`);
    const result = await AdminStudentService.getFinancialApplications(req.query);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

export const updateSeatAllotedBy = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { studentId, seatAllotedBy } = req.body;
    const result = await AdminStudentService.updateSeatAllotedBy(studentId, seatAllotedBy, req.user?.userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'seatAllotedBy updated successfully', data: result });
});

export const assignPro = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, proNumber } = req.body;

    const proRecord = await prisma.pRO.findUnique({ where: { proNumber } });
    if (!proRecord) {
        throw new AppError('PRO not found with the given proNumber', 404);
    }

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) {
        throw new AppError('Student not found', 404);
    }

    const updatedStudent = await prisma.student.update({
        where: { id: studentId },
        data: { proId: proRecord.id }
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'PRO assigned to student successfully',
        data: { studentId: updatedStudent.id, proId: updatedStudent.proId, proNumber }
    });
});

export const editPro = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, proNumber } = req.body;

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) {
        throw new AppError('Student not found', 404);
    }

    if (!proNumber) {

        const updatedStudent = await prisma.student.update({
            where: { id: studentId },
            data: { proId: null }
        });

        return sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: 'PRO removed from student successfully',
            data: { studentId: updatedStudent.id, proId: null, proNumber: null }
        });
    }

    const proRecord = await prisma.pRO.findUnique({ where: { proNumber } });
    if (!proRecord) {
        throw new AppError('PRO not found with the given proNumber', 404);
    }

    const updatedStudent = await prisma.student.update({
        where: { id: studentId },
        data: { proId: proRecord.id }
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'PRO updated for student successfully',
        data: { studentId: updatedStudent.id, proId: updatedStudent.proId, proNumber }
    });
});

export const addToWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.addToWaitingList(req.body, req.user!.userId);
    sendResponse({ res, statusCode: 201, success: true, message: 'Student added to waiting list', data: result });
});

export const getWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.getWaitingList(req.query as any);
    sendResponse({ res, statusCode: 200, success: true, message: 'Waiting list fetched', data: result });
});

export const exportWaitingListExcel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[exportWaitingListExcel] by=${req.user?.userId || 'anonymous'} query=${JSON.stringify(req.query)}`);
    const buffer = await AdminStudentService.exportWaitingListExcel(req.query as any);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=waiting-list.xlsx');
    res.send(buffer);
});

export const getWaitingListEntry = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.getWaitingListEntry(req.params.waitingListId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Waiting list entry fetched', data: result });
});

export const getStudentWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.getStudentWaitingList(req.params.studentId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Student waiting list fetched', data: result });
});

export const allotFromWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.allotFromWaitingList(req.body.waitingListId, req.body.allocation, req.user!.userId);
    sendResponse({ res, statusCode: 200, success: true, message: `Seat allotted to ${result.studentName} in ${result.courseName}`, data: result });
});

export const removeFromWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.removeFromWaitingList(req.body, req.user!.userId);
    sendResponse({ res, statusCode: 200, success: true, message: `${result.cancelled} entries removed from waiting list`, data: result });
});

export const getRetainedRevenue = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { studentId } = req.params;
    const { category, sourceType } = req.query as { category?: string; sourceType?: string };

    const lineWhere: any = { studentId };
    if (category)   lineWhere.category   = category;
    if (sourceType) lineWhere.sourceType = sourceType;

    const [corrections, lines] = await Promise.all([
        prisma.feeCorrection.findMany({
            where: { studentId },
            orderBy: { createdAt: 'desc' },
            select: {
                id:                true,
                studentId:         true,
                academicYearId:    true,
                amount:            true,
                retainedAmount:    true,
                retentionBreakdown: true,
                reason:            true,
                type:              true,
                referenceId:       true,
                referenceType:     true,
                isSettled:         true,
                settledAt:         true,
                settledBy:         true,
                createdAt:         true,
                createdBy:         true,
            },
        }),
        prisma.retainedRevenueLine.findMany({
            where: lineWhere,
            orderBy: { occurredAt: 'desc' },
            select: {
                id:             true,
                studentId:      true,
                category:       true,
                sourceType:     true,
                sourceId:       true,
                amount:         true,
                academicYearId: true,
                hostelId:       true,
                routeId:        true,
                occurredAt:     true,
                createdAt:      true,
            },
        }),
    ]);

    const linesBySourceId = lines.reduce<Record<string, typeof lines>>((acc, l) => {
        (acc[l.sourceId] ??= []).push(l);
        return acc;
    }, {});

    const data = corrections.map(fc => ({
        ...fc,
        retainedLines: linesBySourceId[fc.id] ?? [],
    }));

    sendResponse({ res, statusCode: 200, success: true, data });
});

export const purgeStudentByApplicationId = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { applicationId } = req.params;
    const adminId = req.user?.userId;
    if (!adminId) throw new AppError('Unauthorized', 401);

    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] ?? 'unknown';

    // ── 1. Resolve student ──────────────────────────────────────────────────
    const student = await prisma.student.findUnique({
        where: { applicationId },
        select: {
            id: true, userId: true, name: true, phone: true, email: true,
            applicationId: true, category: true, source: true, quotaType: true,
            degreeType: true, createdAt: true,
        },
    });
    if (!student) throw new AppError(`No student found with applicationId=${applicationId}`, 404);

    const studentId = student.id;
    const userId    = student.userId;

    // ── 1b. Block purge if the student has any enrollment record ────────────
    const enrollmentCount = await prisma.studentEnrollment.count({ where: { studentId } });
    if (enrollmentCount > 0) {
        throw new AppError(
            `Cannot purge student ${applicationId}: student has ${enrollmentCount} enrollment record(s). Remove enrollments before purging.`,
            409,
        );
    }

    // ── 2. Snapshot financial & identity data before anything is deleted ────
    const [payments, feeDemands, feeCorrections, ledgerEntries, admission, userRecord] = await Promise.all([
        prisma.payment.findMany({ where: { studentId } }),
        prisma.studentFeeDemand.findMany({ where: { studentId } }),
        prisma.feeCorrection.findMany({ where: { studentId } }),
        prisma.studentLedger.findMany({ where: { studentId } }),
        prisma.studentAdmission.findFirst({ where: { studentId } }),
        userId
            ? prisma.user.findUnique({
                where: { id: userId },
                select: { id: true, phone: true, email: true, role: true, createdAt: true },
            })
            : Promise.resolve(null),
    ]);

    logger.warn(
        `[purgeStudent] PURGE initiated applicationId=${applicationId} studentId=${studentId}` +
        ` by admin=${adminId} payments=${payments.length} demands=${feeDemands.length} corrections=${feeCorrections.length}`,
    );

    const counts: Record<string, number> = {};
    const now = new Date();

    await prisma.$transaction(async (tx) => {

        // ── 3. Per-record audit logs for every Payment ──────────────────────
        if (payments.length > 0) {
            await tx.auditLog.createMany({
                data: payments.map(p => ({
                    userId:    adminId,
                    action:    AuditAction.PAYMENT_HARD_DELETED,
                    entity:    'Payment',
                    entityId:  p.id,
                    ipAddress,
                    userAgent,
                    timestamp: now,
                    details: {
                        studentId, applicationId,
                        amount:          p.amount,
                        component:       p.component,
                        status:          p.status,
                        method:          p.method,
                        mode:            p.mode,
                        feeDemandId:     p.feeDemandId,
                        feeHeadId:       p.feeHeadId,
                        providerTxId:    p.providerTxId,
                        referenceNumber: p.referenceNumber,
                        idempotencyKey:  p.idempotencyKey,
                        collectedBy:     p.collectedBy,
                        academicYearId:  p.academicYearId,
                        createdAt:       p.createdAt,
                    },
                })),
            });
        }

        // ── 4. Per-record audit logs for every StudentFeeDemand ─────────────
        if (feeDemands.length > 0) {
            await tx.auditLog.createMany({
                data: feeDemands.map(d => ({
                    userId:    adminId,
                    action:    AuditAction.FEE_DEMAND_HARD_DELETED,
                    entity:    'StudentFeeDemand',
                    entityId:  d.id,
                    ipAddress,
                    userAgent,
                    timestamp: now,
                    details: {
                        studentId, applicationId,
                        amount:            d.amount,
                        netAmount:         d.netAmount,
                        status:            d.status,
                        dueDate:           d.dueDate,
                        feeHeadId:         d.feeHeadId,
                        feeStructureId:    d.feeStructureId,
                        discountAmount:    d.discountAmount,
                        scholarshipAmount: d.scholarshipAmount,
                        fineAmount:        d.fineAmount,
                        academicYearId:    d.academicYearId,
                        createdAt:         d.createdAt,
                    },
                })),
            });
        }

        // ── 5. Per-record audit logs for every FeeCorrection ────────────────
        if (feeCorrections.length > 0) {
            await tx.auditLog.createMany({
                data: feeCorrections.map(fc => ({
                    userId:    adminId,
                    action:    AuditAction.FEE_CORRECTION_HARD_DELETED,
                    entity:    'FeeCorrection',
                    entityId:  fc.id,
                    ipAddress,
                    userAgent,
                    timestamp: now,
                    details: {
                        studentId, applicationId,
                        amount:             fc.amount,
                        retainedAmount:     fc.retainedAmount,
                        retentionBreakdown: fc.retentionBreakdown,
                        type:               fc.type,
                        reason:             fc.reason,
                        referenceType:      fc.referenceType,
                        referenceId:        fc.referenceId,
                        isSettled:          fc.isSettled,
                        settledAt:          fc.settledAt,
                        settledBy:          fc.settledBy,
                        academicYearId:     fc.academicYearId,
                        createdAt:          fc.createdAt,
                    },
                })),
            });
        }

        // ── 6. Per-record audit logs for every StudentLedger entry ──────────
        if (ledgerEntries.length > 0) {
            await tx.auditLog.createMany({
                data: ledgerEntries.map(l => ({
                    userId:    adminId,
                    action:    AuditAction.LEDGER_ENTRY_HARD_DELETED,
                    entity:    'StudentLedger',
                    entityId:  l.id,
                    ipAddress,
                    userAgent,
                    timestamp: now,
                    details: {
                        studentId, applicationId,
                        type:          l.type,
                        amount:        l.amount,
                        description:   l.description,
                        referenceType: l.referenceType,
                        referenceId:   l.referenceId,
                        feeHeadId:     l.feeHeadId,
                        academicYearId: l.academicYearId,
                        date:          l.date,
                    },
                })),
            });
        }

        // ── 7. Master audit log — full snapshot of the student being erased ─
        await tx.auditLog.create({
            data: {
                userId:    adminId,
                action:    AuditAction.STUDENT_PURGED,
                entity:    'Student',
                entityId:  studentId,
                ipAddress,
                userAgent,
                timestamp: now,
                details: {
                    applicationId,
                    studentSnapshot: {
                        id:          student.id,
                        name:        student.name,
                        phone:       student.phone,
                        email:       student.email,
                        category:    student.category,
                        source:      student.source,
                        quotaType:   student.quotaType,
                        degreeType:  student.degreeType,
                        createdAt:   student.createdAt,
                    },
                    admissionSnapshot: admission ? {
                        status:              admission.status,
                        allottedCourseId:    admission.allottedCourseId,
                        accommodationType:   admission.accommodationType,
                        totalFee:            admission.totalFee,
                        paidFee:             admission.paidFee,
                        feeStatus:           admission.feeStatus,
                        academicYearId:      admission.academicYearId,
                        entryType:           admission.entryType,
                    } : null,
                    linkedUserId:       userId,
                    linkedUserSnapshot: userRecord,
                    financialSummary: {
                        paymentCount:       payments.length,
                        successPaymentCount: payments.filter(p => p.status === 'SUCCESS').length,
                        totalSuccessPaid:   payments
                            .filter(p => p.status === 'SUCCESS')
                            .reduce((s, p) => s + p.amount, 0),
                        feeDemandCount:     feeDemands.length,
                        feeCorrectionCount: feeCorrections.length,
                        ledgerEntryCount:   ledgerEntries.length,
                    },
                    purgedBy: adminId,
                },
            },
        });

        // ── 8. Hard-delete all records in FK-safe order ─────────────────────

        // ── Hard-delete via raw SQL to bypass the soft-delete middleware ────────
        // The Prisma middleware converts deleteMany → updateMany(isDeleted:true)
        // for any model with an isDeleted field, so we use $executeRaw here.

        // Leaf tables (nothing FKs into them by studentId)
        counts.classAttendance             = await tx.$executeRaw`DELETE FROM "ClassAttendance"             WHERE "studentId" = ${studentId}`;
        counts.semesterMark                = await tx.$executeRaw`DELETE FROM "SemesterMark"                WHERE "studentId" = ${studentId}`;
        counts.attendanceRecord            = await tx.$executeRaw`DELETE FROM "AttendanceRecord"            WHERE "studentId" = ${studentId}`;
        counts.seatAllocation              = await tx.$executeRaw`DELETE FROM "SeatAllocation"              WHERE "studentId" = ${studentId}`;
        counts.courseChangeLog             = await tx.$executeRaw`DELETE FROM "CourseChangeLog"             WHERE "studentId" = ${studentId}`;
        counts.courseChangeRequest         = await tx.$executeRaw`DELETE FROM "CourseChangeRequest"         WHERE "studentId" = ${studentId}`;
        counts.discountRequest             = await tx.$executeRaw`DELETE FROM "DiscountRequest"             WHERE "studentId" = ${studentId}`;
        counts.hallTicket                  = await tx.$executeRaw`DELETE FROM "HallTicket"                  WHERE "studentId" = ${studentId}`;
        counts.fileUpload                  = await tx.$executeRaw`DELETE FROM "FileUpload"                  WHERE "studentId" = ${studentId}`;
        counts.serviceChangeRequest        = await tx.$executeRaw`DELETE FROM "ServiceChangeRequest"        WHERE "studentId" = ${studentId}`;
        counts.waitingList                 = await tx.$executeRaw`DELETE FROM "WaitingList"                 WHERE "studentId" = ${studentId}`;
        counts.agentCommission             = await tx.$executeRaw`DELETE FROM "AgentCommission"             WHERE "studentId" = ${studentId}`;
        counts.retainedRevenueLine         = await tx.$executeRaw`DELETE FROM "RetainedRevenueLine"         WHERE "studentId" = ${studentId}`;
        counts.studentLedger               = await tx.$executeRaw`DELETE FROM "StudentLedger"               WHERE "studentId" = ${studentId}`;
        counts.studentEnrollment           = await tx.$executeRaw`DELETE FROM "StudentEnrollment"           WHERE "studentId" = ${studentId}`;
        counts.studentDocument             = await tx.$executeRaw`DELETE FROM "StudentDocument"             WHERE "studentId" = ${studentId}`;
        counts.hostelAllocation            = await tx.$executeRaw`DELETE FROM "HostelAllocation"            WHERE "studentId" = ${studentId}`;
        counts.transportAllocation         = await tx.$executeRaw`DELETE FROM "TransportAllocation"         WHERE "studentId" = ${studentId}`;
        counts.studentAccommodationPricing = await tx.$executeRaw`DELETE FROM "StudentAccommodationPricing" WHERE "studentId" = ${studentId}`;
        counts.convenorAdmission           = await tx.$executeRaw`DELETE FROM "ConvenorAdmission"           WHERE "studentId" = ${studentId}`;
        counts.studentExam                 = await tx.$executeRaw`DELETE FROM "StudentExam"                 WHERE "studentId" = ${studentId}`;

        // Payment before StudentFeeDemand (Payment.feeDemandId → StudentFeeDemand)
        counts.payment                     = await tx.$executeRaw`DELETE FROM "Payment"                     WHERE "studentId" = ${studentId}`;
        counts.studentFeeDemand            = await tx.$executeRaw`DELETE FROM "StudentFeeDemand"            WHERE "studentId" = ${studentId}`;

        counts.feeCorrection               = await tx.$executeRaw`DELETE FROM "FeeCorrection"               WHERE "studentId" = ${studentId}`;

        // StudentScholarship before AcademicQualification (qualificationId FK)
        counts.studentScholarship          = await tx.$executeRaw`DELETE FROM "StudentScholarship"          WHERE "studentId" = ${studentId}`;
        counts.academicQualification       = await tx.$executeRaw`DELETE FROM "AcademicQualification"       WHERE "studentId" = ${studentId}`;

        counts.scholarshipAllocation       = await tx.$executeRaw`DELETE FROM "ScholarshipAllocation"       WHERE "studentId" = ${studentId}`;
        counts.cancellationRequest         = await tx.$executeRaw`DELETE FROM "CancellationRequest"         WHERE "studentId" = ${studentId}`;
        counts.studentAdmission            = await tx.$executeRaw`DELETE FROM "StudentAdmission"            WHERE "studentId" = ${studentId}`;

        await tx.$executeRaw`DELETE FROM "Student" WHERE "id" = ${studentId}`;
        counts.student = 1;

        // ── 9. User account (if linked) ─────────────────────────────────────
        if (userId) {
            // Audit log for user deletion before the user row disappears
            await tx.auditLog.create({
                data: {
                    userId:    adminId,
                    action:    AuditAction.USER_HARD_DELETED,
                    entity:    'User',
                    entityId:  userId,
                    ipAddress,
                    userAgent,
                    timestamp: now,
                    details: {
                        studentId, applicationId,
                        linkedUserSnapshot: userRecord,
                        purgedBy: adminId,
                    },
                },
            });

            // Preserve student's own login audit trail but unlink the deleted userId
            await tx.auditLog.updateMany({ where: { userId }, data: { userId: null } });

            counts.userOtp                = await tx.$executeRaw`DELETE FROM "UserOtp"                 WHERE "userId" = ${userId}`;
            counts.notification           = await tx.$executeRaw`DELETE FROM "Notification"            WHERE "recipientId" = ${userId}`;
            counts.userGroup              = await tx.$executeRaw`DELETE FROM "UserGroup"               WHERE "userId" = ${userId}`;
            counts.userPermissionOverride = await tx.$executeRaw`DELETE FROM "UserPermissionOverride"  WHERE "userId" = ${userId}`;
            await tx.$executeRaw`DELETE FROM "User" WHERE "id" = ${userId}`;
            counts.user = 1;
        }

    }, { timeout: 30000 });

    logger.warn(
        `[purgeStudent] PURGE complete applicationId=${applicationId} studentId=${studentId}` +
        ` by admin=${adminId} counts=${JSON.stringify(counts)}`,
    );

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: `Student ${student.name} (${applicationId}) and all related records permanently deleted.`,
        data: { deletedCounts: counts },
    });
});

export const listPurgedStudents = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { page, limit, purgedBy, applicationId } = req.query as Record<string, string | undefined>;

    const pageNum  = Math.max(1, parseInt(page  ?? '1',  10));
    const pageSize = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10)));
    const skip     = (pageNum - 1) * pageSize;

    const where: any = { action: AuditAction.STUDENT_PURGED };
    if (purgedBy)     where.userId  = purgedBy;
    if (applicationId) where.details = { path: ['applicationId'], equals: applicationId };

    const [total, logs] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
            where,
            orderBy: { timestamp: 'desc' },
            skip,
            take: pageSize,
            select: {
                id:        true,
                entityId:  true,
                userId:    true,
                ipAddress: true,
                timestamp: true,
                details:   true,
            },
        }),
    ]);

    const purgedByIds = [...new Set(logs.map(l => l.userId).filter((v): v is string => !!v))];
    const purgedByUsers = purgedByIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: purgedByIds } },
            select: { id: true, name: true },
        })
        : [];
    const purgedByMap = Object.fromEntries(purgedByUsers.map(u => [u.id, u]));

    const data = logs.map(log => {
        const d = (log.details ?? {}) as any;
        return {
            auditLogId:        log.id,
            studentId:         log.entityId,
            applicationId:     d.applicationId,
            studentName:       d.studentSnapshot?.name ?? null,
            purgedBy:          log.userId,
            purgedByName:      purgedByMap[log.userId ?? '']?.name ?? null,
            purgedAt:          log.timestamp,
            ipAddress:         log.ipAddress,
            studentSnapshot:   d.studentSnapshot,
            admissionSnapshot: d.admissionSnapshot,
            financialSummary:  d.financialSummary,
            linkedUserId:      d.linkedUserId,
        };
    });

    sendResponse({
        res, statusCode: 200, success: true,
        data,
        pagination: { total, page: pageNum, limit: pageSize, totalPages: Math.ceil(total / pageSize) },
    });
});
