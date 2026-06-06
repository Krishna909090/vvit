import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { AppError } from '../../utils/AppError';
import { CourseCapacityService } from './courseCapacity.service';

export const createCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { courseId, academicYearId, totalSeats, filledSeats } = req.body;
    const adminId = req.user?.userId;
    const row = await CourseCapacityService.create({ courseId, academicYearId, totalSeats, filledSeats, createdBy: adminId });
    sendResponse({ res, statusCode: 201, success: true, message: 'Course capacity created', data: row });
});

export const upsertCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { courseId, academicYearId, totalSeats } = req.body;
    const adminId = req.user?.userId;
    const row = await CourseCapacityService.upsert({ courseId, academicYearId, totalSeats, createdBy: adminId });
    sendResponse({ res, statusCode: 200, success: true, message: 'Course capacity saved', data: row });
});

export const bulkUpsertCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { academicYearId, rows } = req.body;
    const adminId = req.user?.userId;
    const result = await CourseCapacityService.bulkUpsert({ academicYearId, rows, createdBy: adminId });
    sendResponse({ res, statusCode: 200, success: true, message: `Saved capacity for ${result.count} course(s)`, data: result });
});

export const listCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { courseId, academicYearId, degree, search } = req.query;
    const rows = await CourseCapacityService.list({
        courseId:       courseId       ? String(courseId)       : undefined,
        academicYearId: academicYearId ? String(academicYearId) : undefined,
        degree:         degree         ? String(degree)         : undefined,
        search:         search         ? String(search)         : undefined,
    });
    sendResponse({ res, statusCode: 200, success: true, data: rows });
});

export const getCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    if (!id) throw new AppError('id is required', 400);
    const row = await CourseCapacityService.getOne(id);
    sendResponse({ res, statusCode: 200, success: true, data: row });
});

export const updateCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const { totalSeats, filledSeats } = req.body;
    const adminId = req.user?.userId;
    const row = await CourseCapacityService.update(id, { totalSeats, filledSeats, updatedBy: adminId });
    sendResponse({ res, statusCode: 200, success: true, message: 'Course capacity updated', data: row });
});

export const deleteCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await CourseCapacityService.remove(id);
    sendResponse({ res, statusCode: 200, success: true, message: 'Course capacity deleted', data: result });
});
