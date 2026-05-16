import { Request, Response } from "express";
import * as studentAuthService from "./student-auth.service";
import { catchAsync } from "../../utils/catchAsync";
import { AppError } from "../../utils/AppError";
import { sendResponse } from "../../utils/response";
import logger from "../../utils/logger";
import { getClientIp } from "../../utils/auditLogger";

export const studentLogin = catchAsync(async (req: Request, res: Response) => {
  const { rollNumber, password } = req.body;
  logger.info(
    `[POST /auth/student/login] ip=${getClientIp(req)} ua="${req.headers["user-agent"] || "-"}" roll=${rollNumber}`
  );
  const data = await studentAuthService.studentLogin(rollNumber, password);
  sendResponse({
    res,
    statusCode: 200,
    success: true,
    message: "Login successful",
    data,
  });
});

export const studentInitialSetup = catchAsync(async (req: Request, res: Response) => {
  const { rollNumber, dob, aadhaarLast4, newPassword } = req.body;
  logger.info(
    `[POST /auth/student/initial-setup] ip=${getClientIp(req)} ua="${req.headers["user-agent"] || "-"}" roll=${rollNumber}`
  );
  const data = await studentAuthService.studentInitialSetup(rollNumber, dob, aadhaarLast4, newPassword);
  sendResponse({
    res,
    statusCode: 200,
    success: true,
    message: data.message,
    data,
  });
});

export const adminIssueStudentResetOtp = catchAsync(async (req: Request, res: Response) => {
  if (!req.user?.userId) throw new AppError("Authentication required", 401);
  const { rollNumber } = req.body;
  logger.info(
    `[POST /auth/student/admin/issue-otp] ip=${getClientIp(req)} ua="${req.headers["user-agent"] || "-"}" ` +
    `admin=${req.user.userId} roll=${rollNumber}`
  );
  const data = await studentAuthService.adminIssueStudentResetOtp(req.user.userId, rollNumber);
  sendResponse({
    res,
    statusCode: 200,
    success: true,
    message: data.message,
    data,
  });
});

export const studentResetPassword = catchAsync(async (req: Request, res: Response) => {
  const { rollNumber, otp, newPassword } = req.body;
  logger.info(
    `[POST /auth/student/reset-password] ip=${getClientIp(req)} ua="${req.headers["user-agent"] || "-"}" roll=${rollNumber}`
  );
  const data = await studentAuthService.studentResetPassword(rollNumber, otp, newPassword);
  sendResponse({
    res,
    statusCode: 200,
    success: true,
    message: data.message,
    data,
  });
});
