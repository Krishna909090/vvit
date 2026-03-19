// middlewares/rateLimitMiddleware.ts
// Tiered rate limiting based on endpoint sensitivity

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

// Auth: 1000 requests per 15 minutes (login, OTP, verify)
export const authRateLimiter = createLimiter(15 * 60 * 1000, 1000, 'auth');

// Upload: 1000 requests per 15 minutes
export const uploadRateLimiter = createLimiter(15 * 60 * 1000, 1000, 'upload');

// Write: 1000 requests per 15 minutes (create/update operations)
export const writeRateLimiter = createLimiter(15 * 60 * 1000, 1000, 'write');

// Read: 1000 requests per 15 minutes (list/get operations)
export const readRateLimiter = createLimiter(15 * 60 * 1000, 1000, 'read');

// General: 1000 requests per 15 minutes (fallback for all other endpoints)
export const generalRateLimiter = createLimiter(15 * 60 * 1000, 1000, 'general');

// QR Scan: 1000 requests per 15 minutes (invigilator scanning)
export const qrScanRateLimiter = createLimiter(15 * 60 * 1000, 1000, 'qrScan');

// Payment: 1000 requests per 15 minutes (prevent duplicate payment attempts)
export const paymentRateLimiter = createLimiter(15 * 60 * 1000, 1000, 'payment');
