import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import { authenticate as rbacAuthenticate } from '../middleware/rbac.middleware';

export const authenticate = rbacAuthenticate;

/**
 * @deprecated Legacy Role-Based Authorization. Use `authorizePermission` from `rbac.middleware.ts`.
 */
export const authorize = (roles: any[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        // Enforce migration to Permission-Based Access Control
        // Since we removed 'role' from req.user, this function cannot work as intended anyway.
        next(new AppError('Legacy Role-Based Authorization is deprecated and disabled. Please use "authorizePermission" with specific permission keys.', 500));
    };
};
