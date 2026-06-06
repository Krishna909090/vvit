import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import * as authService from './auth.service';
import logger from '../../utils/logger';

import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { maskPhone, maskEmail } from '../../utils/mask';
import { invalidatePermissionCache } from '../../middleware/rbac.middleware';

export const sendOtp = catchAsync(async (req: Request, res: Response) => {
  const { phone, email } = req.body;

  logger.info(
    `[sendOtp] attempt: phone=${maskPhone(phone)}, email=${maskEmail(email)}`
  );

  if (!phone && !email) {
    logger.warn('[sendOtp] missing phone and email');
    throw new AppError(MESSAGES.ERROR.PHONE_REQUIRED, 400);
  }

  const result = await authService.sendOtp({ phone, email });

  logger.info(
    `[sendOtp] success: phone=${maskPhone(phone)}, email=${maskEmail(email)}`
  );

  if (process.env.NODE_ENV !== 'development') delete (result as any).otp;

  sendResponse({
    res,
    statusCode: 200,
    success: true,
    data: result,
  });
});

export const verifyOtp = catchAsync(async (req: Request, res: Response) => {
  logger.info('[verifyOtp] attempt');

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

export const login = catchAsync(async (req: Request, res: Response) => {
    logger.info('[login] Password login attempt');
    const { phone, email, password } = req.body;
    
    if ((!phone && !email) || !password) {
        throw new AppError("Phone/Email and Password are required", 400);
    }
    
    const tokenData = await authService.login({ phone, email }, password);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Login successful",
        data: tokenData
    });
});

export const generateAadhaarOtp = catchAsync(async (req: Request, res: Response) => {
  const { id_number } = req.body;
  logger.info(`[generateAadhaarOtp] request for id_number=[REDACTED]`);

  const result = await authService.generateAadhaarOtp(id_number);

  sendResponse({
    res,
    statusCode: 200,
    success: true,
    message: "Aadhaar OTP generated successfully",
    data: result
  });
});

export const submitAadhaarOtp = catchAsync(async (req: Request, res: Response) => {
  const { request_id, otp } = req.body;
  logger.info(`[submitAadhaarOtp] request for request_id=${request_id}`);

  const result = await authService.submitAadhaarOtp(request_id, otp);

  sendResponse({
    res,
    statusCode: 200,
    success: true,
    message: "Aadhaar OTP verified successfully",
    data: result
  });
});

export const logout = catchAsync(async (req: Request, res: Response) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) throw new AppError('No token provided', 400);

    const decoded = jwt.decode(token) as { exp?: number, userId?: string };
    const maxExp = Math.floor(Date.now() / 1000) + 86400;
    const clampedExp = decoded?.exp && decoded.exp > maxExp ? maxExp : decoded?.exp;
    const expiresAt = clampedExp ? clampedExp * 1000 : Date.now() + 4 * 60 * 60 * 1000;

    authService.blacklistToken(token, expiresAt);

    if (decoded?.userId) {
        invalidatePermissionCache(decoded.userId);
    }

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Logged out successfully'
    });
});

