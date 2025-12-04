import { Request, Response, NextFunction } from 'express';
import * as authService from '../services/authService';
import logger from '../utils/logger';
import { Role } from '@prisma/client';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';
import { sendResponse } from '../utils/response';

export const sendOtp = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[sendOtp] attempt`);
    logger.debug && logger.debug(`[sendOtp] payload=${JSON.stringify(req.body)}`);

    const { phone, email, role } = req.body;

    if (!phone && !email) {
        logger.warn('[sendOtp] missing phone and email');
        throw new AppError(MESSAGES.ERROR.PHONE_REQUIRED, 400); // Or a generic "Identifier required"
    }

    // Pass role to service (defaults to STUDENT if undefined)
    const result = await authService.sendOtp({ phone, email }, role);

    logger.info(`OTP sent to: ${phone || email}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        // message: MESSAGES.SUCCESS.OTP_SENT
        data: result
    });
});

export const verifyOtp = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info('[verifyOtp] attempt');
    logger.debug && logger.debug(`[verifyOtp] payload=${JSON.stringify(req.body)}`);

    const { phone, email, otp } = req.body;

    if ((!phone && !email) || !otp) {
        logger.warn('[verifyOtp] missing identifier or otp');
        throw new AppError(MESSAGES.ERROR.PHONE_OTP_REQUIRED, 400);
    }

    const data = await authService.verifyOtp({ phone, email }, String(otp));

    logger.info(`User logged in via OTP: ${phone || email}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.LOGIN_SUCCESS,
        data
    });
});
