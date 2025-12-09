import { Router } from 'express';
import academicRoutes from './academicRoutes';
import examRoutes from './examRoutes';
import feeRoutes from './feeRoutes';
import generalRoutes from './generalRoutes';
import hostelRoutes from './hostelRoutes';
import studentRoutes from './studentRoutes';
import transportRoutes from './transportRoutes';

const router = Router();

router.use('/', academicRoutes);
router.use('/', examRoutes);
router.use('/', feeRoutes);
router.use('/', generalRoutes);
router.use('/', hostelRoutes);
router.use('/', studentRoutes);
router.use('/', transportRoutes);

export default router;
