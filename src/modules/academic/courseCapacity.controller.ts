import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { AppError } from '../../utils/AppError';
import { CourseCapacityService } from './courseCapacity.service';

// POST /admin/academic/capacity   { courseId, academicYearId, totalSeats, filledSeats? }
export const createCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { courseId, academicYearId, totalSeats, filledSeats } = req.body;
    const adminId = req.user?.userId;
    const row = await CourseCapacityService.create({ courseId, academicYearId, totalSeats, filledSeats, createdBy: adminId });
    sendResponse({ res, statusCode: 201, success: true, message: 'Course capacity created', data: row });
});

// POST /admin/academic/capacity/upsert   { courseId, academicYearId, totalSeats }
export const upsertCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { courseId, academicYearId, totalSeats } = req.body;
    const adminId = req.user?.userId;
    const row = await CourseCapacityService.upsert({ courseId, academicYearId, totalSeats, createdBy: adminId });
    sendResponse({ res, statusCode: 200, success: true, message: 'Course capacity saved', data: row });
});

// POST /admin/academic/capacity/bulk   { academicYearId, rows: [{ courseId, totalSeats }] }
export const bulkUpsertCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { academicYearId, rows } = req.body;
    const adminId = req.user?.userId;
    const result = await CourseCapacityService.bulkUpsert({ academicYearId, rows, createdBy: adminId });
    sendResponse({ res, statusCode: 200, success: true, message: `Saved capacity for ${result.count} course(s)`, data: result });
});

// GET /admin/academic/capacity?courseId=&academicYearId=
export const listCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { courseId, academicYearId } = req.query;
    const rows = await CourseCapacityService.list({
        courseId:       courseId       ? String(courseId)       : undefined,
        academicYearId: academicYearId ? String(academicYearId) : undefined,
    });
    sendResponse({ res, statusCode: 200, success: true, data: rows });
});

// GET /admin/academic/capacity/:id
export const getCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    if (!id) throw new AppError('id is required', 400);
    const row = await CourseCapacityService.getOne(id);
    sendResponse({ res, statusCode: 200, success: true, data: row });
});

// PUT /admin/academic/capacity/:id   { totalSeats?, filledSeats? }
export const updateCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const { totalSeats, filledSeats } = req.body;
    const adminId = req.user?.userId;
    const row = await CourseCapacityService.update(id, { totalSeats, filledSeats, updatedBy: adminId });
    sendResponse({ res, statusCode: 200, success: true, message: 'Course capacity updated', data: row });
});

// DELETE /admin/academic/capacity/:id
export const deleteCapacity = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await CourseCapacityService.remove(id);
    sendResponse({ res, statusCode: 200, success: true, message: 'Course capacity deleted', data: result });
});
