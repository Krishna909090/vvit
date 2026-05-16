import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role, RoleType } from '../constants/roles';
import logger from '../utils/logger';
import { AppError } from '../utils/AppError';
import { setContextUser } from '../utils/requestContext';

// JWT_SECRET is validated on startup by envValidator - no fallback needed
const JWT_SECRET = process.env.JWT_SECRET!;


export const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return next(new AppError('No token provided', 401));
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; role: RoleType };
        req.user = decoded;
        setContextUser(decoded.userId);
        next();
    } catch (error) {
        logger.error(`Authentication failed: ${error}`);
        return next(new AppError('Invalid token', 401));
    }
};

export const authorize = (roles: (RoleType | string)[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        logger.info(req.user)
        if (!req.user || !roles.includes(req.user.role)) {
            return next(new AppError('Forbidden: Insufficient permissions', 403));
        }
        next();
    };
};
