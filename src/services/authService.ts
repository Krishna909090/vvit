import jwt from 'jsonwebtoken';
import prisma from '../config/prisma';
import { Role } from '@prisma/client';
import logger from '../utils/logger';
import { AppError } from '../utils/AppError';
import { sendBsnlOtp, sendNetcoreEmail } from './integrationService';
import { MESSAGES } from '../constants/messages';

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// Mock OTP generation (in production, use a real SMS provider)
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

export const sendOtp = async (identifier: { phone?: string, email?: string }, role: Role = Role.STUDENT) => {
    let user = null;

    if (identifier.phone) {
        user = await prisma.user.findUnique({ where: { phone: identifier.phone } });
    } else if (identifier.email) {
        user = await prisma.user.findUnique({ where: { email: identifier.email } });
        // Restriction: Students cannot login via Email, they must use Phone
        if (user && user.role === Role.STUDENT) {
            throw new AppError("Students must login using Phone Number", 400);
        }
    }

    // If user doesn't exist
    if (!user) {
        if (identifier.phone) {
            // Create new user with phone (Phone is required by schema)
            user = await prisma.user.create({
                data: {
                    phone: identifier.phone,
                    role: role
                }
            });
        } else {
            // Email provided but user not found. Cannot create user without phone.
            throw new AppError(MESSAGES.ERROR.USER_NOT_FOUND, 404);
        }
    }

    const otp = generateOtp();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    await prisma.user.update({
        where: { id: user.id },
        data: { otp, otpExpiry }
    });

    // Send OTP to both Phone and Email if available
    const promises = [];
    if (user.phone) {
        promises.push(sendBsnlOtp(user.phone, otp));
    }
    if (user.email) {
        promises.push(sendNetcoreEmail(user.email, "VVITU Login OTP", `Your OTP for login is <b>${otp}</b>. Valid for 10 minutes.`));
    }

    await Promise.all(promises);
    logger.info(`[sendOtp] OTP dispatched to user ${user.id} (Phone: ${user.phone}, Email: ${user.email})`);

    return { message: 'OTP sent successfully', otp: otp }; // Returning OTP for dev convenience
};

export const verifyOtp = async (identifier: { phone?: string, email?: string }, otp: string) => {
    let user = null;

    if (identifier.phone) {
        user = await prisma.user.findUnique({ where: { phone: identifier.phone } });
    } else if (identifier.email) {
        user = await prisma.user.findUnique({ where: { email: identifier.email } });
        // Restriction: Students cannot login via Email
        if (user && user.role === Role.STUDENT) {
            throw new AppError("Students must login using Phone Number", 400);
        }
    }

    if (!user || !user.otp || !user.otpExpiry) {
        throw new AppError(MESSAGES.ERROR.INVALID_OTP_REQUEST, 400);
    }

    if (user.otp !== otp) {
        throw new AppError(MESSAGES.ERROR.INVALID_OTP, 400);
    }

    if (user.otpExpiry < new Date()) {
        throw new AppError(MESSAGES.ERROR.OTP_EXPIRED, 400);
    }

    // Clear OTP after successful verification
    await prisma.user.update({
        where: { id: user.id },
        data: { otp: null, otpExpiry: null }
    });

    const token = jwt.sign(
        { userId: user.id, role: user.role },
        JWT_SECRET,
        { expiresIn: '1d' }
    );

    logger.info(`[verifyOtp] Login successful for user=${user.id} role=${user.role}`);

    return {
        token,
        role: user.role,
        id: user.id
    };
};
