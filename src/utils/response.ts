import { Response } from 'express';

interface ResponseOptions<T> {
    res: Response;
    statusCode: number;
    success: boolean;
    message?: string;
    data?: T;
    pagination?: { total: number; page: number; limit: number; totalPages: number };
}

export const sendResponse = <T>({ res, statusCode, success, message, data, pagination }: ResponseOptions<T>) => {
    const responsePayload: any = {
        success,
        message
    };

    if (data !== undefined) {
        responsePayload.data = data;
    }

    if (pagination !== undefined) {
        responsePayload.pagination = pagination;
    }

    res.status(statusCode).json(responsePayload);
};
