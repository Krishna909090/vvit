
import { EmailStatus } from '@prisma/client';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';

export const createEmailLog = async (data: {
    recipientEmail: string;
    subject: string;
    content: string;
    templateType: string;
    invoiceData?: any;
    metadata?: any;
}) => {
    try {
        return await prisma.emailLog.create({
            data: {
                ...data,
                status: EmailStatus.PENDING,
                invoiceData: data.invoiceData ? JSON.parse(JSON.stringify(data.invoiceData)) : undefined,
                metadata: data.metadata ? JSON.parse(JSON.stringify(data.metadata)) : undefined
            }
        });
    } catch (error) {
        logger.error('[EmailLogService] Failed to create email log', error);
        return null;
    }
};

export const updateEmailStatus = async (
    id: string, 
    status: EmailStatus, 
    messageId?: string, 
    errorResponse?: any
) => {
    try {
        return await prisma.emailLog.update({
            where: { id },
            data: {
                status,
                messageId,
                errorResponse: errorResponse ? JSON.parse(JSON.stringify(errorResponse)) : undefined,
                retryCount: status === EmailStatus.FAILED ? { increment: 1 } : undefined
            }
        });
    } catch (error) {
        logger.error(`[EmailLogService] Failed to update email log ${id}`, error);
        return null;
    }
};

export const getFailedEmails = async () => {
    try {
        return await prisma.emailLog.findMany({
            where: { status: EmailStatus.FAILED },
            orderBy: { createdAt: 'desc' }
        });
    } catch (error) {
        logger.error('[EmailLogService] Failed to fetch failed emails', error);
        throw error;
    }
};

export const getEmailLogById = async (id: string) => {
    try {
        return await prisma.emailLog.findUnique({ where: { id } });
    } catch (error) {
        logger.error(`[EmailLogService] Failed to fetch email log ${id}`, error);
        throw error;
    }
};
