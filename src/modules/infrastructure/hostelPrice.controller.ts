import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { sendResponse } from '../../utils/response';
import * as service from './hostelPrice.service';

export const createPriceCategory = catchAsync(async (req: Request, res: Response) => {
    const { sharing, roomType, price } = req.body;
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
        price: Number(price)
    }, req.user?.userId || null);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: 'Price category created successfully',
        data
    });
});

export const getAllPriceCategories = catchAsync(async (req: Request, res: Response) => {
    const data = await service.getAllPriceCategories();
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data
    });
});

export const getPriceCategoryById = catchAsync(async (req: Request, res: Response) => {
    const data = await service.getPriceCategoryById(req.params.id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data
    });
});

export const updatePriceCategory = catchAsync(async (req: Request, res: Response) => {
    const data = await service.updatePriceCategory(req.params.id, req.body, req.user?.userId || null);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Price category updated successfully',
        data
    });
});

export const deletePriceCategory = catchAsync(async (req: Request, res: Response) => {
    await service.deletePriceCategory(req.params.id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Price category deleted successfully'
    });
});
