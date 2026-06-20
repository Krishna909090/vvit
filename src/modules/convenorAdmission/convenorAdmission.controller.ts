import { Request, Response } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { ConvenorAdmissionService } from './convenorAdmission.service';
import logger from '../../utils/logger';

export const list = catchAsync(async (req: Request, res: Response) => {
  logger.info(`[convenorAdmission.list] by=${(req as any).user?.userId || 'anonymous'}`);
  const { status, fromDate, toDate, reportedFrom, reportedTo, search, page, limit } = req.query;
  const { records, pagination } = await ConvenorAdmissionService.list({
    status:       status       as string | undefined,
    fromDate:     fromDate     as string | undefined,
    toDate:       toDate       as string | undefined,
    reportedFrom: reportedFrom as string | undefined,
    reportedTo:   reportedTo   as string | undefined,
    search:       search       as string | undefined,
    page:         page         ? Number(page)  : undefined,
    limit:        limit        ? Number(limit) : undefined,
  });
  sendResponse({ res, statusCode: 200, success: true, data: records, pagination });
});

export const listMine = catchAsync(async (req: Request, res: Response) => {
  const adminId = (req as any).user?.userId;
  logger.info(`[convenorAdmission.listMine] by=${adminId || 'anonymous'}`);
  const { status, fromDate, toDate, reportedFrom, reportedTo, search, page, limit } = req.query;
  const { records, pagination } = await ConvenorAdmissionService.list({
    status:       status       as string | undefined,
    fromDate:     fromDate     as string | undefined,
    toDate:       toDate       as string | undefined,
    reportedFrom: reportedFrom as string | undefined,
    reportedTo:   reportedTo   as string | undefined,
    search:       search       as string | undefined,
    page:         page         ? Number(page)  : undefined,
    limit:        limit        ? Number(limit) : undefined,
    createdById:  adminId,
  });
  sendResponse({ res, statusCode: 200, success: true, data: records, pagination });
});

export const listMyAllotments = catchAsync(async (req: Request, res: Response) => {
  const adminId = (req as any).user?.userId;
  logger.info(`[convenorAdmission.listMyAllotments] by=${adminId || 'anonymous'}`);
  const { status, fromDate, toDate, reportedFrom, reportedTo, search, page, limit } = req.query;
  const { records, pagination } = await ConvenorAdmissionService.listMyAllotments({
    status:       status       as string | undefined,
    fromDate:     fromDate     as string | undefined,
    toDate:       toDate       as string | undefined,
    reportedFrom: reportedFrom as string | undefined,
    reportedTo:   reportedTo   as string | undefined,
    search:       search       as string | undefined,
    page:         page         ? Number(page)  : undefined,
    limit:        limit        ? Number(limit) : undefined,
  }, adminId);
  sendResponse({ res, statusCode: 200, success: true, data: records, pagination });
});

export const listWithAdmin = catchAsync(async (req: Request, res: Response) => {
  logger.info(`[convenorAdmission.listWithAdmin] by=${(req as any).user?.userId || 'anonymous'}`);
  const { status, fromDate, toDate, reportedFrom, reportedTo, search, page, limit } = req.query;
  const { records, pagination } = await ConvenorAdmissionService.listWithAdmin({
    status:       status       as string | undefined,
    fromDate:     fromDate     as string | undefined,
    toDate:       toDate       as string | undefined,
    reportedFrom: reportedFrom as string | undefined,
    reportedTo:   reportedTo   as string | undefined,
    search:       search       as string | undefined,
    page:         page         ? Number(page)  : undefined,
    limit:        limit        ? Number(limit) : undefined,
  });
  sendResponse({ res, statusCode: 200, success: true, data: records, pagination });
});

export const getById = catchAsync(async (req: Request, res: Response) => {
  const data = await ConvenorAdmissionService.getById(req.params.id);
  sendResponse({ res, statusCode: 200, success: true, data });
});

export const getByHallTicket = catchAsync(async (req: Request, res: Response) => {
  const data = await ConvenorAdmissionService.getByHallTicket(req.params.hallTicket);
  sendResponse({ res, statusCode: 200, success: true, data });
});

export const report = catchAsync(async (req: Request, res: Response) => {
  const adminId = (req as any).user?.userId || 'SYSTEM';
  logger.info(`[convenorAdmission.report] id=${req.params.id} by=${adminId}`);
  const data = await ConvenorAdmissionService.report(req.params.id, req.body, adminId);
  sendResponse({ res, statusCode: 200, success: true, message: 'Admission reported successfully', data });
});

export const exportCsv = catchAsync(async (req: Request, res: Response) => {
  const { status, fromDate, toDate, reportedFrom, reportedTo, search } = req.query;
  const csv = await ConvenorAdmissionService.exportCsv({
    status:       status       as string | undefined,
    fromDate:     fromDate     as string | undefined,
    toDate:       toDate       as string | undefined,
    reportedFrom: reportedFrom as string | undefined,
    reportedTo:   reportedTo   as string | undefined,
    search:       search       as string | undefined,
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="convenor-admissions.csv"');
  res.status(200).send(csv);
});

export const allot = catchAsync(async (req: Request, res: Response) => {
  const adminId = (req as any).user?.userId || 'SYSTEM';
  logger.info(`[convenorAdmission.allot] id=${req.params.id} by=${adminId}`);
  const data = await ConvenorAdmissionService.allot(req.params.id, req.body, adminId);
  sendResponse({ res, statusCode: 200, success: true, message: 'Seat allotted successfully', data });
});

export const updateStatus = catchAsync(async (req: Request, res: Response) => {
  const data = await ConvenorAdmissionService.updateStatus(req.params.id, req.body.status, (req as any).user?.userId);
  sendResponse({ res, statusCode: 200, success: true, message: 'Status updated', data });
});

export const custodianCertificate = catchAsync(async (req: Request, res: Response) => {
  const adminId = (req as any).user?.userId || 'SYSTEM';
  const refresh = req.query.refresh === 'true';
  logger.info(`[convenorAdmission.custodianCertificate] id=${req.params.id} refresh=${refresh} by=${adminId}`);
  const presignedUrl = await ConvenorAdmissionService.getOrGenerateCertificate(req.params.id, adminId, refresh);
  sendResponse({ res, statusCode: 200, success: true, data: { url: presignedUrl } });
});

export const updateDetails = catchAsync(async (req: Request, res: Response) => {
  const data = await ConvenorAdmissionService.updateDetails(req.params.id, req.body, (req as any).user?.userId);
  sendResponse({ res, statusCode: 200, success: true, message: 'Details updated', data });
});
