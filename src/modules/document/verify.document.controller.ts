import { Request, Response, NextFunction } from 'express';
import { verifyDocument } from '../student/student.service';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { sendResponse } from '../../utils/response';
import { MESSAGES } from '../../constants/messages';

export const verifyStudentDocument = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { documentKey, status, remarks } = req.body;

    if (!documentKey || !status) {
        throw new AppError(MESSAGES.ERROR.DOCUMENT_KEY_STATUS_REQUIRED, 400);
    }

    const result = await verifyDocument(studentId, documentKey, status, remarks);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DOCUMENT_VERIFIED,
        data: result
    });
});
