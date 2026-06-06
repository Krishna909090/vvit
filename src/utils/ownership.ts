import { Request } from 'express';
import { AppError } from './AppError';
import logger from './logger';
import { MESSAGES } from '../constants/messages';

export const assertStudentOwns = async (req: Request, studentId: string): Promise<void> => {
    if (req.user?.role === 'STUDENT') {
        const { getStudentByUserId } = await import('../modules/student/student.service');
        const s = await getStudentByUserId(req.user.userId);
        if (!s || s.id !== studentId) {
            logger.warn(`[Security] Student ${req.user?.userId} attempted to access data of ${studentId}`);
            throw new AppError(MESSAGES.ERROR.FORBIDDEN ?? 'Forbidden', 403);
        }
    }
};
