// middlewares/inputSanitization.ts
// Input sanitization to prevent XSS, NoSQL injection, and other attacks

import { Request, Response, NextFunction } from 'express';
import validator from 'validator';
import logger from '../utils/logger';

/**
 * Sanitize string to prevent XSS attacks
 * Only sanitizes if the string looks like user input (not UUIDs, dates, etc.)
 */
function sanitizeString(value: string): string {
    // Don't sanitize UUIDs (36 chars with hyphens)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        return value;
    }
    
    // Don't sanitize ISO dates
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/.test(value)) {
        return value;
    }
    
    // Don't sanitize numbers (as strings)
    if (/^\d+(\.\d+)?$/.test(value)) {
        return value;
    }
    
    // Don't sanitize phone numbers (10-15 digits)
    if (/^\d{10,15}$/.test(value)) {
        return value;
    }
    
    // Only sanitize actual text content
    // Remove script tags
    let sanitized = value.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    
    // Remove event handlers (onclick, onerror, etc.)
    sanitized = sanitized.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
    
    // Remove javascript: protocol
    sanitized = sanitized.replace(/javascript:/gi, '');
    
    // Remove dangerous HTML tags but keep the content
    sanitized = sanitized.replace(/<(script|iframe|object|embed|link|style)[^>]*>.*?<\/\1>/gi, '');
    
    return sanitized;
}

/**
 * Sanitize object recursively
 */
function sanitizeObject(obj: any): any {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj === 'string') {
        return sanitizeString(obj);
    }

    if (typeof obj === 'number' || typeof obj === 'boolean') {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeObject(item));
    }

    if (typeof obj === 'object') {
        const sanitized: any = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                // Don't sanitize key names - they're controlled by API schema
                sanitized[key] = sanitizeObject(obj[key]);
            }
        }
        return sanitized;
    }

    return obj;
}

/**
 * Middleware to sanitize request body, query, and params
 */
export const sanitizeInput = (req: Request, res: Response, next: NextFunction) => {
    try {
        // Sanitize request body (safe to modify)
        if (req.body && typeof req.body === 'object') {
            req.body = sanitizeObject(req.body);
        }

        // Sanitize query parameters (create new object to avoid read-only error)
        if (req.query && typeof req.query === 'object') {
            const sanitizedQuery = sanitizeObject(req.query);
            // Replace query object properties individually
            Object.keys(req.query).forEach(key => delete (req.query as any)[key]);
            Object.assign(req.query, sanitizedQuery);
        }

        // Sanitize URL parameters (create new object to avoid read-only error)
        if (req.params && typeof req.params === 'object') {
            const sanitizedParams = sanitizeObject(req.params);
            // Replace params object properties individually
            Object.keys(req.params).forEach(key => delete req.params[key]);
            Object.assign(req.params, sanitizedParams);
        }

        next();
    } catch (error) {
        logger.error(`[InputSanitization] Error sanitizing input: ${error}`);
        next(error);
    }
};


/**
 * Validate and sanitize email
 */
export function sanitizeEmail(email: string): string | null {
    if (!email || typeof email !== 'string') {
        return null;
    }

    const trimmed = email.trim().toLowerCase();
    
    if (!validator.isEmail(trimmed)) {
        return null;
    }

    return validator.normalizeEmail(trimmed) || trimmed;
}

/**
 * Validate and sanitize phone number
 */
export function sanitizePhone(phone: string): string | null {
    if (!phone || typeof phone !== 'string') {
        return null;
    }

    // Remove all non-digit characters
    const digitsOnly = phone.replace(/\D/g, '');
    
    // Check if it's a valid length (10 digits for Indian numbers)
    if (digitsOnly.length !== 10) {
        return null;
    }

    return digitsOnly;
}

/**
 * Validate and sanitize Aadhar number
 */
export function sanitizeAadhar(aadhar: string): string | null {
    if (!aadhar || typeof aadhar !== 'string') {
        return null;
    }

    // Remove all non-digit characters
    const digitsOnly = aadhar.replace(/\D/g, '');
    
    // Aadhar must be exactly 12 digits
    if (digitsOnly.length !== 12) {
        return null;
    }

    return digitsOnly;
}

/**
 * Sanitize alphanumeric string (for IDs, codes, etc.)
 */
export function sanitizeAlphanumeric(value: string, maxLength: number = 50): string | null {
    if (!value || typeof value !== 'string') {
        return null;
    }

    // Allow only alphanumeric characters, hyphens, and underscores
    const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '');
    
    if (sanitized.length === 0 || sanitized.length > maxLength) {
        return null;
    }

    return sanitized;
}

/**
 * Prevent NoSQL injection in MongoDB-like queries
 * (Useful if you ever use MongoDB alongside PostgreSQL)
 */
export function preventNoSQLInjection(obj: any): any {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(item => preventNoSQLInjection(item));
    }

    const cleaned: any = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            // Remove keys that start with $ (MongoDB operators)
            if (key.startsWith('$')) {
                logger.warn(`[NoSQLInjection] Blocked key: ${key}`);
                continue;
            }
            cleaned[key] = preventNoSQLInjection(obj[key]);
        }
    }

    return cleaned;
}

/**
 * Validate URL
 */
export function sanitizeURL(url: string): string | null {
    if (!url || typeof url !== 'string') {
        return null;
    }

    const trimmed = url.trim();
    
    if (!validator.isURL(trimmed, {
        protocols: ['http', 'https'],
        require_protocol: true
    })) {
        return null;
    }

    return trimmed;
}

/**
 * Sanitize filename to prevent directory traversal
 */
export function sanitizeFilename(filename: string): string {
    if (!filename || typeof filename !== 'string') {
        return 'file';
    }

    // Remove path separators and null bytes
    let sanitized = filename.replace(/[\/\\]/g, '_').replace(/\0/g, '');
    
    // Remove any non-alphanumeric characters except dots, dashes, and underscores
    sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Remove leading dots (hidden files)
    sanitized = sanitized.replace(/^\.+/, '');
    
    // Limit length
    if (sanitized.length > 255) {
        const ext = sanitized.substring(sanitized.lastIndexOf('.'));
        sanitized = sanitized.substring(0, 255 - ext.length) + ext;
    }

    return sanitized || 'file';
}
