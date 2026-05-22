import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserPermissions } from '../modules/rbac/rbac.service';
import { AppError } from '../utils/AppError';
import logger from '../utils/logger';
import { RoleType } from '../constants/roles';
import { setContextUser } from '../utils/requestContext';
import { isTokenBlacklisted } from '../modules/auth/auth.service';
import prisma from '../config/prisma';

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

        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string, role: RoleType, tokenVersion?: number };

        // If the token carries a tokenVersion, it must match the current value on User.
        // Tokens issued before tokenVersion was introduced (no claim) are accepted for
        // backward compatibility — they'll naturally rotate as users re-authenticate.
        if (typeof decoded.tokenVersion === 'number') {
            const user = await prisma.user.findUnique({
                where: { id: decoded.userId },
                select: { tokenVersion: true, isDeleted: true },
            });
            if (!user || user.isDeleted) {
                throw new AppError('Account is no longer active', 401);
            }
            if (user.tokenVersion !== decoded.tokenVersion) {
                throw new AppError('Token has been revoked', 401);
            }
        }

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
            const required = Array.isArray(requiredPermission) ? requiredPermission.join(', ') : requiredPermission;
            return next(new AppError(`Permission denied. Required: ${required}`, 403));
        }

        next();
    };
};

/**
 * Permission required to override system-computed accommodation/transport pricing
 * with a custom admin-entered amount (customPricing / customCost on the
 * assign / reassign / switch flows).
 */
export const PRICING_OVERRIDE_PERMISSION = 'student.pricing.override';

/**
 * Conditional guard for custom-pricing overrides. Call from a controller AFTER the
 * normal `authorizePermission` route guard has run. Only enforces the extra
 * permission when the admin actually supplied an override — plain config-priced
 * calls are unaffected. Throws 403 if the override is present but the user lacks
 * `student.pricing.override`.
 */
export const assertPricingOverrideAllowed = (req: Request, hasOverride: boolean): void => {
    if (!hasOverride) return;
    const userPermissions = req.user?.permissions || [];
    if (!userPermissions.includes(PRICING_OVERRIDE_PERMISSION)) {
        logger.warn(`[RBAC] Pricing override DENIED for user=${req.user?.userId} required=${PRICING_OVERRIDE_PERMISSION}`);
        throw new AppError(`Permission denied. Custom pricing requires: ${PRICING_OVERRIDE_PERMISSION}`, 403);
    }
};
