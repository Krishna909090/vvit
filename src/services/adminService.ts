import prisma from '../config/prisma';
import logger from '../utils/logger';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';
import { FeeStatus, Role } from '@prisma/client';
import { maskPhone, maskEmail } from "../utils/mask";

export const AdminService = {

    async getDashboardStats() {
        const totalApplications = await prisma.student.count();
        const paidApplications = await prisma.studentAdmission.count({ where: { feeStatus: FeeStatus.FULL } });
        const pendingPayment = await prisma.studentAdmission.count({ where: { feeStatus: { not: FeeStatus.FULL } } });

        // Online vs Offline
        const onlineStudents = await prisma.student.count({ where: { isOffline: false } });
        const offlineStudents = await prisma.student.count({ where: { isOffline: true } });

        // Last 7 days summary
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const recentApplications = await prisma.student.findMany({
            where: {
                createdAt: {
                    gte: sevenDaysAgo
                }
            },
            select: {
                createdAt: true
            }
        });

        const dayWiseSummary: Record<string, number> = {};
        // Initialize last 7 days with 0
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            dayWiseSummary[dateStr] = 0;
        }

        recentApplications.forEach((app: any) => {
            const dateStr = app.createdAt.toISOString().split('T')[0];
            if (dayWiseSummary[dateStr] !== undefined) {
                dayWiseSummary[dateStr]++;
            }
        });

        const summaryArray = Object.entries(dayWiseSummary).map(([date, count]) => ({ date, count }));

        return {
            totalApplications,
            paidApplications,
            pendingPayment,
            onlineStudents,
            offlineStudents,
            dayWiseSummary: summaryArray
        };
    },

    async addAdmin(data: { phone?: string; name?: string; email?: string; role?: Role; }, currentUserId?: string) {
        const { phone, name, email, role } = data;

        if (!phone) {
            throw new AppError("Phone number is required", 400);
        }

        if (!role) {
            throw new AppError("Role is required", 400);
        }

        const allowedRoles: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.STAFF, Role.INVIGILATOR];
        if (!allowedRoles.includes(role)) {
            logger.warn(
                `[addAdmin] invalid role assignment attempt: role=${role}, phone=${maskPhone(phone)}, by=${currentUserId}`
            );
            throw new AppError("Invalid role for admin creation", 400);
        }

        const normalizedPhone = phone.trim();
        const normalizedEmail = email?.trim().toLowerCase();

        logger.info(
            `[addAdmin] request: phone=${maskPhone(normalizedPhone)}, email=${maskEmail(normalizedEmail)}, role=${role}`
        );

        let user = await prisma.user.findUnique({
            where: { phone: normalizedPhone },
        });

        if (user) {
            if (user.role !== role) {
                logger.warn(
                    `[addAdmin] role conflict for userId=${user.id}. Existing role=${user.role}, requested role=${role}`
                );
                throw new AppError(
                    `User already exists with role ${user.role}. Cannot change role to ${role}.`,
                    400
                );
            }

            logger.info(
                `[addAdmin] User found with phone=${maskPhone(normalizedPhone)}, same role=${role}. Updating basic details.`
            );

            user = await prisma.user.update({
                where: { id: user.id },
                data: {
                    name: name ?? user.name,
                    email: normalizedEmail ?? user.email,
                },
            });
        } else {
            if (role === Role.SUPER_ADMIN) {
                const existingSuperAdmin = await prisma.user.findFirst({
                    where: { role: Role.SUPER_ADMIN },
                });

                if (existingSuperAdmin) {
                    logger.warn(
                        `[addAdmin] SUPER_ADMIN already exists: id=${existingSuperAdmin.id}, phone=${maskPhone(existingSuperAdmin.phone)}`
                    );
                    throw new AppError(
                        "A SUPER_ADMIN already exists. Cannot create another SUPER_ADMIN.",
                        400
                    );
                }
            }

            logger.info(
                `[addAdmin] Creating new user with role=${role} and phone=${maskPhone(normalizedPhone)}`
            );

            user = await prisma.user.create({
                data: {
                    phone: normalizedPhone,
                    name,
                    email: normalizedEmail,
                    role,
                },
            });
        }

        logger.info(
            `[addAdmin] Admin user persisted successfully: id=${user.id}, role=${user.role}, phone=${maskPhone(user.phone)}, email=${maskEmail(user.email)}`
        );

        return user;
    },

    async getAgentCommissions(agentId?: string) {
        const where: any = {};
        if (agentId) where.agentId = String(agentId);

        const commissions = await prisma.agentCommission.findMany({
            where,
            include: { agent: true, student: true }
        });
        return commissions;
    },

    async getUserDetails(phone?: string, email?: string) {
        if (!phone && !email) {
            throw new AppError(MESSAGES.ERROR.INVALID_REQUEST, 400);
        }

        const searchConditions = [];
        if (phone) searchConditions.push({ phone: String(phone) });
        if (email) searchConditions.push({ email: String(email) });

        const user = await prisma.user.findFirst({
            where: {
                OR: searchConditions
            },
            include: {
                agentStudents: { select: { id: true, name: true, applicationId: true } }
            }
        });

        if (!user) {
            throw new AppError(MESSAGES.ERROR.USER_NOT_FOUND, 404);
        }

        return user;
    },

    /**
     * Get all staff users (excluding students)
     * Supports filtering by role and search term
     */
    async getStaffUsers(filters?: { role?: Role; search?: string }) {
        const where: any = {
            role: {
                not: Role.STUDENT // Exclude students
            }
        };

        // Filter by specific role if provided
        if (filters?.role) {
            where.role = filters.role;
        }

        // Search by name, phone, or email
        if (filters?.search) {
            const searchTerm = filters.search.trim();
            where.OR = [
                { name: { contains: searchTerm, mode: 'insensitive' } },
                { phone: { contains: searchTerm } },
                { email: { contains: searchTerm, mode: 'insensitive' } }
            ];
        }

        const users = await prisma.user.findMany({
            where,
            select: {
                id: true,
                phone: true,
                name: true,
                email: true,
                role: true,
                createdAt: true,
                updatedAt: true
            },
            orderBy: [
                { role: 'asc' },
                { createdAt: 'desc' }
            ]
        });

        logger.info(`[getStaffUsers] Found ${users.length} staff users`);
        return users;
    },

    /**
     * Update staff user details
     * Can update name, email, and role (excluding STUDENT role)
     */
    async updateStaffUser(userId: string, data: { name?: string; email?: string; role?: Role }, currentUserId?: string) {
        if (!userId) {
            throw new AppError('User ID is required', 400);
        }

        // Find the user
        const user = await prisma.user.findUnique({
            where: { id: userId }
        });

        if (!user) {
            throw new AppError('User not found', 404);
        }

        // Cannot update STUDENT role users through this API
        if (user.role === Role.STUDENT) {
            throw new AppError('Cannot update student users through this API', 400);
        }

        // Validate role if being updated
        if (data.role) {
            const allowedRoles: Role[] = [Role.ADMIN, Role.SUPER_ADMIN, Role.STAFF, Role.INVIGILATOR, Role.AGENT];
            if (!allowedRoles.includes(data.role)) {
                throw new AppError('Invalid role for staff user', 400);
            }

            // Prevent changing SUPER_ADMIN role if another SUPER_ADMIN exists
            if (data.role === Role.SUPER_ADMIN && user.role !== Role.SUPER_ADMIN) {
                const existingSuperAdmin = await prisma.user.findFirst({
                    where: { 
                        role: Role.SUPER_ADMIN,
                        id: { not: userId }
                    }
                });

                if (existingSuperAdmin) {
                    throw new AppError('A SUPER_ADMIN already exists. Cannot create another SUPER_ADMIN.', 400);
                }
            }
        }

        // Prepare update data
        const updateData: any = {};
        
        if (data.name !== undefined) {
            updateData.name = data.name.trim();
        }

        if (data.email !== undefined) {
            updateData.email = data.email.trim().toLowerCase();
        }

        if (data.role !== undefined) {
            updateData.role = data.role;
        }

        // Update user
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                phone: true,
                name: true,
                email: true,
                role: true,
                createdAt: true,
                updatedAt: true
            }
        });

        logger.info(`[updateStaffUser] Updated user id=${userId} by=${currentUserId}`);
        return updatedUser;
    }
};
