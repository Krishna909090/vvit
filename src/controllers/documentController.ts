import { Request, Response, NextFunction } from 'express';
import {
    createDocumentRequirement,
    getDocumentRequirements,
    updateDocumentRequirement,
    deleteDocumentRequirement
} from '../services/documentService';
import prisma from '../config/prisma';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import { sendResponse } from '../utils/response';
import { MESSAGES } from '../constants/messages';

// Admin: Create Requirement
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

// Admin: List Requirements (Optional query param: courseType)
export const listRequirements = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { courseType } = req.query;
    const requirements = await getDocumentRequirements(courseType as string);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: requirements
    });
});

// Admin: Update Requirement
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

// Admin: Delete Requirement
export const removeRequirement = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const result = await deleteDocumentRequirement(id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.REQUIREMENT_DELETED
    });
});

// Student: Get Requirements for their course
export const getMyRequirements = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const studentId = req.user?.userId;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        select: { courseType: true }
    });

    if (!student || !student.courseType) {
        throw new AppError(MESSAGES.ERROR.STUDENT_COURSE_TYPE_NOT_FOUND, 400);
    }

    const requirements = await getDocumentRequirements(student.courseType);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: requirements
    });
});
