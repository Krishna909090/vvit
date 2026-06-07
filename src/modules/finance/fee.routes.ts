import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import {
    createFeeHead, getFeeHeads, updateFeeHead, deleteFeeHead,
    createFeeStructure, createBulkFeeStructure, bulkHeadsFeeStructure, cloneFeeStructures, getFeeStructures, updateFeeStructure, deleteFeeStructure,
    getFeeStatistics,
    createDiscountRequest, updateDiscountRequest, deleteDiscountRequest, approveDiscount,
    getApplicationFee, updateApplicationFee,
    collectFee, getStudentLedger, downloadAllotmentOrder, generateFeeDemands, generateFeeDemandsBulk, getStudentFeeDemands, getPaymentHistory,
    addStudentDiscount,
    getDiscountRequests,
    getCourseFeeHeads,
    changeAccommodationType,
    getFeeCorrections,
    applyFeeCorrection,
    settleFeeCorrection,
    getCancellationMetrics
} from './fee.controller';

import {
    createFeeHeadSchema, updateFeeHeadSchema, createFeeStructureSchema, createBulkFeeStructureSchema,
    bulkHeadsFeeStructureSchema,
    cloneFeeStructuresSchema,
    createDiscountRequestSchema, updateDiscountRequestSchema, approveDiscountSchema, generateFeeDemandsSchema,
    generateFeeDemandsBulkSchema, applyFeeCorrectionSchema, settleFeeCorrectionSchema
} from '../../validators/adminValidators';
import {
    setApplicationFeeSchema, collectFeeSchema, addStudentDiscountSchema, changeAccommodationSchema
} from '../../validators/paymentValidators';

const router = Router();

router.post('/fee-head', authenticate, authorizePermission('finance.create.all'), validateRequest(createFeeHeadSchema), createFeeHead);

router.get('/fee-head', authenticate, authorizePermission('finance.read.all'), getFeeHeads);

router.put('/fee-head/:id', authenticate, authorizePermission('finance.update.all'), validateRequest(updateFeeHeadSchema), updateFeeHead);

router.delete('/fee-head/:id', authenticate, authorizePermission('finance.delete.all'), deleteFeeHead);

router.get('/course-fee-heads/:courseId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getCourseFeeHeads);

router.post('/fee-structure/bulk', authenticate, authorizePermission('finance.create.all'), validateRequest(createBulkFeeStructureSchema), createBulkFeeStructure);

router.post('/fee-structure/bulk-heads',
    authenticate,
    authorizePermission('finance.create.all'),
    validateRequest(bulkHeadsFeeStructureSchema),
    bulkHeadsFeeStructure,
);

router.post('/fee-structure', authenticate, authorizePermission('finance.create.all'), validateRequest(createFeeStructureSchema), createFeeStructure);

router.post('/fee-structure/clone-academic-year',
    authenticate,
    authorizePermission('finance.create.all'),
    validateRequest(cloneFeeStructuresSchema),
    cloneFeeStructures
);

router.get('/fee-structure', authenticate, authorizePermission('finance.read.all'), getFeeStructures);

router.get('/fee-corrections', authenticate, authorizePermission('finance.read.all'), getFeeCorrections);

router.get('/cancellation-metrics', authenticate, authorizePermission('finance.read.all'), getCancellationMetrics);

router.post('/fee-corrections/:id/apply',  authenticate, authorizePermission('finance.update.all'), validateRequest(applyFeeCorrectionSchema),  applyFeeCorrection);
router.post('/fee-corrections/:id/settle', authenticate, authorizePermission('finance.update.all'), validateRequest(settleFeeCorrectionSchema), settleFeeCorrection);

router.put('/fee-structure/:id', authenticate, authorizePermission('finance.update.all'), updateFeeStructure);

router.delete('/fee-structure/:id', authenticate, authorizePermission('finance.delete.all'), deleteFeeStructure);

router.post('/generate-demands', authenticate, authorizePermission('finance.create.all'), validateRequest(generateFeeDemandsSchema), generateFeeDemands);

router.post('/generate-demands-bulk', authenticate, authorizePermission('finance.create.all'), validateRequest(generateFeeDemandsBulkSchema), generateFeeDemandsBulk);

router.get('/fee-stats', authenticate, authorizePermission('finance.read.all'), getFeeStatistics);

router.get('/discounts', authenticate, authorizePermission('finance.read.all'), getDiscountRequests);

router.post('/create-discount', authenticate, authorizePermission(['finance.create.all', 'finance.create.own']), validateRequest(createDiscountRequestSchema), createDiscountRequest);

router.put('/update-discount/:id', authenticate, authorizePermission(['finance.update.all', 'finance.update.own']), validateRequest(updateDiscountRequestSchema), updateDiscountRequest);

router.delete('/delete-discount/:id', authenticate, authorizePermission(['finance.delete.all', 'finance.delete.own']), deleteDiscountRequest);

router.post('/approve-discount', authenticate, authorizePermission('finance.update.all'), validateRequest(approveDiscountSchema), approveDiscount);

router.get('/application-fee', authenticate, authorizePermission('finance.read.all'), getApplicationFee);

router.post('/application-fee', authenticate, authorizePermission('finance.update.all'), validateRequest(setApplicationFeeSchema), updateApplicationFee);

router.post('/collect-fee', authenticate, authorizePermission('finance.create.all'), validateRequest(collectFeeSchema), collectFee);

router.get('/ledger/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getStudentLedger);

router.get('/student-demands/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getStudentFeeDemands);

router.get('/allotment-order/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), downloadAllotmentOrder);

router.post('/student-discount', authenticate, authorizePermission('finance.create.all'), validateRequest(addStudentDiscountSchema), addStudentDiscount);

router.get('/payment-history/:studentId', authenticate, authorizePermission(['finance.read.all', 'finance.read.own']), getPaymentHistory);

router.post('/change-accommodation', authenticate, authorizePermission('finance.update.all'), validateRequest(changeAccommodationSchema), changeAccommodationType);

export default router;
