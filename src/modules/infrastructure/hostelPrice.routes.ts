import { Router } from 'express';
import * as controller from './hostelPrice.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

import { validateRequest } from '../../middlewares/validationMiddleware';
import { createHostelPriceCategorySchema, updateHostelPriceCategorySchema } from '../../validators/hostelValidators';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  PUBLIC / STUDENT ROUTES (Authenticated)
// ═══════════════════════════════════════════════════════════

router.use(authenticate);

/**
 * @route   GET /
 * @desc    Retrieve all hostel price categories. Available to any authenticated user.
 * @returns {{ success: boolean, data: HostelPriceCategory[] }} Array of price category records.
 */
router.get('/', controller.getAllPriceCategories);

/**
 * @route   GET /:id
 * @desc    Retrieve a single hostel price category by its ID.
 * @param   {string} id — The price category ID.
 * @returns {{ success: boolean, data: HostelPriceCategory }} The matching price category.
 */
router.get('/:id', controller.getPriceCategoryById);

// ═══════════════════════════════════════════════════════════
//  ADMIN-ONLY ROUTES
// ═══════════════════════════════════════════════════════════

router.use(authorizePermission('hostel.create.all'));

/**
 * @route   POST /
 * @desc    Create a new hostel price category (e.g. AC, Non-AC tiers).
 * @access  Requires `hostel.create.all` permission.
 * @body    { name, amount, hostelType, ... } — validated against createHostelPriceCategorySchema.
 * @returns {{ success: boolean, data: HostelPriceCategory }} The newly created price category.
 */
router.post('/', validateRequest(createHostelPriceCategorySchema), controller.createPriceCategory);

/**
 * @route   PUT /:id
 * @desc    Update an existing hostel price category.
 * @access  Requires `hostel.create.all` permission.
 * @param   {string} id — The price category ID.
 * @body    Fields to update — validated against updateHostelPriceCategorySchema.
 * @returns {{ success: boolean, data: HostelPriceCategory }} The updated price category.
 */
router.put('/:id', validateRequest(updateHostelPriceCategorySchema), controller.updatePriceCategory);

/**
 * @route   DELETE /:id
 * @desc    Delete a hostel price category.
 * @access  Requires `hostel.create.all` permission.
 * @param   {string} id — The price category ID.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/:id', controller.deletePriceCategory);

export default router;
