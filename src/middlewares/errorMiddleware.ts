import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import logger from '../utils/logger';
import { ZodError } from 'zod';
import { MESSAGES } from '../constants/messages';

const handleZodError = (err: ZodError) => {
    const message = (err as any).errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
    return new AppError(message, 400);
};

const handlePrismaError = (err: any) => {
    // Handle specific Prisma errors if needed
    // P2002: Unique constraint failed
    if (err.code === 'P2002') {
        const target = err.meta?.target;
        return new AppError(`Duplicate field value: ${target}. Please use another value!`, 409);
    }
    // P2025: Record not found
    if (err.code === 'P2025') {
        return new AppError('Record not found', 404);
    }
    return new AppError('Database Error', 500);
};

const sendErrorDev = (err: any, res: Response) => {
    res.status(err.statusCode).json({
        status: err.status,
        error: err,
        message: err.message,
        // stack: err.stack,
    });
};

const sendErrorProd = (err: any, res: Response) => {
    // Operational, trusted error: send message to client
    if (err.isOperational) {
        res.status(err.statusCode).json({
            status: err.status,
            message: err.message,
        });
    } else {
        // Programming or other unknown error: don't leak details
        // 1) Log error
        logger.error('ERROR 💥', err);

        // 2) Send generic message
        res.status(500).json({
            status: 'error',
            message: MESSAGES.ERROR.INTERNAL_SERVER_ERROR || 'Something went wrong!',
        });
    }
};

export const globalErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    if (process.env.NODE_ENV === 'development') {
        sendErrorDev(err, res);
    } else {
        let error = { ...err };
        error.message = err.message;

        if (err instanceof ZodError) error = handleZodError(err);
        if (err.code && err.code.startsWith('P')) error = handlePrismaError(err); // Basic Prisma error check

        sendErrorProd(error, res);
    }
};
