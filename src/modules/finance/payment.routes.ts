import express from 'express';
import { handlePaymentCallback } from './payment.service';
import { getInvoice, payTestFee, payCollegeFee, requestDiscount } from './payment.controller';
import { authenticate, authorize } from '../../middlewares/authMiddleware';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

const router = express.Router();

router.get('/:paymentId/invoice', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN']), getInvoice);

// Callback only

router.post('/initiate-entrance-fee', authenticate, authorize(['STUDENT']), payTestFee);
router.post('/initiate-college-fee', authenticate, authorize(['STUDENT']), payCollegeFee);
router.post('/request-discount', authenticate, authorize(['STUDENT']), requestDiscount);
router.post('/callback', async (req, res, next) => {
    try {
        const { response } = req.body; // base64 payload
        const xVerify = req.headers['x-verify'] as string;

        if (!response || !xVerify) {
            throw new AppError('Invalid callback request', 400);
        }

        await handlePaymentCallback(response, xVerify);
        
        res.status(200).json({
            status: 'success',
            message: 'Callback processed'
        });
    } catch (error) {
        logger.error(`Payment callback error: ${error}`);
        // Return 200 to acknowledge receipt even if processing failed internally, 
        // depending on PhonePe retry logic, but usually 500 triggers retry.
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
