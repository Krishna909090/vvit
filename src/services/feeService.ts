import prisma from '../config/prisma';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';
import { FeeStatus, HostelType, DiscountStatus, Role } from '@prisma/client';

export const FeeService = {
    // Fee Head
    async createFeeHead(name: string, description: string, createdBy?: string) {
        const existingFeeHead = await prisma.feeHead.findFirst({
            where: { name: { equals: name, mode: 'insensitive' } }
        });

        if (existingFeeHead) {
            throw new AppError(MESSAGES.ERROR.FEE_HEAD_EXISTS, 409);
        }

        return await prisma.feeHead.create({
            data: { name, description, createdBy }
        });
    },

    async getFeeHeads() {
        return await prisma.feeHead.findMany();
    },

    async updateFeeHead(id: string, name: string, description: string, updatedBy?: string) {
        const feeHead = await prisma.feeHead.findUnique({ where: { id } });
        if (!feeHead) throw new AppError(MESSAGES.ERROR.FEE_HEAD_NOT_FOUND, 404);

        if (feeHead.name === name && feeHead.description === description) {
            throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
        }

        return await prisma.feeHead.update({
            where: { id },
            data: { name, description, updatedBy }
        });
    },

    async deleteFeeHead(id: string) {
        const feeHead = await prisma.feeHead.findUnique({ where: { id } });
        if (!feeHead) throw new AppError(MESSAGES.ERROR.FEE_HEAD_NOT_FOUND, 404);

        return await prisma.feeHead.update({ where: { id }, data: { isDeleted: true } });
    },

    // Fee Structure
    async createFeeStructure(courseId: string, feeHeadId: string, amount: number, academicYearId: string, createdBy?: string) {
        const existingStructure = await prisma.feeStructure.findFirst({
            where: {
                courseId,
                feeHeadId,
                academicYearId
            }
        });

        if (existingStructure) {
            throw new AppError(MESSAGES.ERROR.FEE_STRUCTURE_EXISTS, 409);
        }

        return await prisma.feeStructure.create({
            data: {
                courseId,
                feeHeadId,
                amount: Number(amount),
                academicYearId,
                createdBy
            }
        });
    },

    async getFeeStructures() {
        return await prisma.feeStructure.findMany({
            include: { course: true, feeHead: true, academicYear: true }
        });
    },

    async updateFeeStructure(id: string, courseId: string, feeHeadId: string, amount: number, academicYearId: string, updatedBy?: string) {
        const feeStructure = await prisma.feeStructure.findUnique({ where: { id } });
        if (!feeStructure) throw new AppError(MESSAGES.ERROR.FEE_STRUCTURE_NOT_FOUND, 404);

        if (feeStructure.courseId === courseId &&
            feeStructure.feeHeadId === feeHeadId &&
            feeStructure.amount === Number(amount) &&
            feeStructure.academicYearId === academicYearId) {
            throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
        }

        return await prisma.feeStructure.update({
            where: { id },
            data: {
                courseId,
                feeHeadId,
                amount: Number(amount),
                academicYearId,
                updatedBy
            }
        });
    },

    async deleteFeeStructure(id: string) {
        const feeStructure = await prisma.feeStructure.findUnique({ where: { id } });
        if (!feeStructure) throw new AppError(MESSAGES.ERROR.FEE_STRUCTURE_NOT_FOUND, 404);

        return await prisma.feeStructure.update({ where: { id }, data: { isDeleted: true } });
    },

    // Fee Statistics
    async getFeeStatistics() {
        const stats = await prisma.$transaction([
            // Fully Paid Male
            prisma.studentAdmission.count({ where: { feeStatus: FeeStatus.FULL, student: { gender: { equals: 'Male', mode: 'insensitive' } } } }),
            // Fully Paid Female
            prisma.studentAdmission.count({ where: { feeStatus: FeeStatus.FULL, student: { gender: { equals: 'Female', mode: 'insensitive' } } } }),
            // Partial Paid Male
            prisma.studentAdmission.count({ where: { feeStatus: FeeStatus.PARTIAL, student: { gender: { equals: 'Male', mode: 'insensitive' } } } }),
            // Partial Paid Female
            prisma.studentAdmission.count({ where: { feeStatus: FeeStatus.PARTIAL, student: { gender: { equals: 'Female', mode: 'insensitive' } } } }),
            // Hostel 4 Sharing
            prisma.studentAdmission.count({ where: { hostelType: HostelType.SHARING_4 } }),
            // Hostel 8 Sharing
            prisma.studentAdmission.count({ where: { hostelType: HostelType.SHARING_8 } }),
        ]);

        // State-wise stats
        const stateStats = await prisma.student.groupBy({
            by: ['state'],
            _count: {
                id: true
            }
        });

        return {
            fullyPaid: { male: stats[0], female: stats[1] },
            partialPaid: { male: stats[2], female: stats[3] },
            hostel: { sharing4: stats[4], sharing8: stats[5] },
            stateWise: stateStats
        };
    },

    // Discount Request
    async createDiscountRequest(studentId: string, reason: string, documentUrl?: string) {
        if (!studentId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_REASON_REQUIRED, 400);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        return await prisma.discountRequest.create({
            data: {
                studentId,
                reason,
                documentUrl,
                status: DiscountStatus.FORWARDED_TO_SUPER_ADMIN
            }
        });
    },

    async reviewDiscountRequest(requestId: string, remarks?: string) {
        if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

        await prisma.discountRequest.update({
            where: { id: requestId },
            data: {
                status: DiscountStatus.FORWARDED_TO_SUPER_ADMIN,
                remarks
            }
        });
    },

    async approveDiscount(requestId: string, approved: boolean, userRole?: string) {
        if (userRole !== Role.SUPER_ADMIN) {
            throw new AppError(MESSAGES.ERROR.ONLY_SUPER_ADMIN_APPROVE_DISCOUNT, 403);
        }

        if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

        const status = approved ? DiscountStatus.APPROVED : DiscountStatus.REJECTED;

        await prisma.discountRequest.update({
            where: { id: requestId },
            data: { status }
        });
    }
};
