import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import { FeeStatus, UserRole, AgentCommissionStatus } from '@prisma/client';
import { maskPhone, maskEmail } from '../../utils/mask';
import bcrypt from 'bcryptjs';

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

    async addAdmin(data: { phone?: string; name?: string; email?: string; groupIds?: string[]; password?: string }, currentUserId?: string) {
        const { phone, name, email, groupIds, password } = data;

        if (!phone) {
            throw new AppError("Phone number is required", 400);
        }

        // ⚠️ Strict RBAC: We require Groups, not Roles.
        if (!groupIds || groupIds.length === 0) {
            throw new AppError("At least one Group ID is required to assign access", 400);
        }

        const normalizedPhone = phone.trim();
        const normalizedEmail = email?.trim().toLowerCase();

        logger.info(
            `[addAdmin] request: phone=${maskPhone(normalizedPhone)}, email=${maskEmail(normalizedEmail)}, groups=${groupIds.length}`
        );

        let user = await prisma.user.findUnique({
            where: { phone: normalizedPhone },
        });

        const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;

        if (user) {
            // Update existing user
            user = await prisma.user.update({
                where: { id: user.id },
                data: {
                    name: name ?? user.name,
                    email: normalizedEmail ?? user.email,
                    password: passwordHash ?? user.password
                },
            });
        } else {
            // Create new user
            // We default strict 'role' field to STAFF just to satisfy DB constraint. 
            // Real auth comes from the Group we assign below.
            user = await prisma.user.create({
                data: {
                    phone: normalizedPhone,
                    name,
                    email: normalizedEmail,
                    role: UserRole.STAFF, // Legacy default
                    password: passwordHash
                },
            });
        }

        // --- RBAC ASSIGNMENT ---
        // Strictly add user to the requested Groups.
        if (groupIds && groupIds.length > 0) {
            const groupData = groupIds.map(gid => ({
                userId: user.id,
                groupId: gid
            }));

            await prisma.userGroup.createMany({
                data: groupData,
                skipDuplicates: true
            });
            logger.info(`[addAdmin] Assigned user ${user.id} to ${groupIds.length} groups.`);
        }

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
    async getStaffUsers(filters?: { role?: UserRole; search?: string }) {
        const where: any = {
            role: {
                not: UserRole.STUDENT // Exclude students
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
    async updateStaffUserGroups(userId: string, groupIds: string[]) {
        if (!userId) {
            throw new AppError('User ID is required', 400);
        }

        // 1. Validate User
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new AppError('User not found', 404);

        if (groupIds.length === 0) {
             // Optional: Decide if clearing all groups is allowed. Usually yes.
             // throw new AppError('At least one group is required', 400);
        }

        // 2. Transaction: Delete old -> Create new
        await prisma.$transaction([
            prisma.userGroup.deleteMany({ where: { userId } }),
            prisma.userGroup.createMany({
                data: groupIds.map(gid => ({ userId, groupId: gid }))
            })
        ]);

        logger.info(`[updateStaffUserGroups] Updated groups for userId=${userId} to count=${groupIds.length}`);
    },

    /**
     * Update staff user details
     * Can update name, email, (role is deprecated for access control but kept for DB constraint)
     */
    async updateStaffUser(userId: string, data: { name?: string; email?: string; groupIds?: string[] }, currentUserId?: string) {
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

        // Prepare update data
        const updateData: any = {};
        
        if (data.name !== undefined) {
            updateData.name = data.name.trim();
        }

        if (data.email !== undefined) {
            updateData.email = data.email.trim().toLowerCase();
        }

        // Update user basic details
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                phone: true,
                name: true,
                email: true,
                role: true, // Legacy field
                createdAt: true,
                updatedAt: true
            }
        });

        // Update Groups if provided
        if (data.groupIds) {
            await this.updateStaffUserGroups(userId, data.groupIds);
        }

        logger.info(`[updateStaffUser] Updated user id=${userId} by=${currentUserId}`);
        return updatedUser;
    },

    /**
     * Delete (soft delete) staff user
     */
    async deleteStaffUser(userId: string, currentUserId?: string) {
        if (!userId) {
            throw new AppError('User ID is required', 400);
        }

        const user = await prisma.user.findUnique({
            where: { id: userId }
        });

        if (!user) {
            throw new AppError('User not found', 404);
        }
        
        if (userId === currentUserId) {
             throw new AppError('Cannot delete yourself', 400);
        }
        
        // if (user.role === UserRole.SUPER_ADMIN) {
        //      throw new AppError('Cannot delete SUPER_ADMIN user', 403);
        // }

        await prisma.user.update({
            where: { id: userId },
            data: { 
                isDeleted: true,
                updatedBy: currentUserId 
            }
        });

        logger.info(`[deleteStaffUser] Soft deleted user id=${userId} by=${currentUserId}`);
    },

    // System Settings
    async getSystemSettings() {
        return prisma.systemSetting.findMany();
    },

    async updateSystemSetting(key: string, value: string, userId: string) {
        return prisma.systemSetting.upsert({
            where: { key },
            update: { value, updatedBy: userId },
            create: { key, value, updatedBy: userId }
        });
    },

    // Agent Commission
    async updateAgentCommissionStatus(commissionId: string, status: AgentCommissionStatus, userId: string) {
        return prisma.agentCommission.update({
            where: { id: commissionId },
            data: { status, updatedBy: userId }
        });
    }
};
