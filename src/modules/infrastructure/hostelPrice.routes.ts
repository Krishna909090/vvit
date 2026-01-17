import { Router } from 'express';
import * as controller from './hostelPrice.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

const router = Router();

// Public/Student routes (Authenticated)
router.use(authenticate);
router.get('/', authorizePermission('hostel.read'), controller.getAllPriceCategories);
router.get('/:id', authorizePermission('hostel.read'), controller.getPriceCategoryById);

// Admin only routes
// router.use(authorize(['ADMIN', 'SUPER_ADMIN'])); // Replaced by per-route permissions
router.post('/', authorizePermission('hostel.create'), controller.createPriceCategory);
router.put('/:id', authorizePermission('hostel.update'), controller.updatePriceCategory);
router.delete('/:id', authorizePermission('hostel.delete'), controller.deletePriceCategory);

export default router;
