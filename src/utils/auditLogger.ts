// utils/auditLogger.ts
// Audit logging for security-sensitive operations

import logger from './logger';
import prisma from '../config/prisma';

export enum AuditAction {
    // Authentication
    LOGIN_SUCCESS = 'LOGIN_SUCCESS',
    LOGIN_FAILED = 'LOGIN_FAILED',
    LOGOUT = 'LOGOUT',
    OTP_SENT = 'OTP_SENT',
    OTP_VERIFIED = 'OTP_VERIFIED',
    OTP_FAILED = 'OTP_FAILED',
    
    // Attendance
    ATTENDANCE_SCANNED = 'ATTENDANCE_SCANNED',
    ATTENDANCE_VERIFIED = 'ATTENDANCE_VERIFIED',
    ATTENDANCE_REJECTED = 'ATTENDANCE_REJECTED',
    
    // Documents
    DOCUMENT_UPLOADED = 'DOCUMENT_UPLOADED',
    DOCUMENT_APPROVED = 'DOCUMENT_APPROVED',
    DOCUMENT_REJECTED = 'DOCUMENT_REJECTED',
    DOCUMENT_DELETED = 'DOCUMENT_DELETED',
    
    // Payments
    PAYMENT_INITIATED = 'PAYMENT_INITIATED',
    PAYMENT_SUCCESS = 'PAYMENT_SUCCESS',
    PAYMENT_FAILED = 'PAYMENT_FAILED',
    PAYMENT_REFUNDED = 'PAYMENT_REFUNDED',
    
    // Admissions
    ADMISSION_STATUS_CHANGED = 'ADMISSION_STATUS_CHANGED',
    SEAT_ALLOTTED = 'SEAT_ALLOTTED',
    ADMISSION_CANCELLED = 'ADMISSION_CANCELLED',
    
    // Discounts
    DISCOUNT_REQUESTED = 'DISCOUNT_REQUESTED',
    DISCOUNT_APPROVED = 'DISCOUNT_APPROVED',
    DISCOUNT_REJECTED = 'DISCOUNT_REJECTED',
    
    // Admin Actions
    USER_CREATED = 'USER_CREATED',
    USER_UPDATED = 'USER_UPDATED',
    USER_DELETED = 'USER_DELETED',
    ROLE_CHANGED = 'ROLE_CHANGED',
    
    // Exam
    EXAM_SCORE_UPDATED = 'EXAM_SCORE_UPDATED',
    HALL_TICKET_GENERATED = 'HALL_TICKET_GENERATED',
    
    // Security Events
    UNAUTHORIZED_ACCESS_ATTEMPT = 'UNAUTHORIZED_ACCESS_ATTEMPT',
    RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
    SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY',
    FILE_UPLOAD_BLOCKED = 'FILE_UPLOAD_BLOCKED'
}

export interface AuditLogData {
    action: AuditAction;
    userId?: string;
    userRole?: string;
    targetUserId?: string;
    targetResource?: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    details?: any;
    success: boolean;
    errorMessage?: string;
}

/**
 * Log audit event to database and logger
 */
export async function logAuditEvent(data: AuditLogData): Promise<void> {
    try {
        // Log to Winston logger for immediate visibility
        const logLevel = data.success ? 'info' : 'warn';
        const logMessage = `[AUDIT] ${data.action} | User: ${data.userId || 'anonymous'} | Success: ${data.success}${data.errorMessage ? ` | Error: ${data.errorMessage}` : ''}`;
        
        logger[logLevel](logMessage, {
            audit: true,
            ...data
        });

        // Store in database for long-term audit trail
        // Note: You may want to create an AuditLog table in Prisma schema
        // For now, we'll just log to file/console
        
        // If you have an AuditLog table, uncomment this:
        /*
        await prisma.auditLog.create({
            data: {
                action: data.action,
                userId: data.userId,
                userRole: data.userRole,
                targetUserId: data.targetUserId,
                targetResource: data.targetResource,
                resourceId: data.resourceId,
                ipAddress: data.ipAddress,
                userAgent: data.userAgent,
                details: data.details ? JSON.stringify(data.details) : null,
                success: data.success,
                errorMessage: data.errorMessage,
                timestamp: new Date()
            }
        });
        */
    } catch (error) {
        // Never let audit logging failure break the application
        logger.error(`[AUDIT] Failed to log audit event: ${error}`);
    }
}

/**
 * Helper function to extract IP address from request
 */
export function getClientIp(req: any): string {
    return (
        req.headers['x-forwarded-for']?.split(',')[0] ||
        req.headers['x-real-ip'] ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress ||
        'unknown'
    );
}

/**
 * Middleware to automatically log authentication events
 */
export function auditAuthMiddleware(action: AuditAction) {
    return async (req: any, res: any, next: any) => {
        const originalJson = res.json;
        
        res.json = function(data: any) {
            // Log after response is sent
            setImmediate(() => {
                logAuditEvent({
                    action,
                    userId: req.user?.userId,
                    userRole: req.user?.role,
                    ipAddress: getClientIp(req),
                    userAgent: req.headers['user-agent'],
                    success: res.statusCode < 400,
                    errorMessage: res.statusCode >= 400 ? data.message : undefined,
                    details: {
                        statusCode: res.statusCode,
                        method: req.method,
                        path: req.path
                    }
                });
            });
            
            return originalJson.call(this, data);
        };
        
        next();
    };
}

/**
 * Log security event (unauthorized access, rate limiting, etc.)
 */
export async function logSecurityEvent(
    action: AuditAction,
    req: any,
    details?: any
): Promise<void> {
    await logAuditEvent({
        action,
        userId: req.user?.userId,
        userRole: req.user?.role,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'],
        success: false,
        details: {
            path: req.path,
            method: req.method,
            ...details
        }
    });
}

/**
 * Log document operation
 */
export async function logDocumentOperation(
    action: AuditAction,
    userId: string,
    documentId: string,
    studentId: string,
    success: boolean,
    details?: any
): Promise<void> {
    await logAuditEvent({
        action,
        userId,
        targetUserId: studentId,
        targetResource: 'document',
        resourceId: documentId,
        success,
        details
    });
}

/**
 * Log attendance operation
 */
export async function logAttendanceOperation(
    action: AuditAction,
    userId: string,
    studentId: string,
    attendanceRecordId: string,
    success: boolean,
    details?: any
): Promise<void> {
    await logAuditEvent({
        action,
        userId,
        targetUserId: studentId,
        targetResource: 'attendance',
        resourceId: attendanceRecordId,
        success,
        details
    });
}

/**
 * Log payment operation
 */
export async function logPaymentOperation(
    action: AuditAction,
    userId: string,
    paymentId: string,
    amount: number,
    success: boolean,
    details?: any
): Promise<void> {
    await logAuditEvent({
        action,
        userId,
        targetResource: 'payment',
        resourceId: paymentId,
        success,
        details: {
            amount,
            ...details
        }
    });
}
