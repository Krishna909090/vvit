import express from 'express';
import { InvoiceController } from './invoice.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

const router = express.Router();

router.post('/generate-invoice', authenticate, authorizePermission(['finance.create.all', 'finance.update.all']), InvoiceController.generateInvoice);

router.post('/regenerate-invoice', authenticate, authorizePermission('finance.update.all'), InvoiceController.regenerateInvoice);

export default router;
