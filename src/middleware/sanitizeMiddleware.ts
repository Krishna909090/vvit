import { Request, Response, NextFunction } from 'express';

function sanitizeValue(value: any): any {
    if (typeof value === 'string') {
        return value
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<[^>]*>/g, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '')
            .replace(/data:\s*text\/html/gi, '')
            .trim();
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeValue);
    }
    if (value && typeof value === 'object') {
        const sanitized: Record<string, any> = {};
        for (const key of Object.keys(value)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
                continue;
            }
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
