import { Router } from 'express';
import * as controller from './hostelPrice.controller';
import { authenticate, authorize } from '../../middlewares/authMiddleware';

const router = Router();

// Public/Student routes (Authenticated)
router.use(authenticate);
router.get('/', controller.getAllPriceCategories);
router.get('/:id', controller.getPriceCategoryById);

// Admin only routes
router.use(authorize(['ADMIN', 'SUPER_ADMIN']));
router.post('/', controller.createPriceCategory);
router.put('/:id', controller.updatePriceCategory);
router.delete('/:id', controller.deletePriceCategory);

export default router;
