

import logger from './logger';
import prisma from '../config/prisma';

export enum AuditAction {

    LOGIN_SUCCESS = 'LOGIN_SUCCESS',
    LOGIN_FAILED = 'LOGIN_FAILED',
    LOGOUT = 'LOGOUT',
    OTP_SENT = 'OTP_SENT',
    OTP_VERIFIED = 'OTP_VERIFIED',
    OTP_FAILED = 'OTP_FAILED',

    ATTENDANCE_SCANNED = 'ATTENDANCE_SCANNED',
    ATTENDANCE_VERIFIED = 'ATTENDANCE_VERIFIED',
    ATTENDANCE_REJECTED = 'ATTENDANCE_REJECTED',

    DOCUMENT_UPLOADED = 'DOCUMENT_UPLOADED',
    DOCUMENT_APPROVED = 'DOCUMENT_APPROVED',
    DOCUMENT_REJECTED = 'DOCUMENT_REJECTED',
    DOCUMENT_DELETED = 'DOCUMENT_DELETED',

    PAYMENT_INITIATED = 'PAYMENT_INITIATED',
    PAYMENT_SUCCESS = 'PAYMENT_SUCCESS',
    PAYMENT_FAILED = 'PAYMENT_FAILED',
    PAYMENT_REFUNDED = 'PAYMENT_REFUNDED',

    ADMISSION_STATUS_CHANGED = 'ADMISSION_STATUS_CHANGED',
    SEAT_ALLOTTED = 'SEAT_ALLOTTED',
    ADMISSION_CANCELLED = 'ADMISSION_CANCELLED',

    DISCOUNT_REQUESTED = 'DISCOUNT_REQUESTED',
    DISCOUNT_APPROVED = 'DISCOUNT_APPROVED',
    DISCOUNT_REJECTED = 'DISCOUNT_REJECTED',

    USER_CREATED = 'USER_CREATED',
    USER_UPDATED = 'USER_UPDATED',
    USER_DELETED = 'USER_DELETED',
    ROLE_CHANGED = 'ROLE_CHANGED',

    EXAM_SCORE_UPDATED = 'EXAM_SCORE_UPDATED',
    HALL_TICKET_GENERATED = 'HALL_TICKET_GENERATED',

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

export async function logAuditEvent(data: AuditLogData): Promise<void> {
    try {

        const logLevel = data.success ? 'info' : 'warn';
        const logMessage = `[AUDIT] ${data.action} | User: ${data.userId || 'anonymous'} | Success: ${data.success}${data.errorMessage ? ` | Error: ${data.errorMessage}` : ''}`;
        
        logger[logLevel](logMessage, {
            audit: true,
            ...data
        });

        try {
            await prisma.auditLog.create({
                data: {
                    action: data.action,
                    userId: data.userId ?? undefined,
                    entity: data.targetResource ?? 'SYSTEM',
                    entityId: data.resourceId ?? undefined,
                    ipAddress: data.ipAddress ?? undefined,
                    userAgent: data.userAgent ?? undefined,
                    details: {
                        userRole: data.userRole,
                        targetUserId: data.targetUserId,
                        success: data.success,
                        errorMessage: data.errorMessage,
                        ...(data.details ?? {}),
                    },
                    timestamp: new Date()
                }
            });
        } catch (dbError) {
            logger.error(`[AUDIT] DB write failed: ${dbError}`);
        }
    } catch (error) {

        logger.error(`[AUDIT] Failed to log audit event: ${error}`);
    }
}

export function getClientIp(req: any): string {
    return (
        req.headers['x-forwarded-for']?.split(',')[0] ||
        req.headers['x-real-ip'] ||
        req.connection?.remoteAddress ||
        req.socket?.remoteAddress ||
        'unknown'
    );
}

export function auditAuthMiddleware(action: AuditAction) {
    return async (req: any, res: any, next: any) => {
        const originalJson = res.json;
        
        res.json = function(data: any) {

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
