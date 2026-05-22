import { Request, Response, NextFunction } from 'express';
import { promoteStudents, getStudentEnrollmentHistory, getStudentYearWiseFinancials } from './yearPromotion.service';
import { AppError } from '../../utils/AppError';
import { assertStudentOwns } from '../../utils/ownership';

export const promoteStudentsController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { fromAcademicYearId, toAcademicYearId } = req.body;
        if (!fromAcademicYearId || !toAcademicYearId) {
            throw new AppError('fromAcademicYearId and toAcademicYearId are required', 400);
        }

        const result = await promoteStudents(fromAcademicYearId, toAcademicYearId, req.user?.userId!);

        res.status(200).json({
            status: 'success',
            message: `Promoted ${result.promoted} students. Skipped: ${result.skipped}. Failed: ${result.failed}`,
            data: result
        });
    } catch (error) {
        next(error);
    }
};

export const getEnrollmentHistoryController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { studentId } = req.params;
        if (!studentId) throw new AppError('studentId is required', 400);

        await assertStudentOwns(req, studentId); // IDOR guard

        const history = await getStudentEnrollmentHistory(studentId);

        res.status(200).json({
            status: 'success',
            data: history
        });
    } catch (error) {
        next(error);
    }
};

export const getYearWiseFinancialsController = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { studentId } = req.params;
        if (!studentId) throw new AppError('studentId is required', 400);

        await assertStudentOwns(req, studentId); // IDOR guard

        const financials = await getStudentYearWiseFinancials(studentId);

        res.status(200).json({
            status: 'success',
            data: financials
        });
    } catch (error) {
        next(error);
    }
};
