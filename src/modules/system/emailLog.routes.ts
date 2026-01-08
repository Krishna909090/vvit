
import express from 'express';
import { listFailedEmails, retryFailedEmail, retryAllFailedEmails } from './emailLog.controller';
// import { isAdmin } from '../../middlewares/authMiddleware'; // Assuming auth middleware exists

const router = express.Router();

// Protected routes (add authentication middleware as needed)
router.get('/failed', listFailedEmails);
router.post('/retry/:id', retryFailedEmail);
router.post('/retry-all', retryAllFailedEmails);

export default router;
