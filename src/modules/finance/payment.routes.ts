import express from 'express';
import { handlePaymentCallback, handleNewWebhook } from './payment.service';
import { getInvoice, payTestFee, payCollegeFee, requestDiscount, checkPaymentStatus, getPaymentHistory, getFinancialSummary, getFinancialFlow, getCompleteHistory, approveDiscount, rejectDiscount, payOfflineApplicationFee, initiateAdminPayment, payFeeComponent, payMultiComponentFee, getAllSuccessPaymentsController, getPaymentCreatorsController, getPaymentComponentsController, exportSuccessPaymentsCsvController } from './payment.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import feeRoutes from './fee.routes';
import { paymentRateLimiter } from '../../middleware/rateLimitMiddleware';
import { payFeeComponentSchema, offlineApplicationFeeSchema, adminInitiatePaymentSchema, multiComponentPaymentSchema, approveDiscountSchema, rejectDiscountSchema } from '../../validators/paymentValidators';
import { validateRequest } from '../../middleware/validationMiddleware';

const router = express.Router();

router.use('/fees', feeRoutes);

router.get('/:paymentId/invoice', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getInvoice);

router.post('/initiate-entrance-fee', authenticate, paymentRateLimiter, authorizePermission(['finance.create.own', 'finance.create.all']), payTestFee);

router.post('/offline-entrance-fee', authenticate, paymentRateLimiter, authorizePermission(['finance.create.all', 'finance.create.own']), validateRequest(offlineApplicationFeeSchema), payOfflineApplicationFee);

router.post('/initiate-college-fee', authenticate, paymentRateLimiter, authorizePermission(['finance.create.own', 'finance.create.all']), payCollegeFee);

router.post('/admin-initiate', authenticate, paymentRateLimiter, authorizePermission(['finance.create.all']), validateRequest(adminInitiatePaymentSchema), initiateAdminPayment);

router.post('/pay-component', authenticate, paymentRateLimiter, authorizePermission(['finance.create.all', 'finance.create.own']), validateRequest(payFeeComponentSchema), payFeeComponent);

router.get('/transactions', authenticate, authorizePermission(['finance.read.all']), getAllSuccessPaymentsController);

router.get('/transactions/creators', authenticate, authorizePermission(['finance.read.all']), getPaymentCreatorsController);

router.get('/transactions/components', authenticate, authorizePermission(['finance.read.all']), getPaymentComponentsController);

router.get('/transactions/export', authenticate, authorizePermission(['finance.read.all']), exportSuccessPaymentsCsvController);

router.post('/multi-component', authenticate, paymentRateLimiter, authorizePermission(['finance.create.all', 'finance.create.own']), validateRequest(multiComponentPaymentSchema), payMultiComponentFee);

router.post('/request-discount', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), requestDiscount);

router.post('/discount/approve/:requestId', authenticate, authorizePermission('finance.update.all'), validateRequest(approveDiscountSchema), approveDiscount);

router.post('/discount/reject/:requestId', authenticate, authorizePermission('finance.update.all'), validateRequest(rejectDiscountSchema), rejectDiscount);

router.get('/check-status/:txnId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), checkPaymentStatus);

router.get('/history', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getPaymentHistory);
router.get('/history/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getPaymentHistory);

router.get('/summary', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialSummary);
router.get('/summary/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialSummary);

router.get('/flow', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialFlow);
router.get('/flow/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialFlow);

router.get('/student-timeline', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getCompleteHistory);
router.get('/student-timeline/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getCompleteHistory);

router.post('/callback', async (req, res, next) => {
    try {

        const allowedIPs = (process.env.PHONEPE_CALLBACK_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);
        const clientIP = req.ip || req.socket.remoteAddress || '';

        if (allowedIPs.length > 0 && !allowedIPs.some(ip => clientIP.includes(ip))) {
            logger.warn(`[PaymentCallback] Blocked callback from unauthorized IP: ${clientIP}`);
            return res.status(403).json({ error: 'Forbidden' });
        }

        const authHeader = req.headers['authorization'] as string;
        const xVerify = req.headers['x-verify'] as string;

        if (req.body.type && req.body.payload) {
            logger.info(`[PaymentCallback] New webhook format detected. type=${req.body.type}`);
            await handleNewWebhook(req.body, authHeader);
        } else if (req.body.response && xVerify) {
            logger.info(`[PaymentCallback] Legacy callback format detected.`);
            await handlePaymentCallback(req.body.response, xVerify);
        } else {
            throw new AppError('Invalid callback request: unrecognized format', 400);
        }

        res.status(200).json({
            status: 'success',
            message: 'Callback processed'
        });
    } catch (error) {
        logger.error(`Payment callback error: ${error}`);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
