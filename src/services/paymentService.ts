
import prisma from '../config/prisma';
import logger from '../utils/logger';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';
import { FeeStatus, AdmissionStatus, AgentCommissionStatus } from '@prisma/client';

export const payTestFee = async (studentId: string, currentUserId: string | null) => {
    // Validate student exists and check admission status
    const student = await prisma.student.findUnique({ 
        where: { id: studentId },
        include: { admissionDetails: true }
    });
    
    if (!student) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    // Check if student is in correct status to pay test fee
    if (!student.admissionDetails) {
        throw new AppError('Admission details not found', 404);
    }

    if (student.admissionDetails.status !== AdmissionStatus.REGISTERED) {
        throw new AppError(
            `Cannot pay test fee: Current status is ${student.admissionDetails.status}. Must be REGISTERED.`,
            400
        );
    }

    // Check if already paid
    if (student.admissionDetails.feeStatus !== FeeStatus.PENDING) {
        throw new AppError(MESSAGES.ERROR.ALREADY_PAID, 400);
    }

    // Update Admission Status
    const updatedAdmission = await prisma.studentAdmission.update({
        where: { studentId },
        data: { status: AdmissionStatus.TEST_FEE_PAID }
    });

    // Record Payment
    await prisma.payment.create({
        data: {
            studentId,
            amount: 500,
            component: 'APPLICATION_FEE',
            status: 'SUCCESS',
            method: 'ONLINE'
        }
    });

    if (student?.agentId) {
        await prisma.agentCommission.create({
            data: {
                agentId: student.agentId,
                studentId: student.id,
                amount: 100, // Example commission
                component: 'APPLICATION_FEE',
                status: AgentCommissionStatus.PENDING
            }
        });
    }

    logger.info(`Test fee paid for student: ${studentId}`);
    return { ...student, admissionDetails: updatedAdmission };
};

export const payCollegeFee = async (studentId: string, currentUserId: string | null) => {
    const admission = await prisma.studentAdmission.findUnique({ where: { studentId } });
    if (admission?.status !== AdmissionStatus.SEAT_ALLOTTED) {
        throw new AppError(MESSAGES.ERROR.SEAT_NOT_ALLOTTED, 400);
    }

    if (admission.feeStatus === FeeStatus.FULL) {
        throw new AppError(MESSAGES.ERROR.ALREADY_PAID, 400);
    }

    const updatedAdmission = await prisma.studentAdmission.update({
        where: { studentId },
        data: {
            feeStatus: FeeStatus.FULL,
            status: AdmissionStatus.ADMISSION_CONFIRMED
        }
    });

    const student = await prisma.student.findUnique({ where: { id: studentId } });

    // Record Payment
    await prisma.payment.create({
        data: {
            studentId,
            amount: updatedAdmission.totalFee > 0 ? updatedAdmission.totalFee : 100000,
            component: 'TUITION',
            status: 'SUCCESS',
            method: 'ONLINE'
        }
    });

    if (student?.agentId) {
        await prisma.agentCommission.create({
            data: {
                agentId: student.agentId,
                studentId: student.id,
                amount: 5000,
                component: 'COLLEGE_FEE',
                status: AgentCommissionStatus.PENDING
            }
        });
    }

    logger.info(`College fee paid for student: ${studentId}`);
    return updatedAdmission;
};

export const requestDiscount = async (studentId: string, reason: string, documentUrl: string, currentUserId: string | null) => {
    const studentExists = await prisma.student.findUnique({ where: { id: studentId } });
    if (!studentExists) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    const existingRequest = await prisma.discountRequest.findFirst({
        where: {
            studentId,
            status: { in: ['REQUESTED', 'FORWARDED_TO_SUPER_ADMIN'] }
        }
    });

    if (existingRequest) {
        throw new AppError(MESSAGES.ERROR.DISCOUNT_ALREADY_REQUESTED, 409);
    }

    const discountRequest = await prisma.discountRequest.create({
        data: {
            studentId,
            reason,
            documentUrl,
            createdBy: currentUserId,
            updatedBy: currentUserId
        }
    });
    logger.info(`Discount requested for student: ${studentId}`);
    return discountRequest;
};
