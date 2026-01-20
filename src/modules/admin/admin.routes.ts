import { Router } from 'express';
import academicRoutes from '../academic/academic.routes';
import feeRoutes from '../finance/fee.routes';
import generalRoutes from './general.routes';
import hostelRoutes from '../infrastructure/hostel.routes';
import hostelPriceRoutes from '../infrastructure/hostelPrice.routes';
import studentRoutes from './studentManagement.routes';
import transportRoutes from '../infrastructure/transport.routes';
import dashboardRoutes from './dashboard.routes';

import bulkImportRoutes from './bulkImport.routes';
import scholarshipRoutes from './scholarship.routes';
import verificationRoutes from './verification.routes';

const router = Router();

router.use('/academic', academicRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/fee', feeRoutes);
router.use('/general', generalRoutes);
router.use('/hostel', hostelRoutes);
router.use('/hostel-prices', hostelPriceRoutes);
router.use('/student', studentRoutes); // Was studentRoutes in admin/index
router.use('/transport', transportRoutes);
router.use('/bulk-import', bulkImportRoutes);
router.use('/scholarship', scholarshipRoutes);
router.use('/verification', verificationRoutes);

export default router;
