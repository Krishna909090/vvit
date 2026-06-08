import { Router } from 'express';
import { authenticate, authorizePermission } from '../../../middleware/rbac.middleware';
import { searchLogs } from './logs.controller';

const router = Router();

router.get('/logs/search', authenticate, authorizePermission('admin.read.all'), searchLogs);

export default router;
