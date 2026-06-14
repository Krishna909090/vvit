import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { AppError } from '../../utils/AppError';
import { ConvenorAdmissionService, CONVENOR_STATUSES } from './convenorAdmission.service';

export const list = catchAsync(async (req: Request, res: Response) => {
  const { status, fromDate, toDate, search, page, limit } = req.query;

  if (status && !CONVENOR_STATUSES.includes(status as any)) {
    throw new AppError(`Invalid status. Allowed: ${CONVENOR_STATUSES.join(', ')}`, 400);
  }

  const result = await ConvenorAdmissionService.list({
    status:   status as string | undefined,
    fromDate: fromDate as string | undefined,
    toDate:   toDate as string | undefined,
    search:   search as string | undefined,
    page:     page   ? Number(page)  : undefined,
    limit:    limit  ? Number(limit) : undefined,
  });

  sendResponse({ res, statusCode: 200, success: true, data: result });
});

export const exportCsv = catchAsync(async (req: Request, res: Response) => {
  const { status, fromDate, toDate, search } = req.query;

  if (status && !CONVENOR_STATUSES.includes(status as any)) {
    throw new AppError(`Invalid status. Allowed: ${CONVENOR_STATUSES.join(', ')}`, 400);
  }

  const csv = await ConvenorAdmissionService.exportCsv({
    status:   status as string | undefined,
    fromDate: fromDate as string | undefined,
    toDate:   toDate as string | undefined,
    search:   search as string | undefined,
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="convenor-admissions.csv"');
  res.status(200).send(csv);
});

export const updateStatus = catchAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) throw new AppError('status is required', 400);
  if (!CONVENOR_STATUSES.includes(status as any)) {
    throw new AppError(`Invalid status. Allowed: ${CONVENOR_STATUSES.join(', ')}`, 400);
  }

  const data = await ConvenorAdmissionService.updateStatus(id, status, (req as any).user?.id);
  sendResponse({ res, statusCode: 200, success: true, message: 'Status updated', data });
});
