import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createHostel, getHostels, getHostelById, updateHostel, deleteHostel,
    createHostelBlock, getHostelBlocks, getHostelBlockById, updateHostelBlock, deleteHostelBlock,
    createHostelRoom, getHostelRooms, getHostelRoomById, updateHostelRoom, deleteHostelRoom
} from './hostel.controller';
import {
    createHostelBlockSchema, createHostelRoomSchema
} from '../../validators/adminValidators';
import { createHostelSchema, updateHostelSchema } from '../../validators/hostelValidators';

const router = Router();

// Hostel Management
// Hostel Management
router.post('/', authenticate, authorizePermission('infra.hostel.manage'), validateRequest(createHostelSchema), createHostel);
router.get('/', authenticate, authorizePermission('infra.view'), getHostels);

// Hostel Block
router.post('/block', authenticate, authorizePermission('infra.hostel.manage'), validateRequest(createHostelBlockSchema), createHostelBlock);
router.get('/block', authenticate, authorizePermission('infra.view'), getHostelBlocks);
router.get('/block/:id', authenticate, authorizePermission('infra.view'), getHostelBlockById);
router.put('/block/:id', authenticate, authorizePermission('infra.hostel.manage'), updateHostelBlock);
router.delete('/block/:id', authenticate, authorizePermission('infra.hostel.manage'), deleteHostelBlock);

// Hostel Room
router.post('/room', authenticate, authorizePermission('infra.hostel.manage'), validateRequest(createHostelRoomSchema), createHostelRoom);
router.get('/room', authenticate, authorizePermission('infra.view'), getHostelRooms);
router.get('/room/:id', authenticate, authorizePermission('infra.view'), getHostelRoomById);
router.put('/room/:id', authenticate, authorizePermission('infra.hostel.manage'), updateHostelRoom);
router.delete('/room/:id', authenticate, authorizePermission('infra.hostel.manage'), deleteHostelRoom);

// Hostel Management (ID specific routes moved to bottom to prevent shadowing)
router.get('/:id', authenticate, authorizePermission('infra.view'), getHostelById);

router.put('/:hostelId', authenticate, authorizePermission('infra.hostel.manage'), validateRequest(updateHostelSchema), updateHostel);

router.delete('/:hostelId', authenticate, authorizePermission('infra.hostel.manage'), deleteHostel);

export default router;
