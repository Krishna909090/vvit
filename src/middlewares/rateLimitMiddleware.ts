// middlewares/rateLimitMiddleware.ts
// Enhanced rate limiting with tiered limits for different endpoint types

import rateLimit from 'express-rate-limit';
import logger from '../utils/logger';

/**
 * Strict rate limiter for authentication endpoints
 * Prevents brute force attacks on login/OTP endpoints
 */
export const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
    message: {
        success: false,
        message: 'Too many authentication attempts from this IP. Please try again after 15 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn(`[RateLimit] Auth rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            message: 'Too many authentication attempts. Please try again after 15 minutes.'
        });
    }
});

/**
 * Rate limiter for file upload endpoints
 * Allows 30 uploads per hour to accommodate students who may need multiple attempts
 */
export const uploadRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 30, // 30 uploads per hour (student-friendly)
    message: {
        success: false,
        message: 'Too many file uploads from this IP. Please try again after 1 hour.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn(`[RateLimit] Upload rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            message: 'Too many file uploads. You have reached the limit of 30 uploads per hour. Please try again later.'
        });
    }
});

/**
 * Rate limiter for write operations (POST, PUT, DELETE)
 * Prevents data manipulation abuse
 */
export const writeRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // 50 write operations per 15 minutes
    message: {
        success: false,
        message: 'Too many requests from this IP. Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'GET', // Skip GET requests
    handler: (req, res) => {
        logger.warn(`[RateLimit] Write rate limit exceeded for IP: ${req.ip}, method: ${req.method}`);
        res.status(429).json({
            success: false,
            message: 'Too many write operations. Please try again later.'
        });
    }
});

/**
 * Rate limiter for read operations (GET)
 * More lenient than write operations
 */
export const readRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // 200 read operations per 15 minutes
    message: {
        success: false,
        message: 'Too many requests from this IP. Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method !== 'GET', // Only apply to GET requests
    handler: (req, res) => {
        logger.warn(`[RateLimit] Read rate limit exceeded for IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            message: 'Too many read requests. Please try again later.'
        });
    }
});

/**
 * General API rate limiter (fallback)
 * Applied to all routes not covered by specific limiters
 */
export const generalRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per 15 minutes
    message: {
        success: false,
        message: 'Too many requests from this IP. Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn(`[RateLimit] General rate limit exceeded for IP: ${req.ip}, path: ${req.path}`);
        res.status(429).json({
            success: false,
            message: 'Too many requests. Please try again later.'
        });
    }
});

/**
 * Aggressive rate limiter for QR scan endpoints
 * Prevents abuse of attendance marking system
 */
export const qrScanRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 scans per minute (reasonable for legitimate use)
    message: {
        success: false,
        message: 'Too many QR scan attempts. Please wait before scanning again.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        logger.warn(`[RateLimit] QR scan rate limit exceeded for IP: ${req.ip}, user: ${req.user?.userId}`);
        res.status(429).json({
            success: false,
            message: 'Too many QR scan attempts. Please wait before scanning again.'
        });
    }
});
