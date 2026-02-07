import express from 'express';
import { InvoiceController } from './invoice.controller';
import { authenticate } from '../../middleware/rbac.middleware';

const router = express.Router();

router.post('/generate-invoice', authenticate, InvoiceController.generateInvoice);

export default router;
