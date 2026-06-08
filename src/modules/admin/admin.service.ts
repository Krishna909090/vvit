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

        const onlineStudents = await prisma.student.count({ where: { isOffline: false } });
        const offlineStudents = await prisma.student.count({ where: { isOffline: true } });

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

    async addAdmin(data: { phone?: string; name?: string; email?: string; role?: any; password?: string; groupIds?: string[]; proNumber?: string }, currentUserId?: string) {
        const { phone, name, email, role, password, groupIds, proNumber } = data;

        if (!phone) {
            throw new AppError("Phone number is required", 400);
        }

        const normalizedPhone = phone.trim();
        const normalizedEmail = email?.trim().toLowerCase();

        if (role === 'PRO') {
            if (!proNumber) {
                throw new AppError('PRO Number is required when role is PRO', 400);
            }
            const pro = await prisma.pRO.findUnique({ where: { proNumber: String(proNumber).trim() } });
            if (!pro) {
                throw new AppError(`PRO with proNumber "${proNumber}" not found. Create the PRO record first.`, 404);
            }
            if (pro.userId) {
                throw new AppError(`PRO "${proNumber}" is already linked to another user account`, 409);
            }

            const existingUser = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
            if (existingUser) {
                const existingPro = await prisma.pRO.findUnique({ where: { userId: existingUser.id } });
                if (existingPro && existingPro.proNumber !== String(proNumber).trim()) {
                    throw new AppError(
                        `This phone number is already linked to PRO "${existingPro.proNumber}". Unlink first before assigning to "${proNumber}".`,
                        409
                    );
                }
            }
        }

        logger.info(
            `[addAdmin] request: phone=${maskPhone(normalizedPhone)}, email=${maskEmail(normalizedEmail)}, role=${role}`
        );

        let user = await prisma.user.findUnique({
            where: { phone: normalizedPhone },
        });

        const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;

        if (user) {

            if (role && user.role !== role) {
                logger.info(`[addAdmin] User exists. Updating role from ${user.role} to ${role}`);
            }

            user = await prisma.user.update({
                where: { id: user.id },
                data: {
                    name: name ?? user.name,
                    email: normalizedEmail ?? user.email,
                    password: passwordHash ?? user.password,
                    role: role ?? user.role,
                    updatedBy: currentUserId
                },
            });
        } else {

            logger.info(
                `[addAdmin] Creating new user with role=${role} and phone=${maskPhone(normalizedPhone)}`
            );

            user = await prisma.user.create({
                data: {
                    phone: normalizedPhone,
                    name,
                    email: normalizedEmail,
                    role: role || 'STAFF',
                    password: passwordHash,
                    createdBy: currentUserId,
                    updatedBy: currentUserId
                },
            });
        }

        if (user && groupIds && groupIds.length > 0) {
            logger.info(`[addAdmin] Assigning user=${user.id} to groups=${groupIds.join(', ')}`);
            const userGroupsData = groupIds.map(groupId => ({
                userId: user!.id,
                groupId
            }));

            for (const ug of userGroupsData) {
                try {

                    await prisma.userGroup.upsert({
                         where: {
                             userId_groupId: { userId: ug.userId, groupId: ug.groupId }
                         },
                         create: ug,
                         update: {}
                    });
                } catch (e) {
                     logger.error(`[addAdmin] Failed to assign group ${ug.groupId} to user ${user!.id}: ${e}`);
                }
            }
        }

        if (role === 'PRO' && proNumber) {
            const proNumberTrimmed = String(proNumber).trim();
            await prisma.pRO.update({
                where: { proNumber: proNumberTrimmed },
                data: {
                    userId: user.id,
                    name: name ?? undefined,
                    phone: normalizedPhone,
                    email: normalizedEmail ?? undefined,
                    updatedBy: currentUserId
                }
            });
            logger.info(`[addAdmin] Linked User ${user.id} to PRO ${proNumberTrimmed}`);
        }

        logger.info(
            `[addAdmin] Admin user persisted successfully: id=${user.id}, role=${user.role}, phone=${maskPhone(user.phone)}, email=${maskEmail(user.email)}`
        );

        const { password: _pw, ...safeUser } = user as any;
        return safeUser;
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
            select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                role: true,
                createdAt: true,
                updatedAt: true
            }
        });

        if (!user) {
            throw new AppError(MESSAGES.ERROR.USER_NOT_FOUND, 404);
        }

        return user;
    },

    async getStaffUsers(filters?: { role?: RoleType; search?: string }) {
        const where: any = {
            role: {
                not: Role.STUDENT
            }
        };

        if (filters?.role) {
            where.role = filters.role;
        }

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
                isDeleted: true,
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
            userGroups: undefined
        }));
    },

    async updateStaffUser(userId: string, data: { name?: string; email?: string; role?: RoleType, isDeleted?: boolean }, currentUserId?: string) {
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
            throw new AppError('Cannot update student users through this API', 400);
        }

        if (data.role) {

            if (data.role == Role.STUDENT) {
                 throw new AppError('Cannot set user role to STUDENT via this API', 400);
            }

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

        if (data.isDeleted !== undefined) {
            updateData.isDeleted = data.isDeleted;
        }

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                phone: true,
                name: true,
                email: true,
                role: true,
                isDeleted: true,
                createdAt: true,
                updatedAt: true
            }
        });

        logger.info(`[updateStaffUser] Updated user id=${userId} by=${currentUserId}`);
        return updatedUser;
    },

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

    async updateAgentCommissionStatus(commissionId: string, status: AgentCommissionStatus, userId: string) {
        return prisma.agentCommission.update({
            where: { id: commissionId },
            data: { status, updatedBy: userId }
        });
    },

    async assignUserRoleAndGroups(data: { userId: string, role?: string, groupIds?: string[] }, executedBy?: string) {
        const { userId, role, groupIds } = data;

        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new AppError('User not found', 404);

        if (role === Role.SUPER_ADMIN) {
            let executorRole: string | undefined;
            if (executedBy && executedBy !== 'ADMIN') {
                const executor = await prisma.user.findUnique({ where: { id: executedBy }, select: { role: true } });
                executorRole = executor?.role ?? undefined;
            }
            if (executorRole !== Role.SUPER_ADMIN) {
                throw new AppError('Only SUPER_ADMIN can assign SUPER_ADMIN role', 403);
            }
        }

        const updateData: any = { updatedBy: executedBy };
        if (role) {
            updateData.role = role;
        }

        return await prisma.$transaction(async (tx) => {

            let updatedUser = user;
            if (role && role !== user.role) {
                updatedUser = await tx.user.update({
                    where: { id: userId },
                    data: updateData
                });
                logger.info(`[assignUserRoleAndGroups] User ${userId} role updated to ${role} by ${executedBy}`);
            }

            if (groupIds) {

                const groups = await tx.group.findMany({
                    where: { id: { in: groupIds } }
                });
                if (groups.length !== groupIds.length) {
                    throw new AppError('One or more Group IDs are invalid', 400);
                }

                await tx.userGroup.deleteMany({
                    where: { userId }
                });

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
    },

    async updateFullStaffDetails(data: { userId: string, name?: string, email?: string, phone?: string, role?: string, groupIds?: string[], isDeleted?: boolean }, executedBy?: string) {
        const { userId, name, email, phone, role, groupIds, isDeleted } = data;

        const user = await prisma.user.findUnique({ 
            where: { id: userId },
            include: { userGroups: true }
        });
        
        if (!user) throw new AppError('User not found', 404);

        if (user.role === Role.STUDENT) {
             throw new AppError('Cannot update student users via this API', 400);
        }

        const updateData: any = { updatedBy: executedBy };
        if (name) updateData.name = name.trim();
        if (email) updateData.email = email.trim().toLowerCase();
        if (phone) updateData.phone = phone.trim();
        if (role) {
            if (role === Role.STUDENT) throw new AppError('Cannot set role to STUDENT', 400);
            updateData.role = role;
        }
        if (isDeleted !== undefined) {
            updateData.isDeleted = isDeleted;
        }

        return await prisma.$transaction(async (tx) => {

            const updatedUser = await tx.user.update({
                where: { id: userId },
                data: updateData,
                select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true,
                    role: true,
                    isDeleted: true
                }
            });

            let finalGroups = user.userGroups;
            if (groupIds) {

                 const groups = await tx.group.findMany({ where: { id: { in: groupIds } } });
                 if (groups.length !== groupIds.length) {
                     throw new AppError('Invalid Group IDs provided', 400);
                 }

                 await tx.userGroup.deleteMany({ where: { userId } });

                 if (groupIds.length > 0) {
                     await tx.userGroup.createMany({
                         data: groupIds.map(gid => ({ userId, groupId: gid }))
                     });
                 }
                 
                 finalGroups = await tx.userGroup.findMany({ where: { userId }, include: { group: true } });
            }

            logger.info(`[updateFullStaffDetails] User ${userId} updated by ${executedBy}`);

            return {
                ...updatedUser,
                groups: finalGroups.map((ug: any) => ({
                    id: ug.groupId,
                    name: ug.group?.name
                }))
            };
        });
    }
};
