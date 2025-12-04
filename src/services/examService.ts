import prisma from '../config/prisma';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { AdmissionStatus } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';

export const createExamDate = async (data: any) => {
    const examDate = await prisma.examDate.create({
        data: {
            date: new Date(data.date),
            name: data.name,
            startTime: data.startTime ? new Date(data.startTime) : null,
            endTime: data.endTime ? new Date(data.endTime) : null,
        }
    });
    logger.info(`Exam date created: ${examDate.id} for ${examDate.date}`);
    return examDate;
};

export const createExamCenter = async (data: any) => {
    const examCenter = await prisma.examCenter.create({
        data: {
            name: data.name,
            address: data.address,
            city: data.city,
            capacity: data.capacity,
        }
    });
    logger.info(`Exam center created: ${examCenter.id} - ${examCenter.name}`);
    return examCenter;
};

export const generateInvigilatorCredentials = async (adminId: string, data: any) => {
    const { validFrom, validUntil, count } = data;
    const credentials = [];

    for (let i = 0; i < count; i++) {
        const token = uuidv4(); // Simple token for now, could be more complex
        credentials.push({
            adminId,
            token,
            validFrom: new Date(validFrom),
            validUntil: new Date(validUntil),
        });
    }

    const result = await prisma.invigilatorCredential.createMany({
        data: credentials
    });

    logger.info(`Generated ${result.count} invigilator credentials by admin=${adminId}`);
    return { tokens: credentials.map(c => c.token), count: result.count };
};

export const verifyInvigilatorToken = async (token: string) => {
    const credential = await prisma.invigilatorCredential.findFirst({
        where: {
            token,
            validFrom: { lte: new Date() },
            validUntil: { gte: new Date() }
        }
    });

    if (!credential) {
        throw new AppError(MESSAGES.ERROR.INVALID_EXPIRED_TOKEN, 401);
    }

    logger.info(`Invigilator verified: ${credential.id}`);
    return credential;
};

export const markAttendanceByScan = async (qrHash: string, invigilatorId: string) => {
    // Find HallTicket by qrHash
    const hallTicket = await prisma.hallTicket.findFirst({
        where: { qrHash },
        include: { student: { include: { examDetails: true } } }
    });

    if (!hallTicket) {
        throw new AppError(MESSAGES.ERROR.INVALID_QR, 400);
    }

    const student = hallTicket.student;

    // Check if already attended
    if (student.examDetails?.examAttended) {
        throw new AppError(MESSAGES.ERROR.ATTENDANCE_ALREADY_MARKED, 400);
    }

    // Mark attendance
    await prisma.$transaction([
        prisma.studentExam.update({
            where: { studentId: student.id },
            data: {
                examAttended: true
            }
        }),
        prisma.studentAdmission.update({
            where: { studentId: student.id },
            data: {
                status: AdmissionStatus.EXAM_ATTENDED
            }
        }),
        prisma.attendanceRecord.create({
            data: {
                studentId: student.id,
                invigilatorId, // This is the ID of the credential used
                scannedAt: new Date(),
                // examDateId: ... we might need to infer this from current time vs ExamDate
            }
        })
    ]);

    logger.info(`Attendance marked for student=${student.id} by invigilator=${invigilatorId}`);
    return { message: `Attendance marked for ${student.name} (${student.applicationId})` };
};

export const createExamSlot = async (data: any) => {
    const { examCenterId, date, startTime, endTime, capacity } = data;
    const slot = await prisma.examSlot.create({
        data: {
            examCenterId,
            date: new Date(date),
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            capacity: Number(capacity)
        }
    });
    logger.info(`Exam slot created: ${slot.id} at ${slot.examCenterId}`);
    return slot;
};

export const getAvailableSlots = async () => {
    const slots = await prisma.examSlot.findMany({
        where: {
            date: {
                gte: new Date()
            }
        },
        include: {
            examCenter: true
        },
        orderBy: {
            date: 'asc'
        }
    });

    // Filter slots where filled < capacity
    const availableSlots = slots.filter(slot => slot.filled < slot.capacity);

    logger.info(`Retrieved ${availableSlots.length} available exam slots`);
    return availableSlots;
};

export const bookExamSlot = async (studentId: string, slotId: string) => {
    // 1. Check student status
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });
    if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

    if (student.admissionDetails?.status !== AdmissionStatus.TEST_FEE_PAID &&
        student.admissionDetails?.status !== AdmissionStatus.HALL_TICKET_GENERATED) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_ELIGIBLE_SLOT, 400);
    }

    // 2. Check slot availability (Atomic update preferred)
    // We can use a transaction to ensure no overbooking
    const result = await prisma.$transaction(async (tx) => {
        const slot = await tx.examSlot.findUnique({ where: { id: slotId }, include: { examCenter: true } });
        if (!slot) throw new AppError(MESSAGES.ERROR.SLOT_NOT_FOUND, 404);

        if (slot.filled >= slot.capacity) {
            throw new AppError(MESSAGES.ERROR.SLOT_FULL, 400);
        }

        // Increment filled count
        await tx.examSlot.update({
            where: { id: slotId },
            data: { filled: { increment: 1 } }
        });

        const hallTicketUrl = `https://s3.aws.com/halltickets/${student.applicationId}.pdf`;

        // Update student exam details
        await tx.studentExam.update({
            where: { studentId },
            data: {
                examSlotId: slotId,
                testDate: slot.date,
                testCenter: slot.examCenter.name,
                hallTicketUrl
            }
        });

        // Update admission status
        await tx.studentAdmission.update({
            where: { studentId },
            data: {
                status: AdmissionStatus.HALL_TICKET_GENERATED
            }
        });

        // Create Hall Ticket record
        await tx.hallTicket.create({
            data: {
                studentId,
                url: hallTicketUrl,
                qrHash: uuidv4() // Generate a unique hash for QR
            }
        });

        return { studentId, slotId, hallTicketUrl };
    });

    logger.info(`Exam slot booked: student=${studentId} slot=${slotId}`);
    return result;
};
