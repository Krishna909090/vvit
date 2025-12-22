import { Router } from 'express';
import academicRoutes from '../academic/academic.routes';
import feeRoutes from '../finance/fee.routes';
import generalRoutes from './general.routes';
import hostelRoutes from '../infrastructure/hostel.routes';
import studentRoutes from './studentManagement.routes';
import transportRoutes from '../infrastructure/transport.routes';

const router = Router();

router.use('/academic', academicRoutes);
router.use('/fee', feeRoutes);
router.use('/general', generalRoutes);
router.use('/hostel', hostelRoutes);
router.use('/students', studentRoutes); // Was studentRoutes in admin/index
router.use('/transport', transportRoutes);

export default router;
