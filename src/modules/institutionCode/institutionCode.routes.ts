import { Router } from 'express';
import { authenticate } from '../../middleware/rbac.middleware';
import { authorize } from '../../middleware/authMiddleware';
import { Role } from '../../constants/roles';
import { getAll, getById, create, update, remove } from './institutionCode.controller';

const router = Router();

router.get('/',    authenticate, authorize([Role.SUPER_ADMIN, Role.ADMIN]), getAll);
router.get('/:id', authenticate, authorize([Role.SUPER_ADMIN, Role.ADMIN]), getById);
router.post('/',   authenticate, authorize([Role.SUPER_ADMIN, Role.ADMIN]), create);
router.put('/:id', authenticate, authorize([Role.SUPER_ADMIN, Role.ADMIN]), update);
router.delete('/:id', authenticate, authorize([Role.SUPER_ADMIN, Role.ADMIN]), remove);

export default router;
