import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createFeeHead, getFeeHeads, updateFeeHead, deleteFeeHead,
    createFeeStructure, getFeeStructures, updateFeeStructure, deleteFeeStructure,
    getFeeStatistics,
    createDiscountRequest, reviewDiscountRequest, approveDiscount,
    getApplicationFee, updateApplicationFee,
    collectFee
} from './fee.controller';
import {
    createFeeHeadSchema, createFeeStructureSchema,
    createDiscountRequestSchema, reviewDiscountRequestSchema, approveDiscountSchema
} from '../../validators/adminValidators';

const router = Router();

// Fee Head
// Fee Head
router.post('/fee-head', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createFeeHeadSchema), createFeeHead);
router.get('/fee-head', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getFeeHeads);
router.put('/fee-head/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateFeeHead);
router.delete('/fee-head/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteFeeHead);

// Fee Structure
router.post('/fee-structure', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createFeeStructureSchema), createFeeStructure);
router.get('/fee-structure', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getFeeStructures);
router.put('/fee-structure/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateFeeStructure);
router.delete('/fee-structure/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteFeeStructure);

// Fee Statistics
router.get('/fee-stats', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getFeeStatistics);

// Discounts
router.post('/create-discount', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createDiscountRequestSchema), createDiscountRequest);

router.post('/review-discount', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(reviewDiscountRequestSchema), reviewDiscountRequest);

router.post('/approve-discount', authenticate, authorize([Role.SUPER_ADMIN]), validateRequest(approveDiscountSchema), approveDiscount);

// Application Fee Configuration
router.get('/application-fee', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getApplicationFee);

router.post('/application-fee', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateApplicationFee);

router.post('/collect-fee', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), collectFee);


export default router;
