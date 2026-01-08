
import { Request, Response } from 'express';
import { getFailedEmails } from './emailLog.service';
import { retryEmail } from '../../utils/emailService';
import logger from '../../utils/logger';

export const listFailedEmails = async (req: Request, res: Response) => {
    try {
        const failedEmails = await getFailedEmails();
        res.status(200).json(failedEmails);
    } catch (error) {
        logger.error('[EmailLogController] Failed to list failed emails', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const retryFailedEmail = async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        const result = await retryEmail(id);
        if (result.success) {
            res.status(200).json({ message: 'Email retried successfully', data: result });
        } else {
            res.status(400).json({ message: 'Failed to retry email', error: result });
        }
    } catch (error) {
        logger.error(`[EmailLogController] Failed to retry email ${id}`, error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const retryAllFailedEmails = async (req: Request, res: Response) => {
    try {
        const failedEmails = await getFailedEmails();
        const results = [];
        
        for (const email of failedEmails) {
            try {
                const result = await retryEmail(email.id);
                results.push({ id: email.id, success: result.success, message: result.success ? 'Sent' : (result as any).error || (result as any).message });
            } catch (err: any) {
                results.push({ id: email.id, success: false, message: err.message });
            }
        }
        
        res.status(200).json({ message: 'Batch retry completed', results });
    } catch (error) {
        logger.error('[EmailLogController] Failed to retry all emails', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
