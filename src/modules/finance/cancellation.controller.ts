import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { sendResponse } from '../../utils/response';
import { CancellationService, calculateFeeAdjustment } from './cancellation.service';
import { CancellationStatus } from '@prisma/client';
import prisma from '../../config/prisma';

export const previewAdjustment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[previewAdjustment] by=${req.user?.userId || 'anonymous'}`);

    const { conditionType, totalPaid, componentPaid, oldQuotaFee, newQuotaFee } = req.body;

    const result = calculateFeeAdjustment({
        conditionType,
        totalPaid,
        componentPaid,
        oldQuotaFee,
        newQuotaFee,
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Fee adjustment preview calculated successfully',
        data: result,
    });
});

export const requestCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestCancellation] by=${req.user?.userId || 'anonymous'}`);

    const {
        studentId,
        reason,
        conditionType,
        oldQuotaFee,
        newQuotaFee,
        remarks,
        fileUrl,
        recommendedByManagement,
        cancellationFee,
    } = req.body;

    const adminId = req.user?.userId;
    if (!adminId) throw new AppError('Unauthorized', 401);

    const result = await CancellationService.createCancellationRequest(
        { studentId, reason, conditionType, oldQuotaFee, newQuotaFee, remarks, fileUrl, recommendedByManagement, cancellationFee },
        adminId,
    );

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: 'Cancellation request created successfully',
        data: result,
    });
});

export const approveCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveCancellation] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, approved, remarks, cancellationFee } = req.body;

    const adminId = req.user?.userId;
    if (!adminId) throw new AppError('Unauthorized', 401);

    const result = await CancellationService.approveCancellation(requestId, approved, adminId, remarks, cancellationFee);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: approved ? 'Cancellation approved successfully' : 'Cancellation rejected',
        data: result,
    });
});

export const listCancellationRequests = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[listCancellationRequests] by=${req.user?.userId || 'anonymous'}`);

    const { status, conditionType, page, limit, applicationid, applicationId } = req.query;
    const searchAppId = (applicationid || applicationId) as string | undefined;

    const result = await CancellationService.listCancellationRequests({
        status:        status as CancellationStatus | undefined,
        conditionType: conditionType as string | undefined,
        applicationId: searchAppId,
        page:          page  ? parseInt(page  as string, 10) : 1,
        limit:         limit ? parseInt(limit as string, 10) : 20,
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Cancellation requests fetched successfully',
        data: result,
    });
});

export const downloadCancellationInvoice = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    logger.info(`[downloadCancellationInvoice] id=${req.params.id} by=${req.user?.userId || 'anonymous'}`);

    const presignedUrl = await CancellationService.getInvoiceUrl(req.params.id);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Cancellation receipt URL generated',
        data: { invoiceUrl: presignedUrl },
    });
});

export const getCancellationById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getCancellationById] id=${req.params.id} by=${req.user?.userId || 'anonymous'}`);

    const result = await CancellationService.getCancellationById(req.params.id);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Cancellation request fetched successfully',
        data: result,
    });
});

export const listRetainedRevenue = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { category, sourceType, studentId: rawStudentId, academicYearId, isSettled, page, limit, applicationId } = req.query as Record<string, string | undefined>;

    const pageNum  = Math.max(1, parseInt(page  ?? '1',  10));
    const pageSize = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10)));
    const skip     = (pageNum - 1) * pageSize;

    let studentId = rawStudentId;
    if (applicationId && !studentId) {
        const student = await prisma.student.findUnique({
            where: { applicationId },
            select: { id: true },
        });
        if (!student) {
            sendResponse({ res, statusCode: 200, success: true, data: [], pagination: { total: 0, page: pageNum, limit: pageSize, totalPages: 0 } });
            return;
        }
        studentId = student.id;
    }

    const correctionWhere: any = {};
    if (studentId)      correctionWhere.studentId      = studentId;
    if (academicYearId) correctionWhere.academicYearId = academicYearId;
    if (isSettled !== undefined) correctionWhere.isSettled = isSettled === 'true';

    if (category || sourceType) {
        const matchingLineWhere: any = {};
        if (studentId)  matchingLineWhere.studentId  = studentId;
        if (category)   matchingLineWhere.category   = category;
        if (sourceType) matchingLineWhere.sourceType = sourceType;

        const matchingLines = await prisma.retainedRevenueLine.findMany({
            where: matchingLineWhere,
            select: { sourceId: true },
            distinct: ['sourceId'],
        });
        correctionWhere.id = { in: matchingLines.map(l => l.sourceId) };
    }

    const [total, corrections] = await Promise.all([
        prisma.feeCorrection.count({ where: correctionWhere }),
        prisma.feeCorrection.findMany({
            where: correctionWhere,
            orderBy: { createdAt: 'desc' },
            skip,
            take: pageSize,
            select: {
                id:                 true,
                studentId:          true,
                academicYearId:     true,
                amount:             true,
                retainedAmount:     true,
                retentionBreakdown: true,
                reason:             true,
                type:               true,
                referenceId:        true,
                referenceType:      true,
                isSettled:          true,
                settledAt:          true,
                settledBy:          true,
                createdAt:          true,
                createdBy:          true,
            },
        }),
    ]);

    const correctionIds  = corrections.map(fc => fc.id);
    const studentIds     = [...new Set(corrections.map(fc => fc.studentId))];
    const createdByIds   = [...new Set(corrections.map(fc => fc.createdBy).filter((v): v is string => !!v))];

    const [lines, students, createdByUsers] = await Promise.all([
        correctionIds.length > 0
            ? prisma.retainedRevenueLine.findMany({
                where: { sourceId: { in: correctionIds } },
                orderBy: { occurredAt: 'asc' },
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
            })
            : Promise.resolve([] as any[]),
        studentIds.length > 0
            ? prisma.student.findMany({
                where: { id: { in: studentIds } },
                select: { id: true, name: true, applicationId: true },
            })
            : Promise.resolve([] as any[]),
        createdByIds.length > 0
            ? prisma.user.findMany({
                where: { id: { in: createdByIds } },
                select: { id: true, name: true },
            })
            : Promise.resolve([] as any[]),
    ]);

    const studentMap   = Object.fromEntries(students.map(s => [s.id, s]));
    const createdByMap = Object.fromEntries(createdByUsers.map(u => [u.id, u]));

    const linesBySourceId = lines.reduce<Record<string, typeof lines>>((acc, l) => {
        (acc[l.sourceId] ??= []).push(l);
        return acc;
    }, {});

    const data = corrections.map(fc => ({
        ...fc,
        studentName:    studentMap[fc.studentId]?.name          ?? null,
        applicationId:  studentMap[fc.studentId]?.applicationId ?? null,
        createdByName:  createdByMap[fc.createdBy ?? '']?.name  ?? null,
        retainedLines:  linesBySourceId[fc.id] ?? [],
    }));

    sendResponse({
        res, statusCode: 200, success: true,
        data,
        pagination: { total, page: pageNum, limit: pageSize, totalPages: Math.ceil(total / pageSize) },
    });
});
