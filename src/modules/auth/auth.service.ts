import crypto from "crypto";
import jwt from "jsonwebtoken";
import axios from "axios";
import bcrypt from "bcryptjs";
import prisma from '../../config/prisma';
import { Role } from '../../constants/roles'; // Updated Import
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { sendBsnlOtp, sendZeptoEmail } from '../integration/integration.service';
import { MESSAGES } from '../../constants/messages';
import { maskPhone, maskEmail } from '../../utils/mask';
import { getUserPermissions, getUserModules } from '../rbac/rbac.service';

// JWT_SECRET is validated on startup by envValidator - no fallback needed
const JWT_SECRET = process.env.JWT_SECRET!;

// In-memory token blacklist for logout. Tokens auto-expire so this stays bounded.
const tokenBlacklist = new Map<string, number>(); // token → expiresAt (epoch ms)

// Clean up expired entries every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [token, expiresAt] of tokenBlacklist) {
        if (expiresAt < now) tokenBlacklist.delete(token);
    }
}, 30 * 60 * 1000);

export const blacklistToken = (token: string, expiresAt: number) => {
    tokenBlacklist.set(token, expiresAt);
};

export const isTokenBlacklisted = (token: string): boolean => {
    return tokenBlacklist.has(token);
};
const OTP_SALT_ROUNDS = 10;
const OTP_MAX_ATTEMPTS = 5;
const STUDENT_OTP_EXPIRY_MIN = 10;
const STAFF_OTP_EXPIRY_MIN = 5;


// Generate 6-digit numeric OTP securely
const generateOtp = () => crypto.randomInt(100000, 999999).toString();

// Returns true if the student is enrolled in the active academic year (i.e. has
// a rollNumber). Such students must log in via /auth/student/login (rollNumber +
// password); the phone-OTP path is only for pre-admission applicants.
const studentHasActiveEnrollment = async (userId: string): Promise<boolean> => {
  const activeYear = await prisma.academicYear.findFirst({
    where: { isActive: true, isDeleted: false },
    orderBy: { startDate: "desc" },
    select: { id: true },
  });
  if (!activeYear) return false;

  const enrollment = await prisma.studentEnrollment.findFirst({
    where: {
      academicYearId: activeYear.id,
      status: "ACTIVE",
      student: { userId },
    },
    select: { id: true },
  });
  return !!enrollment;
};

const ENROLLED_STUDENT_OTP_BLOCK_MSG =
  "Please use the ERP application, not the CMS platform. Log in with your roll number and password.";

// Service: Verifies user identity, auto-registers student users by phone,
// generates a hashed OTP, stores it in UserOtp, and triggers notification(s).
export const sendOtp = async (identifier: { phone?: string; email?: string }) => {
  const phone = identifier.phone?.trim();
  const email = identifier.email?.trim().toLowerCase();

  if (!phone && !email) {
    throw new AppError("Phone or Email is required", 400);
  }

  let user = null;
  let isNewUser = false;

  if (phone) {
    user = await prisma.user.findUnique({ where: { phone } });
  } else if (email) {
    user = await prisma.user.findUnique({ where: { email } });

    if (user && user.role === Role.STUDENT) {
      throw new AppError("Students must login using Phone Number", 400);
    }
  }

  if (!user) {
    if (phone) {
      // 1. Create User
      user = await prisma.user.create({
        data: {
          phone,
          role: Role.STUDENT,
        },
      });

      // 2. Assign to Student Group
      const studentGroup = await prisma.group.findUnique({ where: { name: 'StudentGroup' } });
      if (studentGroup) {
        await prisma.userGroup.create({
          data: {
            userId: user.id,
            groupId: studentGroup.id,
          },
        });
      } else {
        logger.error(`[sendOtp] CRITICAL: StudentGroup not found. User ${user.id} created without group.`);
      }

      isNewUser = true;
      logger.info(
        `[sendOtp] New STUDENT user created: id=${user.id}, phone=${maskPhone(phone)}`
      );
    } else {
      throw new AppError(MESSAGES.ERROR.USER_NOT_FOUND, 404);
    }
  } else {
    if (user.isDeleted) {
      throw new AppError("Admin blocked you", 403);
    }

    if (user.role === Role.STUDENT && (await studentHasActiveEnrollment(user.id))) {
      logger.warn(
        `[sendOtp] reject reason=enrolled_student_must_use_erp userId=${user.id} phone=${maskPhone(
          user.phone
        )}`
      );
      throw new AppError(ENROLLED_STUDENT_OTP_BLOCK_MSG, 400);
    }

    logger.info(
      `[sendOtp] Existing user: id=${user.id}, role=${user.role}, phone=${maskPhone(
        user.phone
      )}, email=${maskEmail(user.email)}`
    );
  }

  const otp = generateOtp(); // e.g. 6-digit numeric
  const otpHash = await bcrypt.hash(otp, OTP_SALT_ROUNDS);

  const expiresInMinutes =
    user.role === Role.STUDENT ? STUDENT_OTP_EXPIRY_MIN : STAFF_OTP_EXPIRY_MIN;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60 * 1000);

  await prisma.$transaction([
    prisma.userOtp.updateMany({
      where: {
        userId: user.id,
        type: "LOGIN",
        used: false,
      },
      data: { used: true },
    }),
    prisma.userOtp.create({
      data: {
        userId: user.id,
        type: "LOGIN",
        otpHash,
        expiresAt,
        maxAttempts: OTP_MAX_ATTEMPTS,
      },
    }),
  ]);

  try {
    const notifications: Promise<unknown>[] = [];

    if (user.phone) {
      notifications.push(sendBsnlOtp(user.phone, otp, String(expiresInMinutes)));
    }

    if (user.email && user.role !== Role.STUDENT) {
      notifications.push(
        sendZeptoEmail(
          user.email,
          "VVITU Login OTP",
          `Your OTP for login is <b>${otp}</b>. Valid for ${expiresInMinutes} minutes.`
        )
      );
    }

    await Promise.all(notifications);
  } catch (error) {
    logger.error(
      `[sendOtp] Notification dispatch failed for userId=${user.id}: ${String(error)}`
    );
  }

  logger.info(
    `[sendOtp] OTP dispatched to userId=${user.id}, phone=${maskPhone(
      user.phone
    )}, email=${maskEmail(user.email)}`
  );

  return { message: "OTP sent successfully", isNewUser, otp };
};




// Service: Validates OTP using hashed comparison, enforces channel rules,
// attempts + lockout, expiry, and generates access token on success.
export const verifyOtp = async (
  identifier: { phone?: string; email?: string },
  otp: string
) => {
  let user = null;

  if (identifier.phone) {
    user = await prisma.user.findUnique({ where: { phone: identifier.phone } });
  } else if (identifier.email) {
    user = await prisma.user.findUnique({ where: { email: identifier.email } });

    if (user && user.role === Role.STUDENT) {
      throw new AppError("Students must login using Phone Number", 400);
    }
  }

  if (!user) {
    logger.warn(
      `[verifyOtp] user not found for phone=${maskPhone(
        identifier.phone
      )}, email=${maskEmail(identifier.email)}`
    );
    throw new AppError(MESSAGES.ERROR.INVALID_OTP_REQUEST, 400);
  }

  if (user.role === Role.STUDENT && (await studentHasActiveEnrollment(user.id))) {
    logger.warn(
      `[verifyOtp] reject reason=enrolled_student_must_use_erp userId=${user.id}`
    );
    throw new AppError(ENROLLED_STUDENT_OTP_BLOCK_MSG, 400);
  }

  const now = new Date();

  const userOtp = await prisma.userOtp.findFirst({
    where: {
      userId: user.id,
      type: "LOGIN",
      used: false,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!userOtp) {
    logger.warn(
      `[verifyOtp] no active OTP for userId=${user.id}, phone=${maskPhone(
        user.phone
      )}, email=${maskEmail(user.email)}`
    );
    throw new AppError(MESSAGES.ERROR.INVALID_OTP_REQUEST, 400);
  }

  if (userOtp.attempts >= userOtp.maxAttempts) {
    await prisma.userOtp.update({
      where: { id: userOtp.id },
      data: { used: true },
    });

    logger.warn(
      `[verifyOtp] max attempts reached for userId=${user.id}, phone=${maskPhone(
        user.phone
      )}, email=${maskEmail(user.email)}`
    );

    throw new AppError(
      "Too many incorrect OTP attempts. Please request a new OTP.",
      429
    );
  }

  const isMatch = await bcrypt.compare(otp, userOtp.otpHash);

  if (!isMatch) {
    const updatedOtp = await prisma.userOtp.update({
      where: { id: userOtp.id },
      data: {
        attempts: { increment: 1 },
      },
    });

    logger.warn(
      `[verifyOtp] invalid OTP for userId=${user.id}, attempts=${
        updatedOtp.attempts
      }, phone=${maskPhone(user.phone)}, email=${maskEmail(user.email)}`
    );

    throw new AppError(MESSAGES.ERROR.INVALID_OTP, 400);
  }

  if (userOtp.expiresAt < now) {
    await prisma.userOtp.update({
      where: { id: userOtp.id },
      data: { used: true },
    });

    logger.warn(
      `[verifyOtp] expired OTP for userId=${user.id}, phone=${maskPhone(
        user.phone
      )}, email=${maskEmail(user.email)}`
    );

    throw new AppError(MESSAGES.ERROR.OTP_EXPIRED, 400);
  }

  await prisma.userOtp.update({
    where: { id: userOtp.id },
    data: {
      used: true,
      attempts: { increment: 1 }, // also increment on success
    },
  });

  const token = jwt.sign(
    { userId: user.id, role: user.role },
    JWT_SECRET,
    { expiresIn: (process.env.JWT_EXPIRY || "4h") as any }
  );

  logger.info(
    `[verifyOtp] Login successful: userId=${user.id}, role=${user.role}, phone=${maskPhone(
      user.phone
    )}, email=${maskEmail(user.email)}`
  );

  // Fetch Permissions and Modules
  const { permissions } = await getUserPermissions(user.id);
  const modules = await getUserModules(permissions);

  // Group permissions by module
  // Group permissions by module
  const groupedPermissions = permissions.reduce((acc: any, p: string) => {
    const key = p.split('.')[0];
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});

  return {
    token,
    role: user.role,
    id: user.id,
    phone: user.phone,
    permissions: groupedPermissions,
    modules
  };
};

// Service: Password Login for Staff/Admins
export const login = async (identifier: { phone?: string; email?: string }, password: string) => {
  let user = null;
  if (identifier.phone) {
    user = await prisma.user.findUnique({ where: { phone: identifier.phone } });
  } else if (identifier.email) {
    user = await prisma.user.findUnique({ where: { email: identifier.email } });
  }

  if (!user) throw new AppError("Invalid credentials", 400);

  if (user.isDeleted) throw new AppError("Admin blocked you", 403);

  // Students use OTP
  if (user?.role === Role.STUDENT) throw new AppError("Students must login via OTP", 400);

  if (!user.password) throw new AppError("Password login not enabled for this user", 400);

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) throw new AppError("Invalid credentials", 400);

  const token = jwt.sign(
    { userId: user.id, role: user.role },
    JWT_SECRET,
    { expiresIn: (process.env.JWT_EXPIRY || "4h") as any }
  );

  logger.info(`[login] Password login success: userId=${user.id}`);

  // Fetch Permissions and Modules
  const { permissions } = await getUserPermissions(user.id);
  const modules = await getUserModules(permissions);

  // Group permissions by module
  // Group permissions by module
  const groupedPermissions = permissions.reduce((acc: any, p: string) => {
    const key = p.split('.')[0];
    if (!acc[key]) acc[key] = [];
    acc[key].push(p);
    return acc;
  }, {});

  logger.info(`[login] Returning data: role=${user.role}, permissionsCount=${permissions.length}, modulesCount=${modules.length}`);

  return { token, role: user.role, id: user.id, permissions: groupedPermissions, modules };
};

export const generateAadhaarOtp = async (idNumber: string) => {
  const apiKey = process.env.QUICK_KYC_API_KEY;
  if (!apiKey) {
    throw new AppError("Quick KYC API key is not configured", 500);
  }

  try {
    const response = await axios.post(
      "https://api.quickekyc.com/api/v1/aadhaar-v2/generate-otp",
      {
        key: apiKey,
        id_number: idNumber,
      }
    );

    if (response.data && (response.data.status === 'error' || response.data.status === 'fail')) {
        throw new AppError(
            response.data.message || "Failed to generate Aadhaar OTP", 
            response.data.status_code || 400
        );
    }

    return response.data;
  } catch (error: any) {
    logger.error(`[generateAadhaarOtp] Error: ${error.message}`, {
       response: error.response?.data,
       status: error.response?.status
    });
    throw new AppError(
      error.response?.data?.message || "Failed to generate Aadhaar OTP",
      error.response?.status || 500
    );
  }
};

export const submitAadhaarOtp = async (requestId: string | number, otp: string) => {
  const apiKey = process.env.QUICK_KYC_API_KEY;
  if (!apiKey) {
    throw new AppError("Quick KYC API key is not configured", 500);
  }

  try {
    const response = await axios.post(
      "https://api.quickekyc.com/api/v1/aadhaar-v2/submit-otp",
      {
        key: apiKey,
        request_id: requestId,
        otp: otp
      }
    );

    if (response.data && (response.data.status === 'error' || response.data.status === 'fail')) {
        throw new AppError(
            response.data.message || "Failed to submit Aadhaar OTP verification", 
            response.data.status_code || 400
        );
    }

    return response.data;
  } catch (error: any) {
    logger.error(`[submitAadhaarOtp] Error: ${error.message}`, {
       response: error.response?.data,
       status: error.response?.status
    });
    throw new AppError(
      error.message || error.response?.data?.message || "Failed to submit Aadhaar OTP",
      (error.statusCode && error.statusCode !== 500) ? error.statusCode : (error.response?.status || 500)
    );
  }
};



