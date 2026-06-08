
import { Request, Response, NextFunction } from 'express';
import {
    createDocumentRequirement,
    getDocumentRequirements,
    updateDocumentRequirement,
    deleteDocumentRequirement,
    deleteStudentDocument as deleteStudentDocService
} from './document.service';
import { getStudentByUserId } from '../student/student.service';
import prisma from '../../config/prisma';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { sendResponse } from '../../utils/response';
import { MESSAGES } from '../../constants/messages';

export const addRequirement = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const requirement = await createDocumentRequirement(req.body);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.REQUIREMENT_CREATED,
        data: requirement
    });
});

export const listRequirements = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { degreeType } = req.query;
    const requirements = await getDocumentRequirements(degreeType as string);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: requirements
    });
});

export const updateRequirement = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const requirement = await updateDocumentRequirement(id, req.body);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.REQUIREMENT_UPDATED,
        data: requirement
    });
});

export const removeRequirement = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    await deleteDocumentRequirement(id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.REQUIREMENT_DELETED
    });
});

export const getMyRequirements = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const studentId = req.user?.userId;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        select: { degreeType: true }
    });

    if (!student || !student.degreeType) {
        throw new AppError(MESSAGES.ERROR.STUDENT_COURSE_TYPE_NOT_FOUND, 400);
    }

    const requirements = await getDocumentRequirements(student.degreeType);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: requirements
    });
});

export const deleteStudentDocument = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { documentKey } = req.query;

    const key = (documentKey as string) || req.body.documentKey;

    if (!key) {
        throw new AppError(MESSAGES.ERROR.DOCUMENT_KEY_REQUIRED, 400);
    }

    if (req.user?.role === 'STUDENT') {
        const s = await getStudentByUserId(req.user.userId);
        if (!s || s.id !== studentId) {
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
    }

    const result = await deleteStudentDocService(studentId, key);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DOCUMENT_DELETED,
        data: result
    });
});
