import { Request, Response, NextFunction } from 'express';
import * as rbacService from './services/rbac.service';

// --- GROUPS ---
export const createGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await rbacService.createGroup(req.body);
    res.status(201).json({ success: true, data: group });
  } catch (error) {
    next(error);
  }
};

export const getGroups = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groups = await rbacService.getGroups();
    res.status(200).json({ success: true, data: groups });
  } catch (error) {
    next(error);
  }
};

export const updateGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { groupId } = req.params;
    const group = await rbacService.updateGroup(groupId, req.body);
    res.status(200).json({ success: true, data: group });
  } catch (error) {
    next(error);
  }
};

export const deleteGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { groupId } = req.params;
    await rbacService.deleteGroup(groupId);
    res.status(200).json({ success: true, message: 'Group deleted successfully' });
  } catch (error) {
    next(error);
  }
};

export const assignRolesToGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { groupId } = req.params;
    const { roleIds } = req.body;
    await rbacService.assignRolesToGroup(groupId, roleIds);
    res.status(200).json({ success: true, message: 'Roles assigned to group successfully' });
  } catch (error) {
    next(error);
  }
};

export const assignUsersToGroup = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { groupId } = req.params;
    const { userIds } = req.body;
    await rbacService.assignUsersToGroup(groupId, userIds);
    res.status(200).json({ success: true, message: 'Users assigned to group successfully' });
  } catch (error) {
    next(error);
  }
};

// --- ROLES ---
export const createRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const role = await rbacService.createRole(req.body);
    res.status(201).json({ success: true, data: role });
  } catch (error) {
    next(error);
  }
};

export const getRoles = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roles = await rbacService.getRoles();
    res.status(200).json({ success: true, data: roles });
  } catch (error) {
    next(error);
  }
};

export const updateRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { roleId } = req.params;
    const role = await rbacService.updateRole(roleId, req.body);
    res.status(200).json({ success: true, data: role });
  } catch (error) {
    next(error);
  }
};

export const deleteRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { roleId } = req.params;
    await rbacService.deleteRole(roleId);
    res.status(200).json({ success: true, message: 'Role deleted successfully' });
  } catch (error) {
    next(error);
  }
};

export const assignPermissionsToRole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { roleId } = req.params;
    const { permissionKeys } = req.body; // Expecting keys (e.g. ['hostel.read'])
    await rbacService.assignPermissionsToRole(roleId, permissionKeys);
    res.status(200).json({ success: true, message: 'Permissions assigned to role successfully' });
  } catch (error) {
    next(error);
  }
};

// --- PERMISSIONS ---
export const createPermission = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const permission = await rbacService.createPermission(req.body);
    res.status(201).json({ success: true, data: permission });
  } catch (error) {
    next(error);
  }
};

export const getPermissions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const permissions = await rbacService.getPermissions();
    res.status(200).json({ success: true, data: permissions });
  } catch (error) {
    next(error);
  }
};

export const updatePermission = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { permissionId } = req.params;
    const permission = await rbacService.updatePermission(permissionId, req.body);
    res.status(200).json({ success: true, data: permission });
  } catch (error) {
    next(error);
  }
};

export const deletePermission = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { permissionId } = req.params;
    await rbacService.deletePermission(permissionId);
    res.status(200).json({ success: true, message: 'Permission deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// --- MODULES ---
export const createModule = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const module = await rbacService.createModule(req.body);
    res.status(201).json({ success: true, data: module });
  } catch (error) {
    next(error);
  }
};

export const getModules = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const modules = await rbacService.getModules();
    res.status(200).json({ success: true, data: modules });
  } catch (error) {
    next(error);
  }
};

export const updateModule = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { moduleId } = req.params;
    const module = await rbacService.updateModule(moduleId, req.body);
    res.status(200).json({ success: true, data: module });
  } catch (error) {
    next(error);
  }
};

export const deleteModule = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { moduleId } = req.params;
    await rbacService.deleteModule(moduleId);
    res.status(200).json({ success: true, message: 'Module deleted successfully' });
  } catch (error) {
    next(error);
  }
};
