import { RoleType } from '../constants/roles';

declare global {
    namespace Express {
        interface Request {
            user?: {
                userId: string;
                role: RoleType;
                permissions?: string[];
            };
        }
    }
}
