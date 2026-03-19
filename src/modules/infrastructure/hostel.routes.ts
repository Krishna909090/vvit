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

// ═══════════════════════════════════════════════════════════
//  HOSTEL MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /
 * @desc    Create a new hostel entry.
 * @access  Requires `hostel.create.all` permission.
 * @body    { name, code, type, ... } — validated against createHostelSchema.
 * @returns {{ success: boolean, data: Hostel }} The newly created hostel object.
 */
router.post('/', authenticate, authorizePermission('hostel.create.all'), validateRequest(createHostelSchema), createHostel);

/**
 * @route   GET /
 * @desc    Retrieve a list of all hostels. Accessible by admins and students during admission.
 * @access  Requires `hostel.read.all`, `student.create.own`, or `student.create.all` permission.
 * @returns {{ success: boolean, data: Hostel[] }} Array of hostel records.
 */
router.get('/', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostels);

// ═══════════════════════════════════════════════════════════
//  HOSTEL BLOCK MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /block
 * @desc    Create a new hostel block within a hostel.
 * @access  Requires `hostel.create.all` permission.
 * @body    { hostelId, blockName, ... } — validated against createHostelBlockSchema.
 * @returns {{ success: boolean, data: HostelBlock }} The newly created block.
 */
router.post('/block', authenticate, authorizePermission('hostel.create.all'), validateRequest(createHostelBlockSchema), createHostelBlock);

/**
 * @route   GET /block
 * @desc    Retrieve all hostel blocks. Used by admins and students selecting accommodation.
 * @access  Requires `hostel.read.all`, `student.create.own`, or `student.create.all` permission.
 * @returns {{ success: boolean, data: HostelBlock[] }} Array of hostel block records.
 */
router.get('/block', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelBlocks);

/**
 * @route   GET /block/:id
 * @desc    Retrieve a single hostel block by its ID.
 * @access  Requires `hostel.read.all`, `student.create.own`, or `student.create.all` permission.
 * @param   {string} id — The hostel block ID.
 * @returns {{ success: boolean, data: HostelBlock }} The matching block record.
 */
router.get('/block/:id', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelBlockById);

/**
 * @route   PUT /block/:id
 * @desc    Update an existing hostel block.
 * @access  Requires `hostel.update.all` permission.
 * @param   {string} id — The hostel block ID.
 * @body    Fields to update (blockName, status, etc.).
 * @returns {{ success: boolean, data: HostelBlock }} The updated block record.
 */
router.put('/block/:id', authenticate, authorizePermission('hostel.update.all'), updateHostelBlock);

/**
 * @route   DELETE /block/:id
 * @desc    Delete a hostel block. Side-effect: may cascade-delete associated rooms.
 * @access  Requires `hostel.delete.all` permission.
 * @param   {string} id — The hostel block ID.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/block/:id', authenticate, authorizePermission('hostel.delete.all'), deleteHostelBlock);

// ═══════════════════════════════════════════════════════════
//  HOSTEL ROOM MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /room
 * @desc    Create a new hostel room within a block.
 * @access  Requires `hostel.create.all` permission.
 * @body    { blockId, roomNumber, capacity, ... } — validated against createHostelRoomSchema.
 * @returns {{ success: boolean, data: HostelRoom }} The newly created room record.
 */
router.post('/room', authenticate, authorizePermission('hostel.create.all'), validateRequest(createHostelRoomSchema), createHostelRoom);

/**
 * @route   GET /room
 * @desc    Retrieve all hostel rooms. Used during room allocation and student admission.
 * @access  Requires `hostel.read.all`, `student.create.own`, or `student.create.all` permission.
 * @returns {{ success: boolean, data: HostelRoom[] }} Array of room records.
 */
router.get('/room', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelRooms);

/**
 * @route   GET /room/:id
 * @desc    Retrieve a single hostel room by its ID.
 * @access  Requires `hostel.read.all`, `student.create.own`, or `student.create.all` permission.
 * @param   {string} id — The hostel room ID.
 * @returns {{ success: boolean, data: HostelRoom }} The matching room record.
 */
router.get('/room/:id', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelRoomById);

/**
 * @route   PUT /room/:id
 * @desc    Update an existing hostel room (e.g. capacity, status).
 * @access  Requires `hostel.update.all` permission.
 * @param   {string} id — The hostel room ID.
 * @body    Fields to update.
 * @returns {{ success: boolean, data: HostelRoom }} The updated room record.
 */
router.put('/room/:id', authenticate, authorizePermission('hostel.update.all'), updateHostelRoom);

/**
 * @route   DELETE /room/:id
 * @desc    Delete a hostel room.
 * @access  Requires `hostel.delete.all` permission.
 * @param   {string} id — The hostel room ID.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/room/:id', authenticate, authorizePermission('hostel.delete.all'), deleteHostelRoom);

// ═══════════════════════════════════════════════════════════
//  HOSTEL — ID-SPECIFIC ROUTES (placed last to prevent path shadowing)
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /:id
 * @desc    Retrieve a single hostel by its ID.
 * @access  Requires `hostel.read.all`, `student.create.own`, or `student.create.all` permission.
 * @param   {string} id — The hostel ID.
 * @returns {{ success: boolean, data: Hostel }} The matching hostel record.
 */
router.get('/:id', authenticate, authorizePermission(['hostel.read.all', 'student.create.own', 'student.create.all']), getHostelById);

/**
 * @route   PUT /:hostelId
 * @desc    Update an existing hostel (name, type, status, etc.).
 * @access  Requires `hostel.update.all` permission.
 * @param   {string} hostelId — The hostel ID.
 * @body    Fields to update — validated against updateHostelSchema.
 * @returns {{ success: boolean, data: Hostel }} The updated hostel record.
 */
router.put('/:hostelId', authenticate, authorizePermission('hostel.update.all'), validateRequest(updateHostelSchema), updateHostel);

/**
 * @route   DELETE /:hostelId
 * @desc    Delete a hostel. Side-effect: may cascade-delete associated blocks and rooms.
 * @access  Requires `hostel.delete.all` permission.
 * @param   {string} hostelId — The hostel ID.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/:hostelId', authenticate, authorizePermission('hostel.delete.all'), deleteHostel);

export default router;
