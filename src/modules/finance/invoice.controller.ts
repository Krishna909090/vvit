import { Request, Response } from 'express';
import { InvoiceService } from './invoice.service';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

export const InvoiceController = {
    async generateInvoice(req: Request, res: Response) {
        try {
            const { paymentId } = req.body;
            logger.info(`[InvoiceController] Request to generate invoice for paymentId=${paymentId} by ${req.user?.userId || 'Unknown'}`);
            if (!paymentId) {
                throw new AppError("Payment ID is required", 400);
            }

            // Optional: permission check? 
            // Admin can generate for anyone. 
            // Student can generate for self? 
            // For now assuming Admin Admin context or secured route.
            
            const result = await InvoiceService.generateInvoiceForPayment(paymentId);
            res.json(result);
        } catch (error: any) {
            logger.error(`[InvoiceController] Error: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    }
};
