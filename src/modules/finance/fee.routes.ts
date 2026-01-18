import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createFeeHead, getFeeHeads, updateFeeHead, deleteFeeHead,
    createFeeStructure, createBulkFeeStructure, getFeeStructures, updateFeeStructure, deleteFeeStructure,
    getFeeStatistics,
    createDiscountRequest, reviewDiscountRequest, approveDiscount,
    getApplicationFee, updateApplicationFee,
    collectFee, getStudentLedger, downloadAllotmentOrder, generateFeeDemands, getStudentFeeDemands
} from './fee.controller';

import {
    createFeeHeadSchema, createFeeStructureSchema, createBulkFeeStructureSchema,
    createDiscountRequestSchema, reviewDiscountRequestSchema, approveDiscountSchema, generateFeeDemandsSchema
} from '../../validators/adminValidators';

const router = Router();

// Fee Head
// Fee Head
// Fee Head
router.post('/fee-head', authenticate, authorizePermission('finance.create.all'), validateRequest(createFeeHeadSchema), createFeeHead);
router.get('/fee-head', authenticate, authorizePermission('finance.read.all'), getFeeHeads);
router.put('/fee-head/:id', authenticate, authorizePermission('finance.update.all'), updateFeeHead);
router.delete('/fee-head/:id', authenticate, authorizePermission('finance.delete.all'), deleteFeeHead);

// Fee Structure
router.post('/fee-structure/bulk', authenticate, authorizePermission('finance.create.all'), validateRequest(createBulkFeeStructureSchema), createBulkFeeStructure);
router.post('/fee-structure', authenticate, authorizePermission('finance.create.all'), validateRequest(createFeeStructureSchema), createFeeStructure);
router.get('/fee-structure', authenticate, authorizePermission('finance.read.all'), getFeeStructures);
router.put('/fee-structure/:id', authenticate, authorizePermission('finance.update.all'), updateFeeStructure);
router.delete('/fee-structure/:id', authenticate, authorizePermission('finance.delete.all'), deleteFeeStructure);

// Fee Generation
router.post('/generate-demands', authenticate, authorizePermission('finance.create.all'), validateRequest(generateFeeDemandsSchema), generateFeeDemands);

// Fee Statistics
router.get('/fee-stats', authenticate, authorizePermission('finance.read.all'), getFeeStatistics);

// Discounts
router.post('/create-discount', authenticate, authorizePermission(['finance.create.all', 'finance.create.own']), validateRequest(createDiscountRequestSchema), createDiscountRequest);

router.post('/review-discount', authenticate, authorizePermission('finance.update.all'), validateRequest(reviewDiscountRequestSchema), reviewDiscountRequest);

router.post('/approve-discount', authenticate, authorizePermission('finance.update.all'), validateRequest(approveDiscountSchema), approveDiscount);

// Application Fee Configuration
router.get('/application-fee', authenticate, authorizePermission('finance.read.all'), getApplicationFee);

router.post('/application-fee', authenticate, authorizePermission('finance.update.all'), updateApplicationFee);

router.post('/collect-fee', authenticate, authorizePermission('finance.create.all'), collectFee);

// Ledger
router.get('/ledger/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getStudentLedger);

// Simplified Demands List
router.get('/student-demands/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getStudentFeeDemands);

// Allotment Order
router.get('/allotment-order/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), downloadAllotmentOrder);

export default router;
