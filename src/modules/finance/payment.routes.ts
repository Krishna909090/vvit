import express from 'express';
import { handlePaymentCallback } from './payment.service';
import { getInvoice, payTestFee, payCollegeFee, requestDiscount, checkPaymentStatus, getPaymentHistory, getFinancialSummary, approveDiscount, rejectDiscount, payOfflineApplicationFee } from './payment.controller';
import { authenticate, authorize } from '../../middlewares/authMiddleware';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import feeRoutes from './fee.routes';

const router = express.Router();

router.use('/fees', feeRoutes);

router.get('/:paymentId/invoice', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN']), getInvoice);

// Callback only

router.post('/initiate-entrance-fee', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN', 'AGENT']), payTestFee);
router.post('/offline-entrance-fee', authenticate, authorize(['ADMIN', 'SUPER_ADMIN']), payOfflineApplicationFee);
router.post('/initiate-college-fee', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN', 'AGENT']), payCollegeFee);
router.post('/request-discount', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN']), requestDiscount);

// Discount Approval Workflow (Super Admin Only)
router.post('/discount/approve/:requestId', authenticate, authorize(['SUPER_ADMIN']), approveDiscount);
router.post('/discount/reject/:requestId', authenticate, authorize(['SUPER_ADMIN']), rejectDiscount);

router.get('/check-status/:txnId', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN']), checkPaymentStatus);
// History Routes
router.get('/history', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN']), getPaymentHistory);
router.get('/history/:studentId', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN']), getPaymentHistory);
router.get('/summary', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN']), getFinancialSummary);
router.get('/summary/:studentId', authenticate, authorize(['STUDENT', 'ADMIN', 'SUPER_ADMIN']), getFinancialSummary);
    
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
