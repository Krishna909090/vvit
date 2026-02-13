import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import { FeeStatus, AgentCommissionStatus } from '@prisma/client';
import { Role, RoleType } from '../../constants/roles';
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

    async addAdmin(data: { phone?: string; name?: string; email?: string; role?: any; password?: string; groupIds?: string[] }, currentUserId?: string) {
        const { phone, name, email, role, password, groupIds } = data;

        if (!phone) {
            throw new AppError("Phone number is required", 400);
        }

        const normalizedPhone = phone.trim();
        const normalizedEmail = email?.trim().toLowerCase();

        logger.info(
            `[addAdmin] request: phone=${maskPhone(normalizedPhone)}, email=${maskEmail(normalizedEmail)}, role=${role}`
        );

        let user = await prisma.user.findUnique({
            where: { phone: normalizedPhone },
        });

        const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;

        if (user) {
            // Logic Relaxed: Update role if different, don't throw conflict.
            if (role && user.role !== role) {
                logger.info(`[addAdmin] User exists. Updating role from ${user.role} to ${role}`);
            }

            user = await prisma.user.update({
                where: { id: user.id },
                data: {
                    name: name ?? user.name,
                    email: normalizedEmail ?? user.email,
                    password: passwordHash ?? user.password,
                    role: role ?? user.role, // Update role if provided
                    updatedBy: currentUserId
                },
            });
        } else {
            // Logic Relaxed: Removed Super Admin uniqueness check and Student restrictions.
            logger.info(
                `[addAdmin] Creating new user with role=${role} and phone=${maskPhone(normalizedPhone)}`
            );

            user = await prisma.user.create({
                data: {
                    phone: normalizedPhone,
                    name,
                    email: normalizedEmail,
                    role: role || 'STAFF', // Default if missing, or use payload // Ensure this matches Schema Enum if strict
                    password: passwordHash,
                    createdBy: currentUserId,
                    updatedBy: currentUserId
                },
            });
        }

        // Explicit Group Assignment via Payload (The Priority)
        if (user && groupIds && groupIds.length > 0) {
            logger.info(`[addAdmin] Assigning user=${user.id} to groups=${groupIds.join(', ')}`);
            const userGroupsData = groupIds.map(groupId => ({
                userId: user!.id,
                groupId
            }));
            
            // Assign groups properly
            for (const ug of userGroupsData) {
                try {
                    // Using Upsert or Create based on schema constraints (usually composite userId+groupId)
                    await prisma.userGroup.upsert({
                         where: {
                             userId_groupId: { userId: ug.userId, groupId: ug.groupId }
                         },
                         create: ug,
                         update: {} // No-op if exists
                    });
                } catch (e) {
                     logger.error(`[addAdmin] Failed to assign group ${ug.groupId} to user ${user!.id}: ${e}`);
                }
            }
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
    async getStaffUsers(filters?: { role?: RoleType; search?: string }) {
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
                updatedAt: true,
                userGroups: {
                    select: {
                        group: {
                            select: {
                                id: true,
                                name: true
                            }
                        }
                    }
                }
            },
            orderBy: [
                { role: 'asc' },
                { createdAt: 'desc' }
            ]
        });

        logger.info(`[getStaffUsers] Found ${users.length} staff users`);

        return users.map((u: any) => ({
            ...u,
            groups: u.userGroups.map((ug: any) => ({
                id: ug.group.id,
                name: ug.group.name
            })),
            userGroups: undefined // Remove the nested prisma structure
        }));
    },

    /**
     * Update staff user details
     * Can update name, email, and role (excluding STUDENT role)
     */
    async updateStaffUser(userId: string, data: { name?: string; email?: string; role?: RoleType }, currentUserId?: string) {
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
            // Allow any role EXCEPT Student
            if (data.role == Role.STUDENT) { // matching check roughly, Role enum is string usually
                 throw new AppError('Cannot set user role to STUDENT via this API', 400);
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

        // SYNC GROUP REMOVED - Groups must be managed explicitly via RBAC APIs
        /*
        if (data.role) {
             // ... Logic removed to support manual assignment workflow
        }
        */



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

        if (user.role === Role.STUDENT) {
            throw new AppError('Cannot delete student users through this API', 400);
        }

        if (user.role === Role.SUPER_ADMIN) {
             throw new AppError('Cannot delete SUPER_ADMIN user', 403);
        }

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
    },
    
    // Assign Role and Groups
    async assignUserRoleAndGroups(data: { userId: string, role?: string, groupIds?: string[] }, executedBy?: string) {
        const { userId, role, groupIds } = data;
        
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new AppError('User not found', 404);

        // Security Check: Cannot modify Super Admin unless executed by a Super Admin (though permission middleware usually handles this)
        if (user.role === Role.SUPER_ADMIN) {
             // Optional: strict check
             // if (executedByRole !== Role.SUPER_ADMIN) throw new AppError('Cannot modify Super Admin', 403);
        }

        const updateData: any = { updatedBy: executedBy };
        if (role) {
            updateData.role = role;
        }

        return await prisma.$transaction(async (tx) => {
            // 1. Update User Role
            let updatedUser = user;
            if (role && role !== user.role) {
                updatedUser = await tx.user.update({
                    where: { id: userId },
                    data: updateData
                });
                logger.info(`[assignUserRoleAndGroups] User ${userId} role updated to ${role} by ${executedBy}`);
            }

            // 2. Update Groups (Replace Strategy)
            if (groupIds) {
                // Verify all groups exist
                const groups = await tx.group.findMany({
                    where: { id: { in: groupIds } }
                });
                if (groups.length !== groupIds.length) {
                    throw new AppError('One or more Group IDs are invalid', 400);
                }

                // Delete existing mappings
                await tx.userGroup.deleteMany({
                    where: { userId }
                });

                // Create new mappings
                if (groupIds.length > 0) {
                    await tx.userGroup.createMany({
                        data: groupIds.map(gid => ({
                            userId,
                            groupId: gid
                        }))
                    });
                }
                logger.info(`[assignUserRoleAndGroups] User ${userId} assigned to groups [${groupIds.join(', ')}] by ${executedBy}`);
            }

            return { user: updatedUser, groupIds };
        });
    }
};
