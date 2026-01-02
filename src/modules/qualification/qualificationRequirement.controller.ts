import { Request, Response, NextFunction } from 'express';
import * as service from './qualificationRequirement.service';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { AppError } from '../../utils/AppError';

export const getQualificationRequirements = catchAsync(async (req: Request, res: Response) => {
    const { degreeType } = req.query;
    const data = await service.getQualificationRequirements(degreeType as string);
    sendResponse({ res, statusCode: 200, success: true, data });
});

export const getQualificationRequirementById = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const data = await service.getQualificationRequirementById(id);
    sendResponse({ res, statusCode: 200, success: true, data });
});

export const createQualificationRequirement = catchAsync(async (req: Request, res: Response) => {
    const payload = { ...req.body };
    if (payload.qualificationKey && !payload.qualificationKeys) {
        payload.qualificationKeys = [payload.qualificationKey];
    }
    
    const data = await service.createQualificationRequirement(payload, req.user?.userId);
    sendResponse({ res, statusCode: 201, success: true, data });
});

export const updateQualificationRequirement = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const data = await service.updateQualificationRequirement(id, req.body, req.user?.userId);
    sendResponse({ res, statusCode: 200, success: true, data });
});

export const deleteQualificationRequirement = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    await service.deleteQualificationRequirement(id);
    sendResponse({ res, statusCode: 200, success: true, message: 'Deleted successfully' });
});

export const validate = catchAsync(async (req: Request, res: Response) => {
    const { degreeType, qualifications } = req.body;
    
    if (!degreeType) throw new AppError('Degree type is required', 400);
    if (!Array.isArray(qualifications)) throw new AppError('Qualifications must be an array', 400);

    const result = await service.validateQualifications(degreeType, qualifications);
    
    sendResponse({ 
        res, 
        statusCode: 200, 
        success: true, 
        data: result,
        message: result.valid ? 'Validation successful' : 'Validation failed'
    });
});
