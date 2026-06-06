import { Router } from 'express';
import { authenticate, authorizePermission } from '../../../middleware/rbac.middleware';
import { validateRequest } from '../../../middleware/validationMiddleware';
import {
    createHostel, getHostels, getHostelById, getHostelFloors, updateHostel, deleteHostel,
    createHostelRoom, getHostelRooms, getHostelRoomById, updateHostelRoom, deleteHostelRoom,
    createHostelRoomsBulk, sendHostelAllotmentEmails
} from './hostel.controller';
import { createHostelSchema, updateHostelSchema, createHostelRoomsBulkSchema, createHostelRoomSchema, updateHostelRoomSchema, hostelIdParamSchema, roomIdParamSchema } from '../../../validators/hostelValidators';

const router = Router();

router.post('/', authenticate, authorizePermission('hostel.create.all'), validateRequest(createHostelSchema), createHostel);

router.get('/', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostels);

router.post('/room', authenticate, authorizePermission('hostel.create.all'), validateRequest(createHostelRoomSchema), createHostelRoom);

router.post('/room/bulk', authenticate, authorizePermission('hostel.create.all'), validateRequest(createHostelRoomsBulkSchema), createHostelRoomsBulk);

router.get('/room', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelRooms);

router.get('/room/:id', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelRoomById);

router.put('/room/:id', authenticate, authorizePermission('hostel.update.all'), validateRequest(updateHostelRoomSchema), updateHostelRoom);

router.delete('/room/:id', authenticate, authorizePermission('hostel.delete.all'), validateRequest(roomIdParamSchema), deleteHostelRoom);

router.post('/send-allotment-emails', authenticate, authorizePermission(['hostel.update.all']), sendHostelAllotmentEmails);

router.get('/:hostelId/floors', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelFloors);

router.get('/:id', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelById);

router.put('/:hostelId', authenticate, authorizePermission('hostel.update.all'), validateRequest(updateHostelSchema), updateHostel);

router.delete('/:hostelId', authenticate, authorizePermission('hostel.delete.all'), validateRequest(hostelIdParamSchema), deleteHostel);

export default router;
