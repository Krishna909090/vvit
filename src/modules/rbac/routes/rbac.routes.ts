import { Router } from 'express';
import * as rbacController from '../rbac.controller';
import { authenticate, authorizePermission } from '../../../middleware/rbac.middleware';
import { validateRequest } from '../../../middlewares/validationMiddleware';
import {
    createGroupSchema,
    assignRolesToGroupSchema,
    assignUsersToGroupSchema,
    createRoleSchema,
    assignPermissionsToRoleSchema,
    createPermissionSchema,
    createModuleSchema,
    updateModuleSchema,
    deleteModuleSchema,
    updateGroupSchema,
    deleteGroupSchema,
    updateRoleSchema,
    deleteRoleSchema,
    updatePermissionSchema,
    deletePermissionSchema
} from '../../../validators/rbacValidators';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  GROUP MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /groups
 * @desc    Create a new RBAC group (e.g. "Admissions Office", "Finance Team").
 * @access  Requires `admin.create.all` permission.
 * @body    { name, description, ... } — validated against createGroupSchema.
 * @returns {{ success: boolean, data: Group }} The newly created group.
 */
router.post('/groups', authenticate, authorizePermission('admin.create.all'), validateRequest(createGroupSchema), rbacController.createGroup);

/**
 * @route   GET /groups
 * @desc    List all RBAC groups with their associated roles and users.
 * @access  Requires `admin.read.all` permission.
 * @returns {{ success: boolean, data: Group[] }} Array of group records.
 */
router.get('/groups', authenticate, authorizePermission('admin.read.all'), rbacController.getGroups);

/**
 * @route   PUT /groups/:groupId
 * @desc    Update an existing RBAC group's name or description.
 * @access  Requires `admin.update.all` permission.
 * @param   {string} groupId — The group ID.
 * @body    Fields to update — validated against updateGroupSchema.
 * @returns {{ success: boolean, data: Group }} The updated group.
 */
router.put('/groups/:groupId', authenticate, authorizePermission('admin.update.all'), validateRequest(updateGroupSchema), rbacController.updateGroup);

/**
 * @route   DELETE /groups/:groupId
 * @desc    Delete an RBAC group. Side-effect: removes all role and user associations for this group.
 * @access  Requires `admin.delete.all` permission.
 * @param   {string} groupId — The group ID — validated against deleteGroupSchema.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/groups/:groupId', authenticate, authorizePermission('admin.delete.all'), validateRequest(deleteGroupSchema), rbacController.deleteGroup);

/**
 * @route   POST /groups/:groupId/roles
 * @desc    Assign one or more roles to a group. Side-effect: all users in the group inherit these roles.
 * @access  Requires `admin.update.all` permission.
 * @param   {string} groupId — The group ID.
 * @body    { roleIds: string[] } — validated against assignRolesToGroupSchema.
 * @returns {{ success: boolean, data: Group }} The updated group with new role assignments.
 */
router.post('/groups/:groupId/roles', authenticate, authorizePermission('admin.update.all'), validateRequest(assignRolesToGroupSchema), rbacController.assignRolesToGroup);

/**
 * @route   POST /groups/:groupId/users
 * @desc    Assign one or more users to a group. Side-effect: users inherit all group roles immediately.
 * @access  Requires `admin.update.all` permission.
 * @param   {string} groupId — The group ID.
 * @body    { userIds: string[] } — validated against assignUsersToGroupSchema.
 * @returns {{ success: boolean, data: Group }} The updated group with new user assignments.
 */
router.post('/groups/:groupId/users', authenticate, authorizePermission('admin.update.all'), validateRequest(assignUsersToGroupSchema), rbacController.assignUsersToGroup);

// ═══════════════════════════════════════════════════════════
//  ROLE MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /roles
 * @desc    Create a new RBAC role (e.g. "Hostel Manager", "Finance Viewer").
 * @access  Requires `admin.create.all` permission.
 * @body    { name, description, ... } — validated against createRoleSchema.
 * @returns {{ success: boolean, data: Role }} The newly created role.
 */
router.post('/roles', authenticate, authorizePermission('admin.create.all'), validateRequest(createRoleSchema), rbacController.createRole);

/**
 * @route   GET /roles
 * @desc    List all RBAC roles with their associated permissions.
 * @access  Requires `admin.read.all` permission.
 * @returns {{ success: boolean, data: Role[] }} Array of role records.
 */
router.get('/roles', authenticate, authorizePermission('admin.read.all'), rbacController.getRoles);

/**
 * @route   PUT /roles/:roleId
 * @desc    Update an existing RBAC role's name or description.
 * @access  Requires `admin.update.all` permission.
 * @param   {string} roleId — The role ID.
 * @body    Fields to update — validated against updateRoleSchema.
 * @returns {{ success: boolean, data: Role }} The updated role.
 */
router.put('/roles/:roleId', authenticate, authorizePermission('admin.update.all'), validateRequest(updateRoleSchema), rbacController.updateRole);

/**
 * @route   DELETE /roles/:roleId
 * @desc    Delete an RBAC role. Side-effect: removes all permission and group associations for this role.
 * @access  Requires `admin.delete.all` permission.
 * @param   {string} roleId — The role ID — validated against deleteRoleSchema.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/roles/:roleId', authenticate, authorizePermission('admin.delete.all'), validateRequest(deleteRoleSchema), rbacController.deleteRole);

/**
 * @route   POST /roles/:roleId/permissions
 * @desc    Assign one or more permissions to a role. Side-effect: all users with this role gain these permissions.
 * @access  Requires `admin.update.all` permission.
 * @param   {string} roleId — The role ID.
 * @body    { permissionIds: string[] } — validated against assignPermissionsToRoleSchema.
 * @returns {{ success: boolean, data: Role }} The updated role with new permission assignments.
 */
router.post('/roles/:roleId/permissions', authenticate, authorizePermission('admin.update.all'), validateRequest(assignPermissionsToRoleSchema), rbacController.assignPermissionsToRole);

// ═══════════════════════════════════════════════════════════
//  PERMISSION MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /permissions
 * @desc    Create a new RBAC permission (e.g. "hostel.create.all").
 * @access  Requires `admin.create.all` permission.
 * @body    { name, moduleId, action, scope, ... } — validated against createPermissionSchema.
 * @returns {{ success: boolean, data: Permission }} The newly created permission.
 */
router.post('/permissions', authenticate, authorizePermission('admin.create.all'), validateRequest(createPermissionSchema), rbacController.createPermission);

/**
 * @route   GET /permissions
 * @desc    List all RBAC permissions across all modules.
 * @access  Requires `admin.read.all` permission.
 * @returns {{ success: boolean, data: Permission[] }} Array of permission records.
 */
router.get('/permissions', authenticate, authorizePermission('admin.read.all'), rbacController.getPermissions);

/**
 * @route   PUT /permissions/:permissionId
 * @desc    Update an existing permission's metadata.
 * @access  Requires `admin.update.all` permission.
 * @param   {string} permissionId — The permission ID.
 * @body    Fields to update — validated against updatePermissionSchema.
 * @returns {{ success: boolean, data: Permission }} The updated permission.
 */
router.put('/permissions/:permissionId', authenticate, authorizePermission('admin.update.all'), validateRequest(updatePermissionSchema), rbacController.updatePermission);

/**
 * @route   DELETE /permissions/:permissionId
 * @desc    Delete an RBAC permission. Side-effect: removes it from all roles that reference it.
 * @access  Requires `admin.delete.all` permission.
 * @param   {string} permissionId — The permission ID — validated against deletePermissionSchema.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/permissions/:permissionId', authenticate, authorizePermission('admin.delete.all'), validateRequest(deletePermissionSchema), rbacController.deletePermission);

// ═══════════════════════════════════════════════════════════
//  MODULE MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /modules
 * @desc    Create a new RBAC module (top-level permission namespace, e.g. "hostel", "finance").
 * @access  Requires `admin.create.all` permission.
 * @body    { name, description, ... } — validated against createModuleSchema.
 * @returns {{ success: boolean, data: Module }} The newly created module.
 */
router.post('/modules', authenticate, authorizePermission('admin.create.all'), validateRequest(createModuleSchema), rbacController.createModule);

/**
 * @route   GET /modules
 * @desc    List all RBAC modules.
 * @access  Requires `admin.read.all` permission.
 * @returns {{ success: boolean, data: Module[] }} Array of module records.
 */
router.get('/modules', authenticate, authorizePermission('admin.read.all'), rbacController.getModules);

/**
 * @route   PUT /modules/:moduleId
 * @desc    Update an existing module's name or description.
 * @access  Requires `admin.update.all` permission.
 * @param   {string} moduleId — The module ID.
 * @body    Fields to update — validated against updateModuleSchema.
 * @returns {{ success: boolean, data: Module }} The updated module.
 */
router.put('/modules/:moduleId', authenticate, authorizePermission('admin.update.all'), validateRequest(updateModuleSchema), rbacController.updateModule);

/**
 * @route   DELETE /modules/:moduleId
 * @desc    Delete an RBAC module. Side-effect: may cascade-delete associated permissions.
 * @access  Requires `admin.delete.all` permission.
 * @param   {string} moduleId — The module ID — validated against deleteModuleSchema.
 * @returns {{ success: boolean, message: string }}
 */
router.delete('/modules/:moduleId', authenticate, authorizePermission('admin.delete.all'), validateRequest(deleteModuleSchema), rbacController.deleteModule);

export default router;
