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

            const result = await InvoiceService.generateInvoiceForPayment(paymentId);
            res.json(result);
        } catch (error: any) {
            logger.error(`[InvoiceController] Error: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    },

    async regenerateInvoice(req: Request, res: Response) {
        try {
            const { paymentId } = req.body;
            logger.info(`[InvoiceController] Request to regenerate invoice for paymentId=${paymentId} by ${req.user?.userId || 'Unknown'}`);
            if (!paymentId) {
                throw new AppError("Payment ID is required", 400);
            }

            const result = await InvoiceService.generateInvoiceForPayment(paymentId, true);
            res.json({ success: true, message: 'Invoice regenerated successfully', data: result });
        } catch (error: any) {
            logger.error(`[InvoiceController] Regenerate Error: ${error.message}`);
            res.status(500).json({ success: false, message: error.message });
        }
    }
};
