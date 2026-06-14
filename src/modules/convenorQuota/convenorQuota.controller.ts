import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { ConvenorQuotaService } from './convenorQuota.service';
import { AppError } from '../../utils/AppError';

export const getAll = catchAsync(async (req: Request, res: Response) => {
  const { academicYearId, courseId } = req.query;
  const data = await ConvenorQuotaService.getAll(
    academicYearId as string | undefined,
    courseId as string | undefined,
  );
  sendResponse({ res, statusCode: 200, success: true, data });
});

export const getById = catchAsync(async (req: Request, res: Response) => {
  const data = await ConvenorQuotaService.getById(req.params.id);
  sendResponse({ res, statusCode: 200, success: true, data });
});

export const create = catchAsync(async (req: Request, res: Response) => {
  const { courseId, totalSeats, reportedSeats, seatsConfirmed } = req.body;
  if (!courseId) throw new AppError('courseId is required', 400);
  const data = await ConvenorQuotaService.create(
    courseId,
    Number(totalSeats ?? 0),
    Number(reportedSeats ?? 0),
    Number(seatsConfirmed ?? 0),
    req.user?.userId,
  );
  sendResponse({ res, statusCode: 201, success: true, message: 'Convenor quota created', data });
});

export const update = catchAsync(async (req: Request, res: Response) => {
  const { totalSeats, reportedSeats, seatsConfirmed } = req.body;
  const data = await ConvenorQuotaService.update(
    req.params.id,
    {
      ...(totalSeats !== undefined ? { totalSeats: Number(totalSeats) } : {}),
      ...(reportedSeats !== undefined ? { reportedSeats: Number(reportedSeats) } : {}),
      ...(seatsConfirmed !== undefined ? { seatsConfirmed: Number(seatsConfirmed) } : {}),
    },
    req.user?.userId,
  );
  sendResponse({ res, statusCode: 200, success: true, message: 'Convenor quota updated', data });
});

export const remove = catchAsync(async (req: Request, res: Response) => {
  await ConvenorQuotaService.delete(req.params.id, req.user?.userId);
  sendResponse({ res, statusCode: 200, success: true, message: 'Convenor quota deleted' });
});
