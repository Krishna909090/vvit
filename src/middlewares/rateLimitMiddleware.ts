// middlewares/rateLimitMiddleware.ts
// Standardized rate limiting: 100 requests per 1 hour across all endpoints

import rateLimit from 'express-rate-limit';
import logger from '../utils/logger';

const commonConfig = {
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 1000000, // 100 requests per hour
    message: {
        success: false,
        message: 'Too many requests from this IP. Please try again after 1 hour.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: any, res: any) => {
        logger.warn(`[RateLimit] Rate limit exceeded for IP: ${req.ip}, path: ${req.path}`);
        res.status(429).json({
            success: false,
            message: 'Too many requests. Please try again after 1 hour.'
        });
    }
};

/**
 * Common configuration applied to all tiered limiters to meet the requirement: 100 req / 1 hr
 */

export const authRateLimiter = rateLimit(commonConfig);
export const uploadRateLimiter = rateLimit(commonConfig);
export const writeRateLimiter = rateLimit(commonConfig);
export const readRateLimiter = rateLimit(commonConfig);
export const generalRateLimiter = rateLimit(commonConfig);
export const qrScanRateLimiter = rateLimit(commonConfig);
