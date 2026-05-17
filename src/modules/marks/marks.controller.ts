import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { MarksService } from './marks.service';

// ════════════════════════════════════════════════════════════════════════════
// Subject
// ════════════════════════════════════════════════════════════════════════════

export const createSubject = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const subject = await MarksService.createSubject(req.body, userId);
    sendResponse({ res, statusCode: 201, success: true, message: 'Subject created', data: subject });
});

export const listSubjects = catchAsync(async (req: Request, _res: Response, _next: NextFunction) => {
    const { courseId, semester, examType, isElective } = req.query as any;
    const subjects = await MarksService.listSubjects({
        courseId,
        semester:   semester    ? parseInt(semester, 10)        : undefined,
        examType,
        isElective: isElective !== undefined ? isElective === 'true' : undefined,
    });
    sendResponse({ res: _res, statusCode: 200, success: true, data: subjects });
});

export const updateSubject = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const subject = await MarksService.updateSubject(req.params.id, req.body, userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Subject updated', data: subject });
});

export const deleteSubject = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const subject = await MarksService.deleteSubject(req.params.id, userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Subject deleted', data: subject });
});

// ════════════════════════════════════════════════════════════════════════════
// SemesterMark
// ════════════════════════════════════════════════════════════════════════════

export const recordMark = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const mark = await MarksService.recordMark(req.body, userId);
    sendResponse({ res, statusCode: 201, success: true, message: 'Mark recorded', data: mark });
});

export const recordMarksBulk = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const { studentId, academicYearId, marks } = req.body;
    const result = await MarksService.recordMarksBulk(studentId, academicYearId, marks, userId);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: `Bulk record: ${result.summary.ok}/${result.summary.total} ok, ${result.summary.failed} failed`,
        data: result,
    });
});

export const updateMark = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const mark = await MarksService.updateMark(req.params.id, req.body, userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Mark updated', data: mark });
});

export const deleteMark = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user!.userId;
    const mark = await MarksService.deleteMark(req.params.id, userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Mark deleted', data: mark });
});

export const getStudentMarks = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { academicYearId, semester } = req.query as any;
    const data = await MarksService.getStudentMarks(req.params.studentId, {
        academicYearId,
        semester: semester ? parseInt(semester, 10) : undefined,
    });
    sendResponse({ res, statusCode: 200, success: true, data });
});

export const getSemesterMarks = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { academicYearId, semester, subjectId, status, courseId } = req.query as any;
    const data = await MarksService.getSemesterMarks(
        academicYearId,
        parseInt(semester, 10),
        { subjectId, status, courseId }
    );
    sendResponse({ res, statusCode: 200, success: true, data });
});
