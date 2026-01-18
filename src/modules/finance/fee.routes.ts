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
router.post('/fee-head', authenticate, authorizePermission('finance.fee.collect'), validateRequest(createFeeHeadSchema), createFeeHead);
router.get('/fee-head', authenticate, authorizePermission('finance.fee.view'), getFeeHeads);
router.put('/fee-head/:id', authenticate, authorizePermission('finance.fee.collect'), updateFeeHead);
router.delete('/fee-head/:id', authenticate, authorizePermission('finance.fee.collect'), deleteFeeHead);

// Fee Structure
router.post('/fee-structure/bulk', authenticate, authorizePermission('finance.fee.collect'), validateRequest(createBulkFeeStructureSchema), createBulkFeeStructure);
router.post('/fee-structure', authenticate, authorizePermission('finance.fee.collect'), validateRequest(createFeeStructureSchema), createFeeStructure);
router.get('/fee-structure', authenticate, authorizePermission('finance.fee.view'), getFeeStructures);
router.put('/fee-structure/:id', authenticate, authorizePermission('finance.fee.collect'), updateFeeStructure);
router.delete('/fee-structure/:id', authenticate, authorizePermission('finance.fee.collect'), deleteFeeStructure);

// Fee Generation
router.post('/generate-demands', authenticate, authorizePermission('finance.fee.collect'), validateRequest(generateFeeDemandsSchema), generateFeeDemands);

// Fee Statistics
router.get('/fee-stats', authenticate, authorizePermission('finance.report.view'), getFeeStatistics);

// Discounts
router.post('/create-discount', authenticate, authorizePermission('finance.fee.collect'), validateRequest(createDiscountRequestSchema), createDiscountRequest);

router.post('/review-discount', authenticate, authorizePermission('finance.fee.collect'), validateRequest(reviewDiscountRequestSchema), reviewDiscountRequest);

router.post('/approve-discount', authenticate, authorizePermission('finance.fee.collect'), validateRequest(approveDiscountSchema), approveDiscount);

// Application Fee Configuration
router.get('/application-fee', authenticate, authorizePermission('finance.fee.view'), getApplicationFee);

router.post('/application-fee', authenticate, authorizePermission('finance.fee.collect'), updateApplicationFee);

router.post('/collect-fee', authenticate, authorizePermission('finance.fee.collect'), collectFee);

// Ledger
router.get('/ledger/:studentId', authenticate, authorizePermission('finance.fee.view'), getStudentLedger);

// Simplified Demands List
router.get('/student-demands/:studentId', authenticate, authorizePermission('finance.fee.view'), getStudentFeeDemands);

// Allotment Order
router.get('/allotment-order/:studentId', authenticate, authorizePermission('finance.fee.view'), downloadAllotmentOrder);

export default router;
