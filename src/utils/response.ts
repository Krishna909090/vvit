import { Response } from 'express';

interface ResponseOptions<T> {
    res: Response;
    statusCode: number;
    success: boolean;
    message?: string;
    data?: T;
}

export const sendResponse = <T>({ res, statusCode, success, message, data }: ResponseOptions<T>) => {
    const responsePayload: any = {
        success,
        message
    };

    if (data !== undefined) {
        responsePayload.data = data;
    }

    res.status(statusCode).json(responsePayload);
};
