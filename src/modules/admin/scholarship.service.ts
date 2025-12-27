import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { ScholarshipStatus } from '@prisma/client';

export const ScholarshipService = {
    async createRule(data: any, createdBy: string) {
        const { name, minPercentile, discountPercentage, totalSlots } = data;
        
        return await prisma.scholarshipRule.create({
            data: {
                name,
                minPercentile: Number(minPercentile),
                discountPercentage: Number(discountPercentage),
                totalSlots: Number(totalSlots),
                filledSlots: 0,
                isActive: true
            }
        });
    },

    async getAllRules() {
        return await prisma.scholarshipRule.findMany({
            where: { isActive: true },
            orderBy: { minPercentile: 'desc' }
        });
    },

    async checkEligibilityAndAllocate(studentId: string, examScore: number) {
        logger.info(`Checking scholarship eligibility for student ${studentId} with score ${examScore}`);

        // 1. Find best applicable rule
        // Rules ordered by highest percentile first
        const rules = await prisma.scholarshipRule.findMany({
            where: { 
                isActive: true,
                minPercentile: { lte: examScore }
            },
            orderBy: { minPercentile: 'desc' }
        });

        if (rules.length === 0) {
            logger.info(`No scholarship rules match score ${examScore}`);
            return null;
        }

        // 2. Iterate to find one with slots
        let selectedRule = null;
        for (const rule of rules) {
            if (rule.filledSlots < rule.totalSlots) {
                selectedRule = rule;
                break;
            }
        }

        if (!selectedRule) {
            logger.warn(`Matched rules founded but all slots full for score ${examScore}`);
            return null;
        }

        logger.info(`Selected Scholarship Rule: ${selectedRule.name} (${selectedRule.id})`);

        // 3. Allocate (Reserve)
        // Use transaction to ensure slot safety
        const allocation = await prisma.$transaction(async (tx) => {
            // Re-fetch rule to lock row logic (Prisma doesn't do "FOR UPDATE" easily, but update ensures atomicity)
            // We optimistically try to increment filledSlots
            
            const freshRule = await tx.scholarshipRule.findUnique({
                where: { id: selectedRule.id }
            });

            if (!freshRule || freshRule.filledSlots >= freshRule.totalSlots) {
                 throw new Error('SLOT_FULL');
            }

            await tx.scholarshipRule.update({
                where: { id: selectedRule.id },
                data: { filledSlots: { increment: 1 } }
            });

            // Delete any existing reservation if exists?
            // Assuming this is first time allocation or re-allocation replaces old?
            // If re-allocating, we should release old slot.
            const existing = await tx.scholarshipAllocation.findUnique({
                where: { studentId }
            });
            
            if (existing) {
                const oldRuleId = existing.ruleId;
                await tx.scholarshipAllocation.delete({ where: { studentId } });
                await tx.scholarshipRule.update({
                    where: { id: oldRuleId },
                    data: { filledSlots: { decrement: 1 } }
                });
            }

            return await tx.scholarshipAllocation.create({
                data: {
                    studentId,
                    ruleId: selectedRule.id,
                    status: ScholarshipStatus.RESERVED,
                    reservedAt: new Date()
                },
                include: { rule: true }
            });
        });

        return allocation;
    },

    async getStudentAllocation(studentId: string) {
        return await prisma.scholarshipAllocation.findUnique({
            where: { studentId },
            include: { rule: true }
        });
    },

    async lockAllocation(studentId: string) {
        const allocation = await prisma.scholarshipAllocation.findUnique({ where: { studentId } });
        if (!allocation) return null;

        if (allocation.status !== ScholarshipStatus.RESERVED) return allocation; // Already locked or expired

        const lockedAt = new Date();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 20); // 20 days expiry

        return await prisma.scholarshipAllocation.update({
            where: { studentId },
            data: {
                status: ScholarshipStatus.LOCKED,
                lockedAt,
                expiresAt
            }
        });
    },

    async allocateManualRule(studentId: string, ruleId: string) {
        logger.info(`Manually allocating scholarship rule ${ruleId} to student ${studentId}`);

        const rule = await prisma.scholarshipRule.findUnique({ where: { id: ruleId } });
        if (!rule) throw new AppError('Scholarship Rule not found', 404);
        if (rule.filledSlots >= rule.totalSlots) throw new AppError('Scholarship Rule slots full', 400);

        return await prisma.$transaction(async (tx) => {
            await tx.scholarshipRule.update({
                where: { id: ruleId },
                data: { filledSlots: { increment: 1 } }
            });

            // Remove existing if any
            const existing = await tx.scholarshipAllocation.findUnique({ where: { studentId } });
            if (existing) {
                await tx.scholarshipAllocation.delete({ where: { studentId } });
                await tx.scholarshipRule.update({
                    where: { id: existing.ruleId },
                    data: { filledSlots: { decrement: 1 } }
                });
            }

            return await tx.scholarshipAllocation.create({
                data: {
                    studentId,
                    ruleId,
                    status: ScholarshipStatus.RESERVED,
                    reservedAt: new Date()
                }
            });
        });
    }
};

