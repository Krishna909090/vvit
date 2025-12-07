import { Request, Response, NextFunction } from 'express';
import * as authService from '../services/authService';
import logger from '../utils/logger';

import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';
import { sendResponse } from '../utils/response';
import { maskPhone, maskEmail } from "../utils/mask";


// Controller: Validates request data, triggers OTP verification, and sends auth response.
// Controller: Handles OTP send request from client and delegates to AuthService.
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

  sendResponse({
    res,
    statusCode: 200,
    success: true,
    data: result,
  });
});



// Controller: Validates request data, triggers OTP verification, and sends auth response.
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

export const generateAadhaarOtp = catchAsync(async (req: Request, res: Response) => {
  const { id_number } = req.body;
  logger.info(`[generateAadhaarOtp] request for id_number=${id_number}`);

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

