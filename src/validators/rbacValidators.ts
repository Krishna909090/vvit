import { z } from 'zod';

export const createGroupSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Group name is required'),
    type: z.string().min(1, 'Group type is required'),
  }),
});

export const updateGroupSchema = z.object({
  params: z.object({
    groupId: z.string().uuid('Invalid Group ID format'),
  }),
  body: z.object({
    name: z.string().optional(),
    type: z.string().optional(),
  }),
});

export const deleteGroupSchema = z.object({
  params: z.object({
    groupId: z.string().uuid('Invalid Group ID format'),
  }),
});

export const assignRolesToGroupSchema = z.object({
  params: z.object({
    groupId: z.string().uuid('Invalid Group ID format'),
  }),
  body: z.object({
    roleIds: z.array(z.string().uuid('Invalid Role ID format')).min(1, 'At least one Role ID is required'),
  }),
});

export const assignUsersToGroupSchema = z.object({
  params: z.object({
    groupId: z.string().uuid('Invalid Group ID format'),
  }),
  body: z.object({
    userIds: z.array(z.string().uuid('Invalid User ID format')).min(1, 'At least one User ID is required'),
  }),
});

export const createRoleSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Role name is required'),
    description: z.string().optional(),
  }),
});

export const updateRoleSchema = z.object({
  params: z.object({
    roleId: z.string().uuid('Invalid Role ID format'),
  }),
  body: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
  }),
});

export const deleteRoleSchema = z.object({
  params: z.object({
    roleId: z.string().uuid('Invalid Role ID format'),
  }),
});

export const assignPermissionsToRoleSchema = z.object({
  params: z.object({
    roleId: z.string().uuid('Invalid Role ID format'),
  }),
  body: z.object({
    permissions: z.array(z.string().min(1)).min(1, 'At least one permission key is required'),
  }),
});

export const createPermissionSchema = z.object({
  body: z.object({
    key: z.string().min(1, 'Permission key is required').regex(/^[a-zA-Z]+\.[a-zA-Z]+\.[a-zA-Z]+$/, 'Key must follow module.action.scope format'),
    description: z.string().optional(),
    moduleId: z.string().uuid('Valid Module ID is required'),
  }),
});

export const updatePermissionSchema = z.object({
  params: z.object({
    permissionId: z.string().uuid('Invalid Permission ID format'),
  }),
  body: z.object({
    key: z.string().regex(/^[a-zA-Z]+\.[a-zA-Z]+\.[a-zA-Z]+$/, 'Key must follow module.action.scope format').optional(),
    description: z.string().optional(),
    moduleId: z.string().uuid('Valid Module ID is required').optional(),
  }),
});

export const deletePermissionSchema = z.object({
  params: z.object({
    permissionId: z.string().uuid('Invalid Permission ID format'),
  }),
});

export const createModuleSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Module name is required'),
    code: z.string().min(1, 'Module code is required'),
  }),
});

export const updateModuleSchema = z.object({
  params: z.object({
    moduleId: z.string().uuid('Invalid Module ID format'),
  }),
  body: z.object({
    name: z.string().optional(),
    code: z.string().optional(),
  }),
});

export const deleteModuleSchema = z.object({
  params: z.object({
    moduleId: z.string().uuid('Invalid Module ID format'),
  }),
});
