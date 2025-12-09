import { Router } from 'express';
import adminRouter from './admin/index';

const router = Router();

router.use('/', adminRouter);

export default router;
