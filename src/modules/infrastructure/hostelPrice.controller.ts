import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { sendResponse } from '../../utils/response';
import * as service from './hostelPrice.service';
import logger from '../../utils/logger';

export const createPriceCategory = catchAsync(async (req: Request, res: Response) => {
    logger.info(`[createPriceCategory] request by=${req.user?.userId || 'anonymous'}`);
    const { sharing, roomType, price, metadata } = req.body;
    
    // Zod handles basic validation, but custom business logic checks can remain
    if (!sharing || !roomType || price === undefined) {
        throw new AppError('Sharing type, room type, and price are required', 400);
    }
    
    // Validate Sharing
    if (![2, 4, 6, 8, 10].includes(Number(sharing))) {
        throw new AppError('Invalid sharing type. Allowed: 2, 4, 6, 8, 10', 400);
    }

    // Validate Room Type
    if (!['AC', 'NON_AC'].includes(roomType)) {
        throw new AppError('Invalid room type. Allowed: AC, NON_AC', 400);
    }

    const data = await service.createPriceCategory({
        sharing: Number(sharing),
        roomType,
        price: Number(price),
        metadata
    }, req.user?.userId || null);

    logger.info(`[createPriceCategory] successful, id=${data.id}`);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: 'Price category created successfully',
        data
    });
});

export const getAllPriceCategories = catchAsync(async (req: Request, res: Response) => {
    logger.info(`[getAllPriceCategories] request`);
    const data = await service.getAllPriceCategories();
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data
    });
});

export const getPriceCategoryById = catchAsync(async (req: Request, res: Response) => {
    logger.info(`[getPriceCategoryById] id=${req.params.id}`);
    const data = await service.getPriceCategoryById(req.params.id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data
    });
});

export const updatePriceCategory = catchAsync(async (req: Request, res: Response) => {
    logger.info(`[updatePriceCategory] id=${req.params.id} by=${req.user?.userId || 'anonymous'}`);
    const data = await service.updatePriceCategory(req.params.id, req.body, req.user?.userId || null);
    
    logger.info(`[updatePriceCategory] successful`);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Price category updated successfully',
        data
    });
});

export const deletePriceCategory = catchAsync(async (req: Request, res: Response) => {
    logger.info(`[deletePriceCategory] id=${req.params.id} by=${req.user?.userId || 'anonymous'}`);
    await service.deletePriceCategory(req.params.id);
    
    logger.info(`[deletePriceCategory] successful`);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Price category deleted successfully'
    });
});
