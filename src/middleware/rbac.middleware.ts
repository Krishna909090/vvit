import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserPermissions } from '../modules/rbac/services/rbac.service';
import { AppError } from '../utils/AppError';
import logger from '../utils/logger';
import { RoleType } from '../constants/roles';
import { setContextUser } from '../utils/requestContext';
import { isTokenBlacklisted } from '../modules/auth/auth.service';

// In-memory permission cache: userId -> { permissions, expiresAt }
const permissionCache = new Map<string, { permissions: string[], expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const getCachedPermissions = async (userId: string): Promise<string[]> => {
    const cached = permissionCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.permissions;
    }

    const { permissions } = await getUserPermissions(userId);
    permissionCache.set(userId, { permissions, expiresAt: Date.now() + CACHE_TTL_MS });

    // Evict stale entries periodically (keep cache bounded)
    if (permissionCache.size > 5000) {
        const now = Date.now();
        for (const [key, val] of permissionCache) {
            if (val.expiresAt < now) permissionCache.delete(key);
        }
    }

    return permissions;
};

// Call this when permissions change (role update, group change)
export const invalidatePermissionCache = (userId?: string) => {
    if (userId) {
        permissionCache.delete(userId);
    } else {
        permissionCache.clear();
    }
};

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new AppError('Authentication required', 401);
        }

        const token = authHeader.split(' ')[1];

        if (isTokenBlacklisted(token)) {
            throw new AppError('Token has been revoked', 401);
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string, role: RoleType };

        setContextUser(decoded.userId);

        const permissions = await getCachedPermissions(decoded.userId);

        req.user = {
            userId: decoded.userId,
            role: decoded.role,
            permissions
        };

        next();
    } catch (error) {
        next(new AppError('Invalid or expired token', 401));
    }
};

export const authorizePermission = (requiredPermission: string | string[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user) {
            return next(new AppError('User not authenticated', 401));
        }

        const userPermissions = req.user.permissions || [];
        let hasPermission = false;

        if (Array.isArray(requiredPermission)) {
            hasPermission = requiredPermission.some(p => userPermissions.includes(p));
        } else {
            hasPermission = userPermissions.includes(requiredPermission);
        }

        if (!hasPermission) {
            logger.warn(`[RBAC] Permission DENIED for user=${req.user.userId} required=${JSON.stringify(requiredPermission)}`);
            return next(new AppError(`Permission denied`, 403));
        }

        next();
    };
};
