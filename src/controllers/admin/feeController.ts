import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { FeeService } from '../../services/feeService';
import logger from '../../utils/logger';

// Fee Head
export const createFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, description } = req.body;
    const adminId = req.user?.userId;

    const feeHead = await FeeService.createFeeHead(name, description, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.FEE_HEAD_CREATED,
        data: feeHead
    });
});

export const getFeeHeads = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const feeHeads = await FeeService.getFeeHeads();
    sendResponse({ res, statusCode: 200, success: true, data: feeHeads });
});

export const updateFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, description } = req.body;
    
    const updatedFeeHead = await FeeService.updateFeeHead(id, name, description, req.user?.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_HEAD_UPDATED, data: updatedFeeHead });
});

export const deleteFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await FeeService.deleteFeeHead(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_HEAD_DELETED });
});

// Fee Structure
export const createFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { courseId, feeHeadId, amount, academicYearId } = req.body;
    const adminId = req.user?.userId;

    const feeStructure = await FeeService.createFeeStructure(courseId, feeHeadId, amount, academicYearId, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.FEE_STRUCTURE_CREATED,
        data: feeStructure
    });
});

export const getFeeStructures = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const feeStructures = await FeeService.getFeeStructures();
    sendResponse({ res, statusCode: 200, success: true, data: feeStructures });
});

export const updateFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { courseId, feeHeadId, amount, academicYearId } = req.body;
    
    const updatedFeeStructure = await FeeService.updateFeeStructure(id, courseId, feeHeadId, amount, academicYearId, req.user?.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_STRUCTURE_UPDATED, data: updatedFeeStructure });
});

export const deleteFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await FeeService.deleteFeeStructure(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_STRUCTURE_DELETED });
});


// Fee Statistics
export const getFeeStatistics = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const stats = await FeeService.getFeeStatistics();

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.FEE_STATISTICS_FETCHED,
        data: stats
    });
});

// Create Discount Request
export const createDiscountRequest = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[createDiscountRequest] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, reason, documentUrl } = req.body;
    
    const discountRequest = await FeeService.createDiscountRequest(studentId, reason, documentUrl);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_REQUESTED,
        data: discountRequest
    });
});

// Review Discount Request
export const reviewDiscountRequest = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[reviewDiscountRequest] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, remarks } = req.body;
    
    await FeeService.reviewDiscountRequest(requestId, remarks);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_FORWARDED
    });
});

// Approve Discount
export const approveDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveDiscount] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, approved } = req.body;
    
    await FeeService.approveDiscount(requestId, approved, req.user?.role);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_PROCESSED
    });
});
