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
router.post('/fee-head', authenticate, authorizePermission('finance.create'), validateRequest(createFeeHeadSchema), createFeeHead);
router.get('/fee-head', authenticate, authorizePermission('finance.read'), getFeeHeads);
router.put('/fee-head/:id', authenticate, authorizePermission('finance.update'), updateFeeHead);
router.delete('/fee-head/:id', authenticate, authorizePermission('finance.delete'), deleteFeeHead);

// Fee Structure
router.post('/fee-structure/bulk', authenticate, authorizePermission('finance.create'), validateRequest(createBulkFeeStructureSchema), createBulkFeeStructure);
router.post('/fee-structure', authenticate, authorizePermission('finance.create'), validateRequest(createFeeStructureSchema), createFeeStructure);
router.get('/fee-structure', authenticate, authorizePermission('finance.read'), getFeeStructures);
router.put('/fee-structure/:id', authenticate, authorizePermission('finance.update'), updateFeeStructure);
router.delete('/fee-structure/:id', authenticate, authorizePermission('finance.delete'), deleteFeeStructure);

// Fee Generation
router.post('/generate-demands', authenticate, authorizePermission('finance.create'), validateRequest(generateFeeDemandsSchema), generateFeeDemands); // Generates new demands

// Fee Statistics
router.get('/fee-stats', authenticate, authorizePermission('finance.read'), getFeeStatistics);

// Discounts
router.post('/create-discount', authenticate, authorizePermission('finance.create'), validateRequest(createDiscountRequestSchema), createDiscountRequest);

router.post('/review-discount', authenticate, authorizePermission('finance.update'), validateRequest(reviewDiscountRequestSchema), reviewDiscountRequest);

router.post('/approve-discount', authenticate, authorizePermission('finance.update'), validateRequest(approveDiscountSchema), approveDiscount);

// Application Fee Configuration
router.get('/application-fee', authenticate, authorizePermission('finance.read'), getApplicationFee);

router.post('/application-fee', authenticate, authorizePermission('finance.update'), updateApplicationFee);

router.post('/collect-fee', authenticate, authorizePermission('finance.create'), collectFee); // Collecting fee creates a transaction

// Ledger
router.get('/ledger/:studentId', authenticate, authorizePermission('finance.read'), getStudentLedger);

// Simplified Demands List
router.get('/student-demands/:studentId', authenticate, authorizePermission('finance.read'), getStudentFeeDemands);

// Allotment Order - user listed "admission" as a module.
router.get('/allotment-order/:studentId', authenticate, authorizePermission('admission.read'), downloadAllotmentOrder);

export default router;
