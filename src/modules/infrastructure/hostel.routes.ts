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
router.post('/', authenticate, authorizePermission('hostel.create'), validateRequest(createHostelSchema), createHostel);
router.get('/', authenticate, authorizePermission('hostel.read'), getHostels);

// Hostel Block
router.post('/block', authenticate, authorizePermission('hostel.create'), validateRequest(createHostelBlockSchema), createHostelBlock);
router.get('/block', authenticate, authorizePermission('hostel.read'), getHostelBlocks);
router.get('/block/:id', authenticate, authorizePermission('hostel.read'), getHostelBlockById);
router.put('/block/:id', authenticate, authorizePermission('hostel.update'), updateHostelBlock);
router.delete('/block/:id', authenticate, authorizePermission('hostel.delete'), deleteHostelBlock);

// Hostel Room
router.post('/room', authenticate, authorizePermission('hostel.create'), validateRequest(createHostelRoomSchema), createHostelRoom);
router.get('/room', authenticate, authorizePermission('hostel.read'), getHostelRooms);
router.get('/room/:id', authenticate, authorizePermission('hostel.read'), getHostelRoomById);
router.put('/room/:id', authenticate, authorizePermission('hostel.update'), updateHostelRoom);
router.delete('/room/:id', authenticate, authorizePermission('hostel.delete'), deleteHostelRoom);

// Hostel Management (ID specific routes moved to bottom to prevent shadowing)
router.get('/:id', authenticate, authorizePermission('hostel.read'), getHostelById);

router.put('/:hostelId', authenticate, authorizePermission('hostel.update'), validateRequest(updateHostelSchema), updateHostel);

router.delete('/:hostelId', authenticate, authorizePermission('hostel.delete'), deleteHostel);

export default router;
