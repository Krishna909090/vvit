import prisma from '../../../config/prisma';
import { AppError } from '../../../utils/AppError';

// --- GROUPS ---
export const createGroup = async (data: { name: string; type: string }) => {
  const existingName = await prisma.group.findUnique({ where: { name: data.name } });
  if (existingName) {
    throw new AppError(`Group with name '${data.name}' already exists`, 409);
  }
  const existingType = await prisma.group.findFirst({ where: { type: data.type } });
  if (existingType) {
    throw new AppError(`Group with type '${data.type}' already exists`, 409);
  }
  return prisma.group.create({ data });
};

export const getGroups = async () => {
  return prisma.group.findMany({
    include: {
      _count: { select: { users: true, roles: true } }
    }
  });
};

export const updateGroup = async (groupId: string, data: { name?: string; type?: string }) => {
  const existing = await prisma.group.findUnique({ where: { id: groupId } });
  if (!existing) {
    throw new AppError('Group not found', 404);
  }

  if (data.name && data.name !== existing.name) {
    const nameExists = await prisma.group.findUnique({ where: { name: data.name } });
    if (nameExists) {
      throw new AppError(`Group with name '${data.name}' already exists`, 409);
    }
  }

  return prisma.group.update({
    where: { id: groupId },
    data,
  });
};

export const deleteGroup = async (groupId: string) => {
  const existing = await prisma.group.findUnique({ 
    where: { id: groupId },
    include: { 
      users: { include: { user: { select: { id: true, name: true, email: true } } } },
      roles: { include: { role: { select: { id: true, name: true } } } }
    }
  });

  if (!existing) {
    throw new AppError('Group not found', 404);
  }

  const userCount = existing.users.length;
  const roleCount = existing.roles.length;

  if (userCount > 0 || roleCount > 0) {
    const details: any = {};

    if (userCount > 0) {
      details.users = existing.users.map(u => ({
        id: u.user.id,
        name: u.user.name || 'Unknown',
        email: u.user.email
      }));
    }

    if (roleCount > 0) {
      details.roles = existing.roles.map(r => ({
        id: r.role.id,
        name: r.role.name
      }));
    }

    throw new AppError('Cannot delete group due to existing assignments.', 400, details);
  }

  return prisma.group.delete({ where: { id: groupId } });
};

export const assignRolesToGroup = async (groupId: string, roleIds: string[]) => {
  // Check for existing assignments
  const existingAssignments = await prisma.groupRole.findMany({
    where: {
      groupId,
      roleId: { in: roleIds }
    },
    include: { role: true }
  });

  if (existingAssignments.length > 0) {
    const duplicateNames = existingAssignments.map(ea => ea.role.name).join(', ');
    throw new AppError(`The following roles are already assigned to this group: [${duplicateNames}]`, 409);
  }

  const data = roleIds.map(roleId => ({ groupId, roleId }));
  return prisma.groupRole.createMany({ data });
};

export const assignUsersToGroup = async (groupId: string, userIds: string[]) => {
  // Check for existing assignments
  const existingAssignments = await prisma.userGroup.findMany({
    where: {
      groupId,
      userId: { in: userIds }
    },
    include: { user: true }
  });

  if (existingAssignments.length > 0) {
    const duplicateUsers = existingAssignments.map(ea => ea.user.email || ea.user.id).join(', ');
    throw new AppError(`The following users are already assigned to this group: [${duplicateUsers}]`, 409);
  }

  const data = userIds.map(userId => ({ groupId, userId }));
  return prisma.userGroup.createMany({ data });
};

// --- ROLES ---
export const createRole = async (data: { name: string; description?: string }) => {
  const existing = await prisma.role.findUnique({ where: { name: data.name } });
  if (existing) {
    throw new AppError(`Role with name '${data.name}' already exists`, 409);
  }
  return prisma.role.create({ data });
};

export const getRoles = async () => {
  return prisma.role.findMany({
    include: {
      permissions: { include: { permission: true } }
    }
  });
};



export const assignPermissionsToRole = async (roleId: string, permissionKeys: string[]) => {
  // Translate keys to IDs
  const permissions = await prisma.permission.findMany({
    where: { key: { in: permissionKeys } }
  });
  
  if (permissions.length === 0) {
      // If no permissions found for the keys, maybe throw an error or just return
      // Typically if we ask to assign 'A', and 'A' doesn't exist, we might want to warn
      // But for duplicate checking, let's focus on duplicates.
  }

  const permissionIds = permissions.map(p => p.id);

  // Check for existing assignments
  const existingAssignments = await prisma.rolePermission.findMany({
    where: {
      roleId,
      permissionId: { in: permissionIds }
    },
    include: { permission: true }
  });

  if (existingAssignments.length > 0) {
    const duplicateKeys = existingAssignments.map(ea => ea.permission.key).join(', ');
    throw new AppError(`The following permissions are already assigned to this role: [${duplicateKeys}]`, 409);
  }
  
  const data = permissionIds.map(permissionId => ({ roleId, permissionId }));
  return prisma.rolePermission.createMany({ data });
};

export const updateRole = async (roleId: string, data: { name?: string; description?: string }) => {
  const existing = await prisma.role.findUnique({ where: { id: roleId } });
  if (!existing) {
    throw new AppError('Role not found', 404);
  }

  if (data.name && data.name !== existing.name) {
    const nameExists = await prisma.role.findUnique({ where: { name: data.name } });
    if (nameExists) {
      throw new AppError(`Role with name '${data.name}' already exists`, 409);
    }
  }

  return prisma.role.update({
    where: { id: roleId },
    data,
  });
};

export const deleteRole = async (roleId: string) => {
  const existing = await prisma.role.findUnique({ where: { id: roleId } });
  if (!existing) {
    throw new AppError('Role not found', 404);
  }
  return prisma.role.delete({ where: { id: roleId } });
};

// --- PERMISSIONS ---
export const createPermission = async (data: { key: string; description?: string; moduleId: string }) => {
  // Check if permission already exists in this module
  const existingInModule = await prisma.permission.findFirst({
    where: {
      key: data.key,
      moduleId: data.moduleId
    }
  });

  if (existingInModule) {
    throw new AppError(`Permission with key '${data.key}' already exists in this module`, 409);
  }

  // Check global uniqueness of Key (since schema enforces it)
  const existingKey = await prisma.permission.findUnique({ where: { key: data.key } });
  if (existingKey) {
     throw new AppError(`Permission with key '${data.key}' already exists in module (ID: ${existingKey.moduleId}). Keys must be globally unique.`, 409);
  }
  
  // Ensure module exists first
  const moduleExists = await prisma.module.findUnique({ where: { id: data.moduleId } });
  if (!moduleExists) {
    throw new AppError(`Module with id ${data.moduleId} not found`, 404);
  }
  return prisma.permission.create({ data });
};

export const getPermissions = async () => {
  return prisma.permission.findMany({
    include: { module: true }
  });
};

export const updatePermission = async (permissionId: string, data: { key?: string; description?: string; moduleId?: string }) => {
  const existing = await prisma.permission.findUnique({ where: { id: permissionId } });
  if (!existing) {
    throw new AppError('Permission not found', 404);
  }

  if (data.key && data.key !== existing.key) {
    const keyExists = await prisma.permission.findUnique({ where: { key: data.key } });
    if (keyExists) {
      throw new AppError(`Permission with key '${data.key}' already exists`, 409);
    }
  }

  if (data.moduleId) {
    const moduleExists = await prisma.module.findUnique({ where: { id: data.moduleId } });
    if (!moduleExists) {
      throw new AppError(`Module with id ${data.moduleId} not found`, 404);
    }
  }
  
  return prisma.permission.update({
    where: { id: permissionId },
    data,
  });
};

export const deletePermission = async (permissionId: string) => {
  const existing = await prisma.permission.findUnique({ where: { id: permissionId } });
  if (!existing) {
    throw new AppError('Permission not found', 404);
  }
  return prisma.permission.delete({ where: { id: permissionId } });
};

// --- MODULES ---
export const createModule = async (data: { name: string; code: string }) => {
  // Check code uniqueness
  const codeExists = await prisma.module.findUnique({ where: { code: data.code } });
  if (codeExists) {
    throw new AppError(`Module with code '${data.code}' already exists`, 409);
  }

  // Check name uniqueness (schema doesn't enforce it, but business logic does)
  const nameExists = await prisma.module.findFirst({ where: { name: data.name } });
  if (nameExists) {
    throw new AppError(`Module with name '${data.name}' already exists`, 409);
  }

  return prisma.module.create({ data });
};

export const getModules = async () => {
  return prisma.module.findMany({
    include: {
      permissions: true
    }
  });
};

export const updateModule = async (moduleId: string, data: { name?: string; code?: string }) => {
  const existing = await prisma.module.findUnique({ where: { id: moduleId } });
  if (!existing) {
    throw new AppError('Module not found', 404);
  }

  if (data.code && data.code !== existing.code) {
    const codeExists = await prisma.module.findUnique({ where: { code: data.code } });
    if (codeExists) {
      throw new AppError(`Module with code '${data.code}' already exists`, 409);
    }
  }

  if (data.name && data.name !== existing.name) {
    const nameExists = await prisma.module.findFirst({ where: { name: data.name } });
    if (nameExists) {
      throw new AppError(`Module with name '${data.name}' already exists`, 409);
    }
  }

  return prisma.module.update({
    where: { id: moduleId },
    data,
  });
};

export const deleteModule = async (moduleId: string) => {
  const existing = await prisma.module.findUnique({ 
    where: { id: moduleId },
    include: { _count: { select: { permissions: true } } }
  });

  if (!existing) {
    throw new AppError('Module not found', 404);
  }

  if (existing._count.permissions > 0) {
    throw new AppError(`Cannot delete module because it has ${existing._count.permissions} active permissions. Please delete them first.`, 400);
  }

  return prisma.module.delete({
    where: { id: moduleId },
  });
};

// --- CORE AUTH RESOLUTION ---

/**
 * Resolves all permissions for a user via:
 * User -> Groups -> Roles -> Permissions
 * + User -> PermissionOverride
 */
// Removed UserRole import as it is no longer used here or in schema
// import { UserRole } from '@prisma/client';

export const getUserPermissions = async (userId: string): Promise<{ permissions: string[] }> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      userGroups: {
        include: {
          group: {
            include: {
              roles: {
                include: {
                  role: {
                    include: {
                      permissions: {
                        include: { permission: true }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      permissionOverrides: {
        include: { permission: true }
      }
    }
  });

  if (!user) return { permissions: [] };

  const perms = new Set<string>();

  // 1. Collect from Groups -> Roles
  for (const ug of user.userGroups) {
    for (const gr of ug.group.roles) {
      for (const rp of gr.role.permissions) {
        perms.add(rp.permission.key);
      }
    }
  }

  // 2. Apply Overrides
  for (const po of user.permissionOverrides) {
    if (po.type === 'GRANT') {
      perms.add(po.permission.key);
    } else if (po.type === 'REVOKE') {
      perms.delete(po.permission.key);
    }
  }

  return { permissions: Array.from(perms) };
};

export const getUserModules = async (permissionKeys: string[]): Promise<string[]> => {
  if (permissionKeys.length === 0) return [];
  
  const modules = await prisma.module.findMany({
    where: {
      permissions: {
        some: {
          key: { in: permissionKeys }
        }
      }
    },
    select: { code: true }
  });

  return modules.map(m => m.code);
};
