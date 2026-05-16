import { Router } from 'express';
import academicRoutes from '../academic/academic.routes';
import feeRoutes from '../finance/fee.routes';
import generalRoutes from './general.routes';
import hostelRoutes from '../accommodation/hostel/hostel.routes';
import hostelPriceRoutes from '../accommodation/hostel/hostelPrice.routes';
import studentRoutes from '../studentManagement/studentManagement.routes';
import transportRoutes from '../accommodation/transport/transport.routes';
import dashboardRoutes from '../dashboard/dashboard.routes';

import bulkImportRoutes from '../admission/bulkImport/bulkImport.routes';
import scholarshipRoutes from '../finance/scholarship.routes';
import verificationRoutes from '../studentManagement/verification.routes';
import marksRoutes from '../marks/marks.routes';
import attendanceRoutes from '../attendance/attendance.routes';

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
router.use('/marks', marksRoutes);
router.use('/attendance', attendanceRoutes);

export default router;
