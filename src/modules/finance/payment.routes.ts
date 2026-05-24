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

// Mount fee sub-routes under /finance/fees
router.use('/fees', feeRoutes);

// ═══════════════════════════════════════════════════════════
// INVOICE
// ═══════════════════════════════════════════════════════════

/**
 * GET /finance/:paymentId/invoice
 * Downloads the invoice PDF for a specific payment.
 * Returns a presigned S3 URL to the generated invoice.
 * If invoice doesn't exist yet, generates it on-the-fly (PDF with student copy + office copy).
 * Params: { paymentId }
 * Response: { status, data: { invoiceUrl (presigned S3 URL, valid 1 hour) } }
 */
router.get('/:paymentId/invoice', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getInvoice);

// ═══════════════════════════════════════════════════════════
// PAYMENT INITIATION (Online — PhonePe)
// ═══════════════════════════════════════════════════════════

/**
 * POST /finance/initiate-entrance-fee
 * Initiates entrance/application fee payment (₹500) via PhonePe.
 * @deprecated Since 2026-04. Use POST /finance/pay-component with
 *   { component: 'APPLICATION_FEE', mode: 'ONLINE', method: 'UPI', amount, studentId }.
 *   Kept active for FE backward compatibility — emits a Warning header.
 *
 * Flow: Create PENDING payment → Call PhonePe SDK → Return redirect URL.
 * Reuses fresh PENDING payments (< 20 min) to avoid duplicates.
 * Body: { studentId }
 * Response: { status, data: { redirectUrl, paymentId } }
 */
router.post('/initiate-entrance-fee', authenticate, paymentRateLimiter, authorizePermission(['finance.create.own', 'finance.create.all']), payTestFee);

/**
 * POST /finance/offline-entrance-fee
 *
 * @deprecated Since 2026-04. Use POST /finance/pay-component with
 *   { component: 'APPLICATION_FEE', mode: 'OFFLINE', method, referenceNumber, amount, studentId }.
 *
 * Records an offline application fee payment. Body: { studentId, amount, method, referenceNumber?, remarks? }
 */
router.post('/offline-entrance-fee', authenticate, paymentRateLimiter, authorizePermission(['finance.create.all', 'finance.create.own']), validateRequest(offlineApplicationFeeSchema), payOfflineApplicationFee);

/**
 * POST /finance/initiate-college-fee
 *
 * NOT deprecated — has unique server-side logic that pay-component does not duplicate:
 *   "if tuition is unpaid pay tuition; else hostel; else mess; else transport"
 *
 * Body: { studentId, hostelSelection?, transportSelection?, paymentDetails: { amount } }
 * Response: { status, data: { redirectUrl, paymentId } }
 */
router.post('/initiate-college-fee', authenticate, paymentRateLimiter, authorizePermission(['finance.create.own', 'finance.create.all']), payCollegeFee);

/**
 * POST /finance/admin-initiate
 *
 * @deprecated Since 2026-04. This is a thin wrapper around processUnifiedPayment with
 *   `mode: 'ONLINE', method: 'UPI'` hardcoded. Use POST /finance/pay-component instead with
 *   explicit mode/method — gives the admin full control of the payment context.
 *
 * Body: { studentId, amount, component, feeHeadId?, remarks? }
 */
router.post('/admin-initiate', authenticate, paymentRateLimiter, authorizePermission(['finance.create.all']), validateRequest(adminInitiatePaymentSchema), initiateAdminPayment);

// ═══════════════════════════════════════════════════════════
// CANONICAL PAYMENT API
//   - /pay-component   → single component, any mode/method (replaces 3 deprecated routes above)
//   - /multi-component → bundle multiple components into ONE PhonePe transaction
//                        (hostel/mess/laundry/registration/transport are restricted from
//                        bundling — they each route through different bank merchants)
// ═══════════════════════════════════════════════════════════

/**
 * POST /finance/pay-component  ⭐ CANONICAL
 *
 * Pays a single fee component. Supports every value in the PaymentComponent enum:
 *   APPLICATION_FEE, TUITION, ADMISSION, BOOK_BANK, SKILL_DEVELOPMENT,
 *   HOSTEL, HOSTEL_ACCOMMODATION, HOSTEL_MESS, HOSTEL_LAUNDRY, HOSTEL_REGISTRATION,
 *   TRANSPORT, COURSE_CHANGE_FEE, SCHOLARSHIP_TOKEN, OTHER.
 *
 * Hostel sub-components route to the correct PhonePe merchant via
 * resolvePhonePeClientType() reading the per-hostel banking config (TRUST/LLP).
 *
 * Body: { studentId, component, amount, mode, method, feeHeadId?, referenceNumber?, remarks? }
 * Response: { status, data: { redirectUrl? | invoiceUrl?, paymentId, transactionId } }
 */
router.post('/pay-component', authenticate, paymentRateLimiter, authorizePermission(['finance.create.all', 'finance.create.own']), validateRequest(payFeeComponentSchema), payFeeComponent);

/**
 * GET /finance/transactions
 * Admin: List all SUCCESS payments with pagination and filters.
 * Query: page, limit, search (applicationId/name/phone), component|feeType, method, mode,
 *        createdBy, dateRange (today|yesterday|7d|15d|30d|custom), startDate, endDate
 * Response: { data: [...], pagination: { page, limit, total, totalPages }, summary: { totalTransactions, totalAmount } }
 */
router.get('/transactions', authenticate, authorizePermission(['finance.read.all']), getAllSuccessPaymentsController);

/**
 * GET /finance/transactions/creators
 * Admin: Distinct users who have recorded SUCCESS payments (for "Created By" dropdown).
 * Response: { data: [{ id, name, role }] }
 */
router.get('/transactions/creators', authenticate, authorizePermission(['finance.read.all']), getPaymentCreatorsController);

/**
 * GET /finance/transactions/components
 * Admin: Distinct payment components (fee types) that have SUCCESS payments — for "Select Fee Type" dropdown.
 * Response: { data: ['APPLICATION_FEE', 'TUITION', 'HOSTEL', ...] }
 */
router.get('/transactions/components', authenticate, authorizePermission(['finance.read.all']), getPaymentComponentsController);

/**
 * GET /finance/transactions/export
 * Admin: Export filtered SUCCESS payments as CSV (same filters as /transactions).
 * Response: text/csv download
 */
router.get('/transactions/export', authenticate, authorizePermission(['finance.read.all']), exportSuccessPaymentsCsvController);

/**
 * POST /finance/multi-component
 * Pays multiple fee components in a single transaction (e.g., tuition + book bank + lab fee).
 * All components share the same providerTxId. Hostel/transport/mess cannot be bundled here.
 * Offline: immediately SUCCESS. Online: single PhonePe transaction for total amount.
 * On success: individual ledger entries per component, single unified invoice.
 * Rate limited: 5 requests per 15 minutes.
 * Body: { studentId, components: [{ component, amount, feeHeadId? }], method, referenceNumber?, remarks? }
 * Response: { status, data: { redirectUrl? | invoiceUrl?, paymentIds, transactionId } }
 */
router.post('/multi-component', authenticate, paymentRateLimiter, authorizePermission(['finance.create.all', 'finance.create.own']), validateRequest(multiComponentPaymentSchema), payMultiComponentFee);

// ═══════════════════════════════════════════════════════════
// DISCOUNTS
// ═══════════════════════════════════════════════════════════

/**
 * POST /finance/request-discount
 * Student or admin requests a fee discount for a specific student.
 * Creates a DiscountRequest record with PENDING status.
 * Requires super admin approval before it takes effect.
 * Body: { studentId, amount, reason, feeHeadId? }
 * Response: { status, message, data: { requestId } }
 */
router.post('/request-discount', authenticate, authorizePermission(['finance.create.own', 'finance.create.all']), requestDiscount);

/**
 * POST /finance/discount/approve/:requestId
 * Super admin approves a pending discount request.
 * Updates the discount amount on the student's fee demand, creates a CREDIT ledger entry.
 * Params: { requestId }
 * Body: { approvedAmount?, remarks? }
 * Response: { status, message }
 */
router.post('/discount/approve/:requestId', authenticate, authorizePermission('finance.update.all'), validateRequest(approveDiscountSchema), approveDiscount);

/**
 * POST /finance/discount/reject/:requestId
 * Super admin rejects a pending discount request.
 * Updates DiscountRequest status to REJECTED with reason.
 * Params: { requestId }
 * Body: { remarks? }
 * Response: { status, message }
 */
router.post('/discount/reject/:requestId', authenticate, authorizePermission('finance.update.all'), validateRequest(rejectDiscountSchema), rejectDiscount);

// ═══════════════════════════════════════════════════════════
// PAYMENT STATUS & HISTORY
// ═══════════════════════════════════════════════════════════

/**
 * GET /finance/check-status/:txnId
 * Checks the real-time status of a payment by querying PhonePe's Order Status API.
 * If PhonePe says SUCCESS but our DB says PENDING, auto-reconciles (marks SUCCESS, processes ledger/invoice).
 * If PhonePe says FAILED, marks payment as FAILED in our DB.
 * Called by frontend after PhonePe redirect to verify payment completed.
 * Params: { txnId (providerTxId / merchantTransactionId) }
 * Response: { status: 'SUCCESS' | 'FAILED' | 'PENDING', data: { phonePeResponse }, paymentIds }
 */
router.get('/check-status/:txnId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), checkPaymentStatus);

/**
 * GET /finance/history
 * GET /finance/history/:studentId
 * Returns payment history. Without studentId, returns for the logged-in user.
 * With studentId (admin), returns for that specific student.
 * Includes: payment amount, method, status, component, date, invoice URL.
 * Supports pagination via query params.
 * Query: { page?, limit?, status?, component? }
 * Response: { status, data: [{ id, amount, method, status, component, createdAt, invoiceUrl }] }
 */
router.get('/history', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getPaymentHistory);
router.get('/history/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getPaymentHistory);

/**
 * GET /finance/summary
 * GET /finance/summary/:studentId
 * Returns financial summary — total fees, paid amount, pending amount, discount, scholarship.
 * Without studentId: summary for logged-in student. With studentId: for specific student (admin).
 * Response: { status, data: { totalFee, totalPaid, totalPending, totalDiscount, totalScholarship, balance } }
 */
router.get('/summary', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialSummary);
router.get('/summary/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialSummary);

/**
 * GET /finance/flow
 * GET /finance/flow/:studentId
 * Returns a chronological flowchart of all financial events for a student.
 * Each step shows: what happened, when, amount, sign (+/-), and running balance.
 * Without studentId: flow for logged-in student. With studentId: for specific student (admin).
 * Response: { status, data: { student, totalSteps, currentPending, flow[] } }
 */
router.get('/flow', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialFlow);
router.get('/flow/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getFinancialFlow);

/**
 * GET /finance/student-timeline
 * GET /finance/student-timeline/:studentId
 * COMPLETE audit-grade history: every record across every source the student touched,
 * INCLUDING deleted / reversed / superseded rows (flagged), grouped into per-source
 * `sections`, a merged chronological `timeline`, and one reconciled `summary`.
 * Without studentId: history for the logged-in student. With studentId: admin view.
 */
router.get('/student-timeline', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getCompleteHistory);
router.get('/student-timeline/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getCompleteHistory);

// ═══════════════════════════════════════════════════════════
// PAYMENT WEBHOOK / CALLBACK (PhonePe → Backend)
// ═══════════════════════════════════════════════════════════

/**
 * POST /finance/callback
 * Receives payment status updates from PhonePe (server-to-server).
 * NO AUTHENTICATION — PhonePe calls this directly. Protected by IP whitelist + checksum/signature.
 *
 * Supports TWO formats (auto-detected):
 *
 * 1. Legacy format: { response: base64_encoded_payload } + x-verify header
 *    - Verifies SHA256 checksum against PhonePe salt key
 *    - Decodes base64 → extracts merchantTransactionId and status code
 *
 * 2. New Standard Checkout Webhook: { type, payload } + Authorization header
 *    - Events: checkout.order.completed, checkout.order.failed, pg.refund.completed, pg.refund.failed
 *    - Verifies Authorization = SHA256(username:password) from env config
 *
 * On SUCCESS: marks payments as SUCCESS, generates invoice, creates ledger entries,
 *   settles fee demands, generates allotment order (for admission payments), sends email.
 * On FAILED: marks payments as FAILED with error details.
 *
 * Idempotent: duplicate callbacks for already-SUCCESS payments are safely ignored.
 * Must respond with 2xx within 3-5 seconds.
 *
 * IP whitelist configured via PHONEPE_CALLBACK_IPS env var.
 * Response: { status: 'success', message: 'Callback processed' }
 */
router.post('/callback', async (req, res, next) => {
    try {
        // IP whitelist for PhonePe servers
        const allowedIPs = (process.env.PHONEPE_CALLBACK_IPS || '').split(',').map(ip => ip.trim()).filter(Boolean);
        const clientIP = req.ip || req.socket.remoteAddress || '';

        if (allowedIPs.length > 0 && !allowedIPs.some(ip => clientIP.includes(ip))) {
            logger.warn(`[PaymentCallback] Blocked callback from unauthorized IP: ${clientIP}`);
            return res.status(403).json({ error: 'Forbidden' });
        }

        // Detect format: New webhook has { type, payload }, old has { response } + x-verify header
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
