import { Request, Response, NextFunction } from 'express';
import { removeDocument } from '../student/student.service';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { sendResponse } from '../../utils/response';
import { MESSAGES } from '../../constants/messages';

export const deleteStudentDocument = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { documentKey } = req.body;

    if (!documentKey) {
        throw new AppError(MESSAGES.ERROR.DOCUMENT_KEY_REQUIRED, 400);
    }

    const result = await removeDocument(studentId, documentKey);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DOCUMENT_DELETED,
        data: result
    });
});
