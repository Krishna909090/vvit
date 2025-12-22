
import { Request, Response, NextFunction } from 'express';
import {
    createDocumentRequirement,
    getDocumentRequirements,
    updateDocumentRequirement,
    deleteDocumentRequirement,
    deleteStudentDocument as deleteStudentDocService
} from './document.service';
import prisma from '../../config/prisma';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { sendResponse } from '../../utils/response';
import { MESSAGES } from '../../constants/messages';

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

/**
 * Delete a specific document for a student.
 */
export const deleteStudentDocument = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { documentKey } = req.query; // Changed to query as typical DELETE doesn't use body often, but let's check routes. 

    // Route: router.delete('/:studentId/document', ...)
    // Postman usually sends query params for DELETE or body. 
    // The previous controller used `req.body` for documentKey.
    // However, the route definition in `studentRoutes.ts` line 406 says:
    //       - in: query
    //         name: documentKey
    
    // So `req.query` is correct based on Swagger, but `req.body` was used in `deleteDocumentController`.
    // I will support both to be safe or stick to query as per Swagger.
    
    const key = (documentKey as string) || req.body.documentKey;

    if (!key) {
        throw new AppError(MESSAGES.ERROR.DOCUMENT_KEY_REQUIRED, 400);
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
