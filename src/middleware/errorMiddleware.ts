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
    logger.error(`[Prisma Error] code: ${err.code}`, {
        code: err.code,
        message: err.message,
        target: err.meta?.target
    });

    if (err.code === 'P2002') {
        const target = err.meta?.target;
        return new AppError(`Duplicate field value: ${target}. Please use another value!`, 409);
    }

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

    });
};

const sendErrorProd = (err: any, res: Response) => {

    if (err.isOperational) {
        res.status(err.statusCode).json({
            status: err.status,
            message: err.message,
        });
    } else {

        logger.error('ERROR 💥', err);

        res.status(500).json({
            status: 'error',
            message: MESSAGES.ERROR.INTERNAL_SERVER_ERROR || 'Something went wrong!',
        });
    }
};

export const globalErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    const sanitizeBody = (body: any) => {
        if (!body || typeof body !== 'object') return body;
        const sanitized = { ...body };
        const sensitiveKeys = ['password', 'otp', 'otpHash', 'token', 'authorization', 'aadharNumber', 'aadhaarNumber', 'secret', 'creditCard'];
        for (const key of Object.keys(sanitized)) {
            if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
                sanitized[key] = '[REDACTED]';
            }
        }
        return sanitized;
    };

    logger.error(`[Global Error Handler] ${req.method} ${req.url} ${err.message}`, {
        status: err.status,
        statusCode: err.statusCode,
        stack: err.stack,
        request: {
            method: req.method,
            url: req.url,
            body: sanitizeBody(req.body),
            query: req.query,
            params: req.params,

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            userId: (req.user as any)?.userId
        }
    });

    if (process.env.NODE_ENV === 'development') {
        sendErrorDev(err, res);
    } else {
        let error = { ...err };
        error.message = err.message;

        if (err instanceof ZodError) error = handleZodError(err);
        if (err.code && err.code.startsWith('P')) error = handlePrismaError(err);

        sendErrorProd(error, res);
    }
};
