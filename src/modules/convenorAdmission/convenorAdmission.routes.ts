import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import { list, listMine, listMyAllotments, listWithAdmin, getById, getByHallTicket, report, allot, exportCsv, updateStatus, custodianCertificate, updateDetails } from './convenorAdmission.controller';
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

router.get('/',                           authenticate, authorizePermission(['admission.read.all']),   validateRequest(listSchema),         list);
router.get('/my',                         authenticate, authorizePermission(['admission.read.own']),   validateRequest(listSchema),         listMine);
router.get('/my-allotments',              authenticate, authorizePermission(['admission.read.own']),   validateRequest(listSchema),         listMyAllotments);
router.get('/with-admin',                 authenticate, authorizePermission(['admission.read.all']),   validateRequest(listSchema),         listWithAdmin);
router.get('/export',                     authenticate, authorizePermission(['admission.read.all']),   validateRequest(exportSchema),       exportCsv);
router.get('/by-hall-ticket/:hallTicket', authenticate, authorizePermission(['admission.read.all']),   validateRequest(byHallTicketSchema), getByHallTicket);
router.get('/:id',                        authenticate, authorizePermission(['admission.read.all']),   validateRequest(getByIdSchema),      getById);
router.post('/:id/report',               authenticate, authorizePermission(['admission.create.all']), validateRequest(reportSchema),       report);
router.post('/:id/allot',                authenticate, authorizePermission(['admission.update.all']), validateRequest(allotSchema),        allot);
router.patch('/:id/status',              authenticate, authorizePermission(['admission.update.all']), validateRequest(updateStatusSchema), updateStatus);
router.patch('/:id',                     authenticate, authorizePermission(['admission.update.all']), validateRequest(updateDetailsSchema),updateDetails);
router.get('/:id/custodian-certificate', authenticate, authorizePermission(['document.read.all']),    validateRequest(getByIdSchema),      custodianCertificate);

export default router;
