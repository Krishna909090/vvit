import { Request } from 'express';
import { AppError } from './AppError';
import logger from './logger';
import { MESSAGES } from '../constants/messages';

/**
 * IDOR guard — a STUDENT may only access their OWN data. Any non-STUDENT role
 * (admin/staff that already cleared `authorizePermission`) passes through.
 *
 * Use on read/derived endpoints that take a `:studentId` (or resolve one) but are
 * permitted with a `*.read.own` permission, which the student role holds — without
 * this check a student could pass another student's id and read their data.
 */
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
