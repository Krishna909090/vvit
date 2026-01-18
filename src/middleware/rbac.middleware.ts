import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserPermissions } from '../modules/rbac/services/rbac.service';
import { AppError } from '../utils/AppError';
import logger from '../utils/logger';
import { RoleType } from '../constants/roles';



export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
       throw new AppError('Authentication required', 401);
    }

    const token = authHeader.split(' ')[1];
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string, role: RoleType };
    
    // Resolve permissions here for efficiency and attach to request
    // This makes 'authorizePermission' very fast (sync check)
    const { permissions } = await getUserPermissions(decoded.userId);
    
    logger.info(`[RBAC Debug] Authenticated User: ${decoded.userId}`);
    logger.info(`[RBAC Debug] User Permissions Count: ${permissions.length}`);
    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      permissions
    };
    
    next();
  } catch (error) {
    logger.error(`[RBAC Debug] Auth Error:`, error);
    next(new AppError('Invalid or expired token', 401));
  }
};

export const authorizePermission = (requiredPermission: string | string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      logger.warn(`[RBAC Debug] User not found in request`);
      return next(new AppError('User not authenticated', 401));
    }

    const userPermissions = req.user.permissions || [];
    let hasPermission = false;

    logger.info(`[RBAC Debug] Checking Required Permission: ${JSON.stringify(requiredPermission)}`);

    if (Array.isArray(requiredPermission)) {
      hasPermission = requiredPermission.some(p => userPermissions.includes(p));
    } else {
      hasPermission = userPermissions.includes(requiredPermission);
    }

    if (!hasPermission) {
      logger.warn(`[RBAC Debug] Permission DENIED. User has: ${userPermissions.slice(0, 10)}... (truncated)`);
      return next(new AppError(`Permission denied. Required: ${Array.isArray(requiredPermission) ? requiredPermission.join(' OR ') : requiredPermission}`, 403));
    }
    
    logger.info(`[RBAC Debug] Permission GRANTED.`);
    next();
  };
};
