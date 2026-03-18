import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { searchLogs } from './logs.controller';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  TRANSACTION / AUDIT LOG EXPLORER
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /logs/search
 * @desc    Search system logs by correlationId, studentId, transaction ID, or other criteria.
 *          Used for debugging, auditing, and tracking operations across services.
 * @access  Requires `system.read.all` permission.
 * @query   { correlationId?, studentId?, txnId?, level?, startDate?, endDate?, page?, limit? }
 * @returns {{ success: boolean, data: LogEntry[], meta: { total, page, limit } }} Paginated log entries matching the search criteria.
 */
router.get('/logs/search', authenticate, authorizePermission('system.read.all'), searchLogs);

export default router;
