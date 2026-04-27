import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import * as service from './hostelPrice.service';
import logger from '../../utils/logger';

export const createPriceCategory = catchAsync(async (req: Request, res: Response) => {
    logger.info(`[createPriceCategory] request by=${req.user?.userId || 'anonymous'}`);

    const data = await service.createPriceCategory(req.body, req.user?.userId || null);

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
