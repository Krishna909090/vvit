import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
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
router.post('/', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createHostelSchema), createHostel);
router.get('/', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostels);

// Hostel Block
router.post('/block', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createHostelBlockSchema), createHostelBlock);
router.get('/block', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostelBlocks);
router.get('/block/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostelBlockById);
router.put('/block/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateHostelBlock);
router.delete('/block/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteHostelBlock);

// Hostel Room
router.post('/room', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createHostelRoomSchema), createHostelRoom);
router.get('/room', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostelRooms);
router.get('/room/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostelRoomById);
router.put('/room/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateHostelRoom);
router.delete('/room/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteHostelRoom);

// Hostel Management (ID specific routes moved to bottom to prevent shadowing)
router.get('/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getHostelById);

router.put('/:hostelId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateHostelSchema), updateHostel);

router.delete('/:hostelId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteHostel);

export default router;
