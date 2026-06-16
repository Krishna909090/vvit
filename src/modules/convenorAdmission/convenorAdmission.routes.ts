import { Router } from 'express';
import { authenticate } from '../../middleware/rbac.middleware';
import { authorize } from '../../middleware/authMiddleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import { Role } from '../../constants/roles';
import { list, listMine, listWithAdmin, getById, getByHallTicket, report, allot, exportCsv, updateStatus, custodianCertificate, updateDetails } from './convenorAdmission.controller';
import {
  listSchema,
  exportSchema,
  byHallTicketSchema,
  getByIdSchema,
  reportSchema,
  allotSchema,
  updateStatusSchema,
  updateDetailsSchema,
} from './convenorAdmission.validators';

const router = Router();
const adminOnly = [authenticate, authorize([Role.SUPER_ADMIN, Role.ADMIN])];

router.get('/',                           ...adminOnly, validateRequest(listSchema),          list);
router.get('/my',                         ...adminOnly, validateRequest(listSchema),          listMine);
router.get('/with-admin',                 ...adminOnly, validateRequest(listSchema),          listWithAdmin);
router.get('/export',                     ...adminOnly, validateRequest(exportSchema),         exportCsv);
router.get('/by-hall-ticket/:hallTicket', ...adminOnly, validateRequest(byHallTicketSchema),  getByHallTicket);
router.get('/:id',                        ...adminOnly, validateRequest(getByIdSchema),        getById);
router.post('/:id/report',               ...adminOnly, validateRequest(reportSchema),        report);
router.post('/:id/allot',                ...adminOnly, validateRequest(allotSchema),         allot);
router.patch('/:id/status',              ...adminOnly, validateRequest(updateStatusSchema),  updateStatus);
router.patch('/:id',                     ...adminOnly, validateRequest(updateDetailsSchema), updateDetails);
router.get('/:id/custodian-certificate', ...adminOnly, validateRequest(getByIdSchema),       custodianCertificate);

export default router;
