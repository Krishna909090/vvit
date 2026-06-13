import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { InstitutionCodeService } from './institutionCode.service';
import { AppError } from '../../utils/AppError';

export const getAll = catchAsync(async (req: Request, res: Response) => {
  const data = await InstitutionCodeService.getAll();
  sendResponse({ res, statusCode: 200, success: true, data });
});

export const getById = catchAsync(async (req: Request, res: Response) => {
  const data = await InstitutionCodeService.getById(req.params.id);
  sendResponse({ res, statusCode: 200, success: true, data });
});

export const create = catchAsync(async (req: Request, res: Response) => {
  const { code, name } = req.body;
  if (!code || !name) throw new AppError('code and name are required', 400);
  const data = await InstitutionCodeService.create(code, name, req.user?.userId);
  sendResponse({ res, statusCode: 201, success: true, message: 'Institution code created', data });
});

export const update = catchAsync(async (req: Request, res: Response) => {
  const { code, name, isActive } = req.body;
  const data = await InstitutionCodeService.update(req.params.id, { code, name, isActive }, req.user?.userId);
  sendResponse({ res, statusCode: 200, success: true, message: 'Institution code updated', data });
});

export const remove = catchAsync(async (req: Request, res: Response) => {
  await InstitutionCodeService.delete(req.params.id, req.user?.userId);
  sendResponse({ res, statusCode: 200, success: true, message: 'Institution code deleted' });
});
