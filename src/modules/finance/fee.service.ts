import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { FeeStructure, SystemSetting, FeeHead, Role, DiscountStatus, PaymentMethod, PaymentComponent, PaymentStatus, PaymentMode, AdmissionStatus } from '@prisma/client';
import { MESSAGES } from '../../constants/messages';

const APP_FEE_KEY = 'APPLICATION_FEE_AMOUNT';
const DEFAULT_APP_FEE = '500';

export const getApplicationFeeAmount = async (): Promise<number> => {
    const setting = await prisma.systemSetting.findUnique({
        where: { key: APP_FEE_KEY }
    });
    return parseInt(setting?.value || DEFAULT_APP_FEE, 10);
};

export const setApplicationFeeAmount = async (amount: number, userId: string): Promise<SystemSetting> => {
    return prisma.systemSetting.upsert({
        where: { key: APP_FEE_KEY },
        update: {
            value: amount.toString(),
            updatedBy: userId
        },
        create: {
            key: APP_FEE_KEY,
            value: amount.toString(),
            updatedBy: userId
        }
    });
};

export const FeeService = {
    // Fee Head
    createFeeHead: async (name: string, description: string, userId: string) => {
        return prisma.feeHead.create({
            data: { name, description, createdBy: userId, updatedBy: userId }
        });
    },

    getFeeHeads: async () => {
        return prisma.feeHead.findMany({ where: { isDeleted: false } });
    },

    updateFeeHead: async (id: string, name: string, description: string, userId: string) => {
        return prisma.feeHead.update({
            where: { id },
            data: { name, description, updatedBy: userId }
        });
    },

    deleteFeeHead: async (id: string) => {
        return prisma.feeHead.update({
            where: { id },
            data: { isDeleted: true }
        });
    },

    // Fee Structure
    createFeeStructure: async (courseId: string, feeHeadId: string, amount: number, academicYearId: string, userId: string) => {
        return prisma.feeStructure.create({
            data: {
                courseId,
                feeHeadId,
                amount,
                academicYearId,
                createdBy: userId,
                updatedBy: userId
            }
        });
    },

    getFeeStructures: async () => {
        return prisma.feeStructure.findMany({
            where: { isDeleted: false },
            include: {
                course: true,
                feeHead: true,
                academicYear: true
            }
        });
    },

    updateFeeStructure: async (id: string, courseId: string, feeHeadId: string, amount: number, academicYearId: string, userId: string) => {
        return prisma.feeStructure.update({
            where: { id },
            data: {
                courseId,
                feeHeadId,
                amount,
                academicYearId,
                updatedBy: userId
            }
        });
    },

    deleteFeeStructure: async (id: string) => {
        return prisma.feeStructure.update({
            where: { id },
            data: { isDeleted: true }
        });
    },

    // Statistics
    getFeeStatistics: async () => {
        const totalCollected = await prisma.payment.aggregate({
            where: { status: 'SUCCESS' },
            _sum: { amount: true }
        });
        const totalPending = await prisma.studentFeeDemand.aggregate({
            where: { status: 'PENDING' },
            _sum: { amount: true }
        });
        
        return {
            collected: totalCollected._sum.amount || 0,
            pending: totalPending._sum.amount || 0
        };
    },

    // Discounts
    createDiscountRequest: async (studentId: string, reason: string, documentUrl?: string) => {
        return prisma.discountRequest.create({
            data: {
                studentId,
                reason,
                documentUrl,
                status: DiscountStatus.REQUESTED
            }
        });
    },

    reviewDiscountRequest: async (requestId: string, remarks?: string) => {
        return prisma.discountRequest.update({
            where: { id: requestId },
            data: {
                status: DiscountStatus.FORWARDED_TO_SUPER_ADMIN,
                remarks
            }
        });
    },

    approveDiscount: async (requestId: string, approved: boolean, role: Role) => {
         if (role !== Role.SUPER_ADMIN) {
             throw new AppError("Only Super Admin can approve discounts", 403);
         }
         return prisma.discountRequest.update({
            where: { id: requestId },
            data: {
                status: approved ? DiscountStatus.APPROVED : DiscountStatus.REJECTED
            }
         });
    },

    // Manual Payment Collection
    recordOfflinePayment: async (
        studentId: string,
        amount: number,
        method: PaymentMethod,
        component: PaymentComponent,
        adminId: string,
        referenceNumber?: string,
        bankDetails?: { bankName?: string, branchName?: string, instrumentDate?: Date }
    ) => {
        // 1. Verify Student
        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        // 2. Validate Reference Number
        if (method !== PaymentMethod.CASH && !referenceNumber) {
            throw new AppError("Transaction ID / Reference Number is required for Non-Cash payments", 400);
        }

        if (referenceNumber) {
            const existing = await prisma.payment.findFirst({ where: { referenceNumber } });
            if (existing) throw new AppError("Transaction ID already exists", 400);
        }

        // 3. Create Payment Record
        const payment = await prisma.payment.create({
            data: {
                studentId,
                amount,
                currency: 'INR',
                status: PaymentStatus.SUCCESS,
                mode: method === PaymentMethod.CASH ? PaymentMode.OFFLINE : PaymentMode.OFFLINE, // Both are OFFLINE mode
                method,
                referenceNumber: referenceNumber || `RCPT-${Date.now()}`, // Auto-gen receipt for Cash if missing
                collectedBy: adminId,
                component,
                bankName: bankDetails?.bankName,
                branchName: bankDetails?.branchName,
                instrumentDate: bankDetails?.instrumentDate,
                invoiceUrl: "PENDING_GENERATION" // Placeholder or trigger generation
            }
        });

        // 4. Update Status (Workflow Logic)
        if (component === PaymentComponent.APPLICATION_FEE) {
             await prisma.studentAdmission.upsert({
                 where: { studentId },
                 create: { studentId, status: AdmissionStatus.ENTRANCE_FEE_PAID },
                 update: { status: AdmissionStatus.ENTRANCE_FEE_PAID }
             });
        } else if (component === PaymentComponent.TUITION) {
             // Upgrade to ADMISSION_CONFIRMED if Seat Allocated
             // This is the "Token Fee" or "Admission Fee" payment
             const admission = await prisma.studentAdmission.findUnique({ where: { studentId } });
             if (admission && admission.status === AdmissionStatus.SEAT_ALLOTTED) { 
                 await prisma.studentAdmission.update({
                     where: { studentId },
                     data: { status: AdmissionStatus.ADMISSION_CONFIRMED }
                 });
             }
        }
        
        return payment;
    }
};
