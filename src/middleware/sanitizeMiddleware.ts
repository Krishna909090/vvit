import { Request, Response, NextFunction } from 'express';

/**
 * Recursively sanitize all string values in an object.
 * Strips HTML tags and common XSS vectors.
 */
function sanitizeValue(value: any): any {
    if (typeof value === 'string') {
        return value
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
            .replace(/<[^>]*>/g, '') // Remove all HTML tags
            .replace(/javascript:/gi, '') // Remove javascript: protocol
            .replace(/on\w+\s*=/gi, '') // Remove event handlers (onclick=, onerror=, etc.)
            .replace(/data:\s*text\/html/gi, '') // Remove data:text/html
            .trim();
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeValue);
    }
    if (value && typeof value === 'object') {
        const sanitized: Record<string, any> = {};
        for (const key of Object.keys(value)) {
            sanitized[key] = sanitizeValue(value[key]);
        }
        return sanitized;
    }
    return value;
}

export const sanitizeInput = (req: Request, _res: Response, next: NextFunction) => {
    if (req.body) req.body = sanitizeValue(req.body);
    if (req.query) {
        const sanitizedQuery = sanitizeValue(req.query);
        for (const key of Object.keys(sanitizedQuery)) {
            (req.query as Record<string, any>)[key] = sanitizedQuery[key];
        }
    }
    if (req.params) req.params = sanitizeValue(req.params);
    next();
};
