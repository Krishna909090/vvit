import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { AttendanceService } from './attendance.service';

export const markAttendance = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const data = await AttendanceService.markAttendance(req.body, userId);
    sendResponse({ res, statusCode: 201, success: true, message: 'Attendance recorded', data });
});

export const markClassAttendance = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const result = await AttendanceService.markClassAttendance(req.body, userId);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: `Class roll: ${result.summary.ok}/${result.summary.total} ok`,
        data: result,
    });
});

export const markAttendanceBackfill = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const { studentId, academicYearId, rows } = req.body;
    const result = await AttendanceService.markAttendanceBackfill(studentId, academicYearId, rows, userId);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: `Back-fill: ${result.summary.ok}/${result.summary.total} ok`,
        data: result,
    });
});

export const updateAttendance = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const data = await AttendanceService.updateAttendance(req.params.id, req.body, userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Attendance updated', data });
});

export const deleteAttendance = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const data = await AttendanceService.deleteAttendance(req.params.id, userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Attendance deleted', data });
});

export const getStudentAttendance = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { subjectId, academicYearId, from, to, semester } = req.query as any;
    const data = await AttendanceService.getStudentAttendance(req.params.studentId, {
        subjectId,
        academicYearId,
        from,
        to,
        semester: semester ? parseInt(semester, 10) : undefined,
    });
    sendResponse({ res, statusCode: 200, success: true, data });
});

export const getClassAttendance = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { subjectId, date, periodNumber } = req.query as any;
    const data = await AttendanceService.getClassAttendance(
        subjectId,
        date,
        periodNumber !== undefined ? parseInt(periodNumber, 10) : undefined
    );
    sendResponse({ res, statusCode: 200, success: true, data });
});

export const getAttendanceStats = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { subjectId, academicYearId, semester } = req.query as any;
    const data = await AttendanceService.getAttendanceStats(req.params.studentId, {
        subjectId,
        academicYearId,
        semester: semester ? parseInt(semester, 10) : undefined,
    });
    sendResponse({ res, statusCode: 200, success: true, data });
});
