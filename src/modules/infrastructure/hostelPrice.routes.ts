import { Router } from 'express';
import * as controller from './hostelPrice.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

import { validateRequest } from '../../middlewares/validationMiddleware';
import { createHostelPriceCategorySchema, updateHostelPriceCategorySchema } from '../../validators/hostelValidators';

const router = Router();

// Public/Student routes (Authenticated)
router.use(authenticate);
router.get('/', controller.getAllPriceCategories);
router.get('/:id', controller.getPriceCategoryById);

// Admin only routes
router.use(authorizePermission('hostel.create.all'));
router.post('/', validateRequest(createHostelPriceCategorySchema), controller.createPriceCategory);
router.put('/:id', validateRequest(updateHostelPriceCategorySchema), controller.updatePriceCategory);
router.delete('/:id', controller.deletePriceCategory);

export default router;
