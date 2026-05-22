import express from 'express';
import { InvoiceController } from './invoice.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

const router = express.Router();

// ═══════════════════════════════════════════════════════════
//  INVOICE GENERATION
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /generate-invoice
 * @desc    Generate a fee invoice (PDF) for a student and upload it to cloud storage.
 * @access  Authenticated users only.
 * @body    { studentId, feeBreakdown, ... } — invoice details.
 * @sideEffect Creates a PDF document and stores it in the configured S3 bucket.
 * @returns {{ success: boolean, data: { invoiceId: string, url: string } }} The generated invoice ID and download URL.
 */
router.post('/generate-invoice', authenticate, authorizePermission(['finance.create.all', 'finance.update.all']), InvoiceController.generateInvoice);

/**
 * @route   POST /regenerate-invoice
 * @desc    Regenerate an existing invoice PDF with latest student/course data (e.g. after branch change).
 *          Overwrites the previous invoice URL on S3 while preserving all other payment data.
 * @access  Authenticated users only.
 * @body    { paymentId: string }
 * @returns {{ success: boolean, data: { invoiceUrl, invoiceNumber, receiptNumber } }}
 */
router.post('/regenerate-invoice', authenticate, authorizePermission('finance.update.all'), InvoiceController.regenerateInvoice);

export default router;
