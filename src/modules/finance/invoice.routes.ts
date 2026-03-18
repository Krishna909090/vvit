import express from 'express';
import { InvoiceController } from './invoice.controller';
import { authenticate } from '../../middleware/rbac.middleware';

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
router.post('/generate-invoice', authenticate, InvoiceController.generateInvoice);

export default router;
