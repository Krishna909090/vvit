import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import { sendResponse } from '../utils/response';
import { MESSAGES } from '../constants/messages';
import { markAttendanceByScan } from '../services/examService';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';



export const scanStudentQR = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { qrHash } = req.body;
    if (!qrHash) throw new AppError(MESSAGES.ERROR.QR_HASH_REQUIRED, 400);

    const invigilatorId = req.user?.userId || 'unknown';
    const result = await markAttendanceByScan(qrHash, invigilatorId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ATTENDANCE_MARKED,
        data: result
    });
});
