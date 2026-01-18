import { Router } from 'express';
import * as controller from './hostelPrice.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

const router = Router();

// Public/Student routes (Authenticated)
router.use(authenticate);
router.get('/', controller.getAllPriceCategories);
router.get('/:id', controller.getPriceCategoryById);

// Admin only routes
router.use(authorizePermission('infra.hostel.manage'));
router.post('/', controller.createPriceCategory);
router.put('/:id', controller.updatePriceCategory);
router.delete('/:id', controller.deletePriceCategory);

export default router;
