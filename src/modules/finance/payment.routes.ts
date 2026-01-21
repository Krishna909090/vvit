import express from 'express';
import { handlePaymentCallback } from './payment.service';
import { getInvoice, payTestFee, payCollegeFee, requestDiscount, checkPaymentStatus, getPaymentHistory, getFinancialSummary, approveDiscount, rejectDiscount, payOfflineApplicationFee, initiateAdminPayment } from './payment.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import feeRoutes from './fee.routes';

const router = express.Router();

router.use('/fees', feeRoutes);

router.get('/:paymentId/invoice', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getInvoice);

// Callback only

router.post('/initiate-entrance-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), payTestFee);
router.post('/offline-entrance-fee', authenticate, authorizePermission(['finance.create.all', 'finance.create.own']), payOfflineApplicationFee);
router.post('/initiate-college-fee', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), payCollegeFee);
router.post('/admin-initiate', authenticate, authorizePermission(['finance.create.all']), initiateAdminPayment);
router.post('/request-discount', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), requestDiscount);

// Discount Approval Workflow (Super Admin Only)
router.post('/discount/approve/:requestId', authenticate, authorizePermission('finance.update.all'), approveDiscount); // High level override
router.post('/discount/reject/:requestId', authenticate, authorizePermission('finance.update.all'), rejectDiscount);

router.get('/check-status/:txnId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), checkPaymentStatus);
// History Routes
router.get('/history', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getPaymentHistory);
router.get('/history/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getPaymentHistory);
router.get('/summary', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialSummary);
router.get('/summary/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialSummary);
    
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
