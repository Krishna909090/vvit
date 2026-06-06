

import rateLimit from 'express-rate-limit';
import logger from '../utils/logger';

const createLimiter = (windowMs: number, max: number, label: string) =>
    rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req: any, res: any) => {
            logger.warn(`[RateLimit:${label}] Limit exceeded for IP: ${req.ip}, path: ${req.path}`);
            res.status(429).json({
                success: false,
                message: 'Too many requests. Please try again later.'
            });
        }
    });

export const authRateLimiter = createLimiter(15 * 60 * 1000, 10, 'auth');

export const uploadRateLimiter = createLimiter(15 * 60 * 1000, 30, 'upload');

export const writeRateLimiter = createLimiter(15 * 60 * 1000, 200, 'write');

export const readRateLimiter = createLimiter(15 * 60 * 1000, 200, 'read');

export const generalRateLimiter = createLimiter(15 * 60 * 1000, 200, 'general');

export const qrScanRateLimiter = createLimiter(15 * 60 * 1000, 200, 'qrScan');

export const paymentRateLimiter = createLimiter(15 * 60 * 1000, 20, 'payment');
