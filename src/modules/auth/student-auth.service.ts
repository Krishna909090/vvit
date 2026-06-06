import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import prisma from "../../config/prisma";
import { Role } from "../../constants/roles";
import logger from "../../utils/logger";
import { AppError } from "../../utils/AppError";
import { getUserPermissions, getUserModules } from "../rbac/rbac.service";
import { encrypt, decrypt } from "../../utils/encryption";

const JWT_SECRET = process.env.JWT_SECRET!;

const OTP_SALT_ROUNDS = 10;
const PASSWORD_SALT_ROUNDS = 10;
const RESET_OTP_TTL_HOURS = 6;
const RESET_OTP_MAX_ATTEMPTS = 5;
const RESET_OTP_DAILY_LIMIT = 3;
const INITIAL_SETUP_FAIL_LOCK = 5;
const INITIAL_SETUP_LOCK_HOURS = 24;

const GENERIC_INVALID_CREDENTIALS = "Invalid credentials";

const generateNumericOtp = (digits: number) => {
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  return crypto.randomInt(min, max + 1).toString();
};

const resolveStudentByRollNumber = async (rollNumberRaw: string) => {
  const rollNumber = rollNumberRaw.trim();
  if (!rollNumber) return null;

  const activeYear = await prisma.academicYear.findFirst({
    where: { isActive: true, isDeleted: false },
    orderBy: { startDate: "desc" },
    select: { id: true },
  });
  if (!activeYear) return null;

  const enrollments = await prisma.studentEnrollment.findMany({
    where: {
      rollNumber,
      academicYearId: activeYear.id,
      status: "ACTIVE",
    },
    select: {
      studentId: true,
      student: {
        select: {
          id: true,
          dob: true,
          aadharNumber: true,
          userId: true,
          user: { select: { id: true, role: true, password: true, isDeleted: true, tokenVersion: true } },
        },
      },
    },
  });

  if (enrollments.length !== 1) return null;
  const student = enrollments[0].student;
  if (!student.user) return null;
  return student;
};

const issueJwtForUser = (userId: string, role: string | null | undefined, tokenVersion: number) => {
  return jwt.sign(
    { userId, role: role ?? Role.STUDENT, tokenVersion },
    JWT_SECRET,
    { expiresIn: (process.env.NODE_ENV === 'development' ? '24h' : (process.env.JWT_EXPIRY || '4h')) as any }
  );
};

const buildLoginPayload = async (userId: string) => {
  const { permissions } = await getUserPermissions(userId);
  const modules = await getUserModules(permissions);
  const groupedPermissions = permissions.reduce((acc: Record<string, string[]>, p: string) => {
    const key = p.split(".")[0];
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});
  return { permissions: groupedPermissions, modules };
};

export const studentLogin = async (rollNumber: string, password: string) => {
  logger.info(`[studentLogin] attempt roll=${rollNumber}`);

  const student = await resolveStudentByRollNumber(rollNumber);
  if (!student || !student.user) {
    logger.warn(`[studentLogin] reject reason=roll_resolution_failed roll=${rollNumber}`);
    throw new AppError(GENERIC_INVALID_CREDENTIALS, 401);
  }

  const user = student.user;

  if (user.isDeleted) {
    logger.warn(`[studentLogin] reject reason=account_blocked userId=${user.id}`);
    throw new AppError("Account is no longer active", 403);
  }

  if (!user.password) {

    logger.warn(`[studentLogin] reject reason=password_not_set userId=${user.id} roll=${rollNumber}`);
    throw new AppError("Password not set. Please complete first-time setup or contact admin.", 403);
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    logger.warn(`[studentLogin] reject reason=password_mismatch userId=${user.id} roll=${rollNumber}`);
    throw new AppError(GENERIC_INVALID_CREDENTIALS, 401);
  }

  const token = issueJwtForUser(user.id, user.role, user.tokenVersion);
  const { permissions, modules } = await buildLoginPayload(user.id);

  logger.info(
    `[studentLogin] success userId=${user.id} role=${user.role} roll=${rollNumber} ` +
    `permissionsCount=${Object.values(permissions).reduce((n, arr) => n + arr.length, 0)} ` +
    `modulesCount=${modules.length} tokenVersion=${user.tokenVersion}`
  );

  return {
    token,
    role: user.role,
    id: user.id,
    permissions,
    modules,
  };
};

export const studentInitialSetup = async (
  rollNumber: string,
  dob: string,
  aadhaarLast4: string,
  newPassword: string
) => {
  logger.info(`[studentInitialSetup] attempt roll=${rollNumber}`);

  const student = await resolveStudentByRollNumber(rollNumber);
  if (!student || !student.user) {
    logger.warn(`[studentInitialSetup] reject reason=roll_resolution_failed roll=${rollNumber}`);
    throw new AppError(GENERIC_INVALID_CREDENTIALS, 401);
  }

  if (student.user.password) {
    logger.warn(
      `[studentInitialSetup] reject reason=already_initialized userId=${student.user.id} roll=${rollNumber}`
    );
    throw new AppError(GENERIC_INVALID_CREDENTIALS, 401);
  }

  if (student.user.isDeleted) {
    logger.warn(
      `[studentInitialSetup] reject reason=account_blocked userId=${student.user.id} roll=${rollNumber}`
    );
    throw new AppError("Account is no longer active", 403);
  }

  const lockSince = new Date(Date.now() - INITIAL_SETUP_LOCK_HOURS * 60 * 60 * 1000);
  const recentFails = await prisma.userOtp.count({
    where: {
      userId: student.user.id,
      type: "INITIAL_SETUP_FAIL",
      createdAt: { gt: lockSince },
    },
  });
  if (recentFails >= INITIAL_SETUP_FAIL_LOCK) {
    logger.warn(
      `[studentInitialSetup] reject reason=locked userId=${student.user.id} roll=${rollNumber} ` +
      `fails=${recentFails} window_h=${INITIAL_SETUP_LOCK_HOURS}`
    );
    throw new AppError("Too many failed attempts. Please contact admin.", 429);
  }

  const dobMatch =
    student.dob instanceof Date &&
    student.dob.toISOString().slice(0, 10) === dob;

  const aadhaarMatch =
    typeof student.aadharNumber === "string" &&
    student.aadharNumber.length >= 4 &&
    student.aadharNumber.slice(-4) === aadhaarLast4;

  if (!dobMatch || !aadhaarMatch) {

    await prisma.userOtp.create({
      data: {
        userId: student.user.id,
        type: "INITIAL_SETUP_FAIL",
        otpHash: "n/a",
        expiresAt: new Date(Date.now() + INITIAL_SETUP_LOCK_HOURS * 60 * 60 * 1000),
        used: true,
      },
    });
    logger.warn(
      `[studentInitialSetup] reject reason=pii_mismatch userId=${student.user.id} roll=${rollNumber} ` +
      `dobMatch=${dobMatch} aadhaarMatch=${aadhaarMatch} priorFails=${recentFails}`
    );
    throw new AppError(GENERIC_INVALID_CREDENTIALS, 401);
  }

  if (newPassword === rollNumber || newPassword === aadhaarLast4 || newPassword === dob) {
    logger.warn(
      `[studentInitialSetup] reject reason=weak_password userId=${student.user.id} roll=${rollNumber}`
    );
    throw new AppError("Password is too weak", 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);

  const result = await prisma.user.updateMany({
    where: { id: student.user.id, password: null },
    data: { password: passwordHash, tokenVersion: { increment: 1 } },
  });

  if (result.count !== 1) {

    logger.warn(
      `[studentInitialSetup] reject reason=race_lost userId=${student.user.id} roll=${rollNumber}`
    );
    throw new AppError(GENERIC_INVALID_CREDENTIALS, 401);
  }

  await prisma.auditLog.create({
    data: {
      userId: student.user.id,
      action: "STUDENT_INITIAL_PASSWORD_SET",
      entity: "User",
      entityId: student.user.id,
    },
  });

  logger.info(`[studentInitialSetup] success userId=${student.user.id} roll=${rollNumber}`);
  return { message: "Password set. Please log in." };
};

export const adminIssueStudentResetOtp = async (
  adminUserId: string,
  rollNumber: string
) => {
  logger.info(`[adminIssueStudentResetOtp] attempt admin=${adminUserId} roll=${rollNumber}`);

  const student = await resolveStudentByRollNumber(rollNumber);
  if (!student || !student.user) {
    logger.warn(
      `[adminIssueStudentResetOtp] reject reason=student_not_found admin=${adminUserId} roll=${rollNumber}`
    );
    throw new AppError("Student not found for the active academic year", 404);
  }

  if (student.user.isDeleted) {
    logger.warn(
      `[adminIssueStudentResetOtp] reject reason=student_blocked admin=${adminUserId} ` +
      `studentUserId=${student.user.id} roll=${rollNumber}`
    );
    throw new AppError("Student account is blocked", 403);
  }

  const now = new Date();

  const existing = await prisma.userOtp.findFirst({
    where: {
      userId: student.user.id,
      type: "PASSWORD_RESET",
      used: false,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing && existing.otpEncrypted) {
    let otpPlain: string;
    try {
      otpPlain = decrypt(existing.otpEncrypted);
    } catch (e) {

      logger.error(
        `[adminIssueStudentResetOtp] decrypt failed otpId=${existing.id} ` +
        `studentUserId=${student.user.id} — falling back to fresh issuance: ${String(e)}`
      );
      otpPlain = "";
    }
    if (otpPlain) {
      logger.info(
        `[adminIssueStudentResetOtp] redisplay otpId=${existing.id} ` +
        `admin=${adminUserId} studentUserId=${student.user.id} roll=${rollNumber} ` +
        `attemptsRemaining=${Math.max(0, existing.maxAttempts - existing.attempts)} ` +
        `expiresAt=${existing.expiresAt.toISOString()}`
      );
      await prisma.auditLog.create({
        data: {
          userId: adminUserId,
          action: "STUDENT_RESET_OTP_REDISPLAYED",
          entity: "User",
          entityId: student.user.id,
          details: { rollNumber, otpId: existing.id },
        },
      });
      return {
        otp: otpPlain,
        expiresAt: existing.expiresAt,
        attemptsRemaining: Math.max(0, existing.maxAttempts - existing.attempts),
        message: `Existing OTP returned. Valid until ${existing.expiresAt.toISOString()}. Share with student in person only.`,
        reissued: false,
      };
    }
  }

  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const last24hCount = await prisma.userOtp.count({
    where: {
      userId: student.user.id,
      type: "PASSWORD_RESET",
      createdAt: { gt: since24h },
    },
  });
  if (last24hCount >= RESET_OTP_DAILY_LIMIT) {
    logger.warn(
      `[adminIssueStudentResetOtp] reject reason=daily_cap admin=${adminUserId} ` +
      `studentUserId=${student.user.id} roll=${rollNumber} ` +
      `last24h=${last24hCount} cap=${RESET_OTP_DAILY_LIMIT}`
    );
    throw new AppError("Daily reset limit reached for this student.", 429);
  }

  const otp = generateNumericOtp(8);
  const otpHash = await bcrypt.hash(otp, OTP_SALT_ROUNDS);
  const otpEncrypted = encrypt(otp);
  const expiresAt = new Date(now.getTime() + RESET_OTP_TTL_HOURS * 60 * 60 * 1000);

  await prisma.$transaction([

    prisma.userOtp.updateMany({
      where: { userId: student.user.id, type: "PASSWORD_RESET", used: false },
      data: { used: true, otpEncrypted: null },
    }),
    prisma.userOtp.create({
      data: {
        userId: student.user.id,
        type: "PASSWORD_RESET",
        otpHash,
        otpEncrypted,
        expiresAt,
        maxAttempts: RESET_OTP_MAX_ATTEMPTS,
        createdBy: adminUserId,
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: adminUserId,
        action: "STUDENT_RESET_OTP_ISSUED",
        entity: "User",
        entityId: student.user.id,
        details: { rollNumber },
      },
    }),
  ]);

  logger.info(
    `[adminIssueStudentResetOtp] issued admin=${adminUserId} studentUserId=${student.user.id} ` +
    `roll=${rollNumber} expiresAt=${expiresAt.toISOString()} ` +
    `ttlHours=${RESET_OTP_TTL_HOURS} dailyCount=${last24hCount + 1}/${RESET_OTP_DAILY_LIMIT}`
  );

  return {
    otp,
    expiresAt,
    attemptsRemaining: RESET_OTP_MAX_ATTEMPTS,
    message: `OTP valid for ${RESET_OTP_TTL_HOURS} hours. Share with student in person only.`,
    reissued: true,
  };
};

export const studentResetPassword = async (
  rollNumber: string,
  otp: string,
  newPassword: string
) => {
  logger.info(`[studentResetPassword] attempt roll=${rollNumber}`);

  const student = await resolveStudentByRollNumber(rollNumber);
  if (!student || !student.user) {
    logger.warn(`[studentResetPassword] reject reason=roll_resolution_failed roll=${rollNumber}`);
    throw new AppError(GENERIC_INVALID_CREDENTIALS, 401);
  }

  if (student.user.isDeleted) {
    logger.warn(
      `[studentResetPassword] reject reason=account_blocked userId=${student.user.id} roll=${rollNumber}`
    );
    throw new AppError("Account is no longer active", 403);
  }

  const now = new Date();
  const userOtp = await prisma.userOtp.findFirst({
    where: {
      userId: student.user.id,
      type: "PASSWORD_RESET",
      used: false,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!userOtp) {
    logger.warn(
      `[studentResetPassword] reject reason=no_active_otp userId=${student.user.id} roll=${rollNumber}`
    );
    throw new AppError("No active OTP. Please ask admin to issue a new one.", 400);
  }

  const after = await prisma.userOtp.update({
    where: { id: userOtp.id },
    data: { attempts: { increment: 1 } },
    select: { id: true, otpHash: true, attempts: true, maxAttempts: true, expiresAt: true, used: true },
  });

  if (after.attempts > after.maxAttempts) {
    await prisma.userOtp.update({
      where: { id: after.id },
      data: { used: true, otpEncrypted: null },
    });
    logger.warn(
      `[studentResetPassword] reject reason=max_attempts userId=${student.user.id} roll=${rollNumber} ` +
      `otpId=${after.id} attempts=${after.attempts}/${after.maxAttempts}`
    );
    throw new AppError("Too many incorrect attempts. Ask admin for a new OTP.", 429);
  }

  if (after.expiresAt < now || after.used) {
    logger.warn(
      `[studentResetPassword] reject reason=expired userId=${student.user.id} roll=${rollNumber} ` +
      `otpId=${after.id} expiresAt=${after.expiresAt.toISOString()} used=${after.used}`
    );
    throw new AppError("OTP has expired. Please ask admin for a new one.", 400);
  }

  const ok = await bcrypt.compare(otp, after.otpHash);
  if (!ok) {
    logger.warn(
      `[studentResetPassword] reject reason=invalid_otp userId=${student.user.id} roll=${rollNumber} ` +
      `otpId=${after.id} attempts=${after.attempts}/${after.maxAttempts}`
    );
    throw new AppError("Invalid OTP", 400);
  }

  if (newPassword === rollNumber || newPassword === otp) {
    logger.warn(
      `[studentResetPassword] reject reason=weak_password userId=${student.user.id} roll=${rollNumber} otpId=${after.id}`
    );
    throw new AppError("Password is too weak", 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, PASSWORD_SALT_ROUNDS);

  await prisma.$transaction([
    prisma.userOtp.update({
      where: { id: after.id },
      data: { used: true, otpEncrypted: null },
    }),
    prisma.user.update({
      where: { id: student.user.id },
      data: {
        password: passwordHash,
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: student.user.id,
        action: "STUDENT_PASSWORD_RESET",
        entity: "User",
        entityId: student.user.id,
      },
    }),
  ]);

  logger.info(
    `[studentResetPassword] success userId=${student.user.id} roll=${rollNumber} otpId=${after.id}`
  );
  return { message: "Password updated. Please log in." };
};
