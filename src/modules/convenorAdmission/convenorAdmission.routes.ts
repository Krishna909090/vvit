import { Router } from 'express';
import { authenticate } from '../../middleware/rbac.middleware';
import { authorize } from '../../middleware/authMiddleware';
import { Role } from '../../constants/roles';
import { list, exportCsv, updateStatus } from './convenorAdmission.controller';

const router = Router();
const adminOnly = [authenticate, authorize([Role.SUPER_ADMIN, Role.ADMIN])];

router.get('/',           ...adminOnly, list);
router.get('/export',     ...adminOnly, exportCsv);
router.patch('/:id/status', ...adminOnly, updateStatus);

export default router;
