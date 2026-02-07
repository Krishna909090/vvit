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
router.post('/', authenticate, authorizePermission('hostel.create.all'), validateRequest(createHostelSchema), createHostel);
router.get('/', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostels);

// Hostel Block
router.post('/block', authenticate, authorizePermission('hostel.create.all'), validateRequest(createHostelBlockSchema), createHostelBlock);
router.get('/block', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelBlocks);
router.get('/block/:id', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelBlockById);
router.put('/block/:id', authenticate, authorizePermission('hostel.update.all'), updateHostelBlock);
router.delete('/block/:id', authenticate, authorizePermission('hostel.delete.all'), deleteHostelBlock);

// Hostel Room
router.post('/room', authenticate, authorizePermission('hostel.create.all'), validateRequest(createHostelRoomSchema), createHostelRoom);
router.get('/room', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelRooms);
router.get('/room/:id', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelRoomById);
router.put('/room/:id', authenticate, authorizePermission('hostel.update.all'), updateHostelRoom);
router.delete('/room/:id', authenticate, authorizePermission('hostel.delete.all'), deleteHostelRoom);

// Hostel Management (ID specific routes moved to bottom to prevent shadowing)
router.get('/:id', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelById);

router.put('/:hostelId', authenticate, authorizePermission('hostel.update.all'), validateRequest(updateHostelSchema), updateHostel);

router.delete('/:hostelId', authenticate, authorizePermission('hostel.delete.all'), deleteHostel);

export default router;
