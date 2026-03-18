import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getDashboardStats, addAdmin, getAgentCommissions, getUserDetails, addInvigilator, getStaffUsers, updateStaffUser, deleteStaffUser,
    getSystemSettings, updateSystemSetting, updateAgentCommissionStatus, assignUserRoleAndGroups, updateFullStaffDetails
} from './general.controller';
import {
    addAdminSchema, getAgentCommissionsSchema, addInvigilatorSchema, updateStaffUserSchema, assignRoleGroupSchema, updateFullStaffDetailsSchema
} from '../../validators/adminValidators';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /dashboard-stats
 * @desc    Retrieves high-level dashboard statistics for the admin panel.
 *          Returns aggregated counts and summaries used by the admin home screen.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Dashboard statistics payload.
 */
router.get('/dashboard-stats', authenticate, authorizePermission('admin.read.all'), getDashboardStats);

// ═══════════════════════════════════════════════════════════
//  USER & STAFF MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /add-admin
 * @desc    Creates a new admin user account.
 *          Inserts a user record with the admin role and sends an invitation/credentials.
 * @access  Requires `admin.create.all` permission.
 * @body    {object} Validated against `addAdminSchema` - includes name, email, phone, etc.
 * @returns {object} 201 - Newly created admin user details.
 */
router.post('/add-admin', authenticate, authorizePermission('admin.create.all'), validateRequest(addAdminSchema), addAdmin);

/**
 * @route   POST /add-invigilator
 * @desc    Creates a new invigilator user account.
 *          Registers the user with invigilator privileges for exam management.
 * @access  Requires `admin.create.all` permission.
 * @body    {object} Validated against `addInvigilatorSchema` - includes name, email, assigned centre, etc.
 * @returns {object} 201 - Newly created invigilator user details.
 */
router.post('/add-invigilator', authenticate, authorizePermission('admin.create.all'), validateRequest(addInvigilatorSchema), addInvigilator);

/**
 * @route   GET /user-details
 * @desc    Fetches detailed profile information for a specific user.
 *          Used by admins to inspect any user's full record.
 * @access  Requires `admin.read.all` permission.
 * @query   {string} userId - The ID of the user to look up (or similar identifier).
 * @returns {object} 200 - Full user profile object.
 */
router.get('/user-details', authenticate, authorizePermission('admin.read.all'), getUserDetails);

/**
 * @route   GET /staff-users
 * @desc    Lists all staff-level users (admins, invigilators, agents, etc.).
 *          Supports pagination and filtering for the staff management table.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Array of staff user records.
 */
router.get('/staff-users', authenticate, authorizePermission('admin.read.all'), getStaffUsers);

/**
 * @route   PUT /staff-users/:userId
 * @desc    Partially updates a staff user's profile fields.
 *          Modifies only the provided fields; leaves others unchanged.
 * @access  Requires `admin.update.all` permission.
 * @params  {string} userId - The staff user's unique ID.
 * @body    {object} Validated against `updateStaffUserSchema` - fields to update.
 * @returns {object} 200 - Updated staff user record.
 */
router.put('/staff-users/:userId', authenticate, authorizePermission('admin.update.all'), validateRequest(updateStaffUserSchema), updateStaffUser);

/**
 * @route   PUT /staff-users/:userId/full-update
 * @desc    Performs a complete replacement of a staff user's profile.
 *          Overwrites all editable fields; intended for full-form submissions.
 * @access  Requires `admin.update.all` permission.
 * @params  {string} userId - The staff user's unique ID.
 * @body    {object} Validated against `updateFullStaffDetailsSchema` - complete staff details.
 * @returns {object} 200 - Fully updated staff user record.
 */
router.put('/staff-users/:userId/full-update', authenticate, authorizePermission('admin.update.all'), validateRequest(updateFullStaffDetailsSchema), updateFullStaffDetails);

/**
 * @route   DELETE /staff-users/:userId
 * @desc    Deletes (or deactivates) a staff user account.
 *          Side-effect: revokes all active sessions and permissions for the user.
 * @access  Requires `admin.delete.all` permission.
 * @params  {string} userId - The staff user's unique ID.
 * @returns {object} 200 - Confirmation of deletion.
 */
router.delete('/staff-users/:userId', authenticate, authorizePermission('admin.delete.all'), deleteStaffUser);

/**
 * @route   POST /assign-role-group
 * @desc    Assigns a role and one or more permission groups to a user.
 *          Side-effect: replaces the user's current role/group assignments.
 * @access  Requires `admin.update.all` permission.
 * @body    {object} Validated against `assignRoleGroupSchema` - { userId, roleId, groupIds }.
 * @returns {object} 200 - Updated role and group assignment confirmation.
 */
router.post('/assign-role-group', authenticate, authorizePermission('admin.update.all'), validateRequest(assignRoleGroupSchema), assignUserRoleAndGroups);

// ═══════════════════════════════════════════════════════════
//  AGENT COMMISSIONS
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /commissions
 * @desc    Retrieves a list of agent commission records.
 *          Supports filtering by date range, agent, and status.
 * @access  Requires `admin.read.all` permission.
 * @query   Validated against `getAgentCommissionsSchema` - optional filters (agentId, status, date range, etc.).
 * @returns {object} 200 - Array of commission records with totals.
 */
router.get('/commissions', authenticate, authorizePermission('admin.read.all'), validateRequest(getAgentCommissionsSchema), getAgentCommissions);

/**
 * @route   PUT /commissions/:id/status
 * @desc    Updates the status of a specific agent commission (e.g., pending -> approved/rejected).
 *          Side-effect: may trigger a payment or notification workflow depending on the new status.
 * @access  Requires `admin.update.all` permission.
 * @params  {string} id - The commission record's unique ID.
 * @body    {object} { status: string } - The new commission status.
 * @returns {object} 200 - Updated commission record.
 */
router.put('/commissions/:id/status', authenticate, authorizePermission('admin.update.all'), updateAgentCommissionStatus);

// ═══════════════════════════════════════════════════════════
//  SYSTEM SETTINGS
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /settings
 * @desc    Retrieves all system-level configuration settings.
 *          Returns key-value pairs used across the application.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Array/map of system settings.
 */
router.get('/settings', authenticate, authorizePermission('admin.read.all'), getSystemSettings);

/**
 * @route   POST /settings/:key
 * @desc    Creates or updates a single system setting identified by its key.
 *          Uses POST with upsert semantics (creates if absent, updates if present).
 * @access  Requires `admin.update.all` permission.
 * @params  {string} key - The setting key to create or update.
 * @body    {object} { value: any } - The new value for the setting.
 * @returns {object} 200 - Updated setting record.
 */
router.post('/settings/:key', authenticate, authorizePermission('admin.update.all'), updateSystemSetting);

export default router;
