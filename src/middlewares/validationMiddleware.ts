import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { MESSAGES } from '../constants/messages';
import { AppError } from '../utils/AppError';

export const validateRequest = (schema: ZodSchema<any>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
        await schema.parseAsync({
            body: req.body,
            query: req.query,
            params: req.params,
        });
        return next();
    } catch (error) {
        if (error instanceof ZodError) {
            const errorMessage = (error as any).errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
            return next(new AppError(`Validation failed: ${errorMessage}`, 400));
        }
        return next(new AppError(MESSAGES.ERROR.INTERNAL_SERVER_ERROR, 500));
    }
};
