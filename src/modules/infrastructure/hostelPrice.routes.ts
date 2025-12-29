import { Router } from 'express';
import * as controller from './hostelPrice.controller';
import { authenticate, authorize } from '../../middlewares/authMiddleware';

const router = Router();

// Only ADMIN and SUPER_ADMIN can manage master data
router.use(authenticate, authorize(['ADMIN', 'SUPER_ADMIN']));

router.post('/', controller.createPriceCategory);
router.get('/', controller.getAllPriceCategories);
router.get('/:id', controller.getPriceCategoryById);
router.put('/:id', controller.updatePriceCategory);
router.delete('/:id', controller.deletePriceCategory);

export default router;
