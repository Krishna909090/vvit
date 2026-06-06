
import express from 'express';
import { listFailedEmails, retryFailedEmail, retryAllFailedEmails } from './emailLog.controller';
import { authenticate, authorizePermission } from '../../../middleware/rbac.middleware';

const router = express.Router();

router.get('/failed', authenticate, authorizePermission(['system.email-logs.read']), listFailedEmails);

router.post('/retry/:id', authenticate, authorizePermission(['system.email-logs.write']), retryFailedEmail);

router.post('/retry-all', authenticate, authorizePermission(['system.email-logs.write']), retryAllFailedEmails);

export default router;
