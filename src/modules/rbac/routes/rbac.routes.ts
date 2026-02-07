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

// Groups
router.post('/groups', authenticate, authorizePermission('admin.create.all'), validateRequest(createGroupSchema), rbacController.createGroup);
router.get('/groups', authenticate, authorizePermission('admin.read.all'), rbacController.getGroups);
router.put('/groups/:groupId', authenticate, authorizePermission('admin.update.all'), validateRequest(updateGroupSchema), rbacController.updateGroup);
router.delete('/groups/:groupId', authenticate, authorizePermission('admin.delete.all'), validateRequest(deleteGroupSchema), rbacController.deleteGroup);
router.post('/groups/:groupId/roles', authenticate, authorizePermission('admin.update.all'), validateRequest(assignRolesToGroupSchema), rbacController.assignRolesToGroup);
router.post('/groups/:groupId/users', authenticate, authorizePermission('admin.update.all'), validateRequest(assignUsersToGroupSchema), rbacController.assignUsersToGroup);

// Roles
router.post('/roles', authenticate, authorizePermission('admin.create.all'), validateRequest(createRoleSchema), rbacController.createRole);
router.get('/roles', authenticate, authorizePermission('admin.read.all'), rbacController.getRoles);
router.put('/roles/:roleId', authenticate, authorizePermission('admin.update.all'), validateRequest(updateRoleSchema), rbacController.updateRole);
router.delete('/roles/:roleId', authenticate, authorizePermission('admin.delete.all'), validateRequest(deleteRoleSchema), rbacController.deleteRole);
router.post('/roles/:roleId/permissions', authenticate, authorizePermission('admin.update.all'), validateRequest(assignPermissionsToRoleSchema), rbacController.assignPermissionsToRole);

// Permissions
router.post('/permissions', authenticate, authorizePermission('admin.create.all'), validateRequest(createPermissionSchema), rbacController.createPermission);
router.get('/permissions', authenticate, authorizePermission('admin.read.all'), rbacController.getPermissions);
router.put('/permissions/:permissionId', authenticate, authorizePermission('admin.update.all'), validateRequest(updatePermissionSchema), rbacController.updatePermission);
router.delete('/permissions/:permissionId', authenticate, authorizePermission('admin.delete.all'), validateRequest(deletePermissionSchema), rbacController.deletePermission);

// Modules
router.post('/modules', authenticate, authorizePermission('admin.create.all'), validateRequest(createModuleSchema), rbacController.createModule);
router.get('/modules', authenticate, authorizePermission('admin.read.all'), rbacController.getModules);
router.put('/modules/:moduleId', authenticate, authorizePermission('admin.update.all'), validateRequest(updateModuleSchema), rbacController.updateModule);
router.delete('/modules/:moduleId', authenticate, authorizePermission('admin.delete.all'), validateRequest(deleteModuleSchema), rbacController.deleteModule);

export default router;
