// services/examService.ts
// Business logic for exam centers, slots, invigilator tokens, and attendance.

import prisma from '../config/prisma';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { AdmissionStatus, Prisma } from '@prisma/client';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';
import Papa from 'papaparse';

/* -------------------------------------------------------------------------- */
/*                               HELPER FUNCTIONS                             */
/* -------------------------------------------------------------------------- */

/**
 * Safely parse a string/Date into a valid Date object and throw 400 on invalid.
 */
const parseDate = (value: string | Date, fieldName: string): Date => {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) {
        throw new AppError(`${fieldName} is invalid date`, 400);
    }
    return d;
};

/**
 * Ensure a value is a positive integer, or throw 400.
 */
const assertPositiveInt = (value: any, fieldName: string) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
        throw new AppError(`${fieldName} must be a positive integer`, 400);
    }
    return num;
};

/**
 * Format a date into dd-MM-yyyy string.
 */
const formatDate = (date: Date) => {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
};

/**
 * Format a time part using 12-hour clock without space.
 */
const formatTime = (date: Date) => {
    return new Date(date)
        .toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        })
        .replace(' ', '');
};

/**
 * Transform exam center with examSlots into a UI-friendly structure.
 */
const transformExamCenterWithSlots = (center: any) => {
    return {
        ...center,
        slots: center.examSlots.map((slot: any) => ({
            id: slot.id,
            capacity: slot.capacity,
            date: formatDate(slot.date),
            startTime: formatTime(slot.startTime),
            endTime: formatTime(slot.endTime),
        })),
        examSlots: undefined,
    };
};

/**
 * Transform a single exam slot into a UI-friendly structure (with center name).
 */
const transformSlot = (slot: any) => ({
    id: slot.id,
    examCenterId: slot.examCenterId,
    examCenterName: slot.examCenter?.name,
    capacity: slot.capacity,
    filled: slot.filled,
    isBookingEnabled: slot.isBookingEnabled,
    date: formatDate(slot.date),
    startTime: formatTime(slot.startTime),
    endTime: formatTime(slot.endTime),
});

/* -------------------------------------------------------------------------- */
/*                               SERVICE METHODS                              */
/* -------------------------------------------------------------------------- */

/**
 * Create a new exam center with optional capacity and basic duplicates check.
 */
export const createExamCenter = async (data: any, userId?: string) => {
    const name = data.name?.trim();
    const city = data.city?.trim();
    const address = data.address?.trim() || null;

    if (!name) {
        throw new AppError(MESSAGES.ERROR.CENTER_NAME_REQUIRED, 400);
    }

    if (!city) {
        throw new AppError(MESSAGES.ERROR.CITY_REQUIRED, 400);
    }

    const capacity = data.capacity != null ? assertPositiveInt(data.capacity, 'Capacity') : null;

    const existingCenter = await prisma.examCenter.findFirst({
        where: {
            name: { equals: name, mode: 'insensitive' },
            city: { equals: city, mode: 'insensitive' },
        },
    });

    if (existingCenter) {
        throw new AppError(
            MESSAGES.ERROR.EXAM_CENTER_EXISTS || 'Exam center already exists in this city',
            409
        );
    }

    const examCenter = await prisma.examCenter.create({
        data: {
            name,
            address,
            city,
            capacity: capacity ?? undefined,
            createdBy: userId,
        },
    });
    logger.info(`Exam center created: ${examCenter.id} - ${examCenter.name}`);
    return examCenter;
};

/**
 * Generate one or more time-bound invigilator credentials (tokens).
 */
export const generateInvigilatorCredentials = async (adminId: string, data: any) => {
    if (!adminId) {
        throw new AppError(MESSAGES.ERROR.UNAUTHORIZED, 401);
    }

    const validFrom = parseDate(data.validFrom, 'validFrom');
    const validUntil = parseDate(data.validUntil, 'validUntil');

    if (validFrom >= validUntil) {
        throw new AppError(
            MESSAGES.ERROR.INVALID_DATE_RANGE,
            400
        );
    }

    const count = assertPositiveInt(data.count ?? 1, 'count');

    const credentials = [];
    for (let i = 0; i < count; i++) {
        const token = uuidv4().substring(0, 8).toUpperCase(); // Short simple token
        credentials.push({
            adminId,
            token,
            validFrom,
            validUntil,
            createdBy: adminId, // audit
        });
    }

    const result = await prisma.invigilatorCredential.createMany({
        data: credentials,
    });

    logger.info(`Generated ${result.count} invigilator credentials by admin=${adminId}`);
    return { tokens: credentials.map(c => c.token), count: result.count };
};

/**
 * Verify invigilator login token based on validity date range.
 */
export const verifyInvigilatorToken = async (token: string) => {
    if (!token || !token.trim()) {
        throw new AppError(MESSAGES.ERROR.INVALID_EXPIRED_TOKEN, 401);
    }

    const now = new Date();
    const credential = await prisma.invigilatorCredential.findFirst({
        where: {
            token,
            validFrom: { lte: now },
            validUntil: { gte: now },
        },
    });

    if (!credential) {
        logger.warn(`[verifyInvigilatorToken] Invalid or expired token: ${token}`);
        throw new AppError(MESSAGES.ERROR.INVALID_EXPIRED_TOKEN, 401);
    }

    logger.info(`Invigilator verified: ${credential.id}`);
    return credential;
};

/**
 * Mark student attendance by scanning a hall ticket QR hash.
 */
export const markAttendanceByScan = async (qrHash: string, invigilatorId: string) => {
    if (!qrHash || !qrHash.trim()) {
        throw new AppError(MESSAGES.ERROR.QR_HASH_REQUIRED, 400);
    }

    const hallTicket = await prisma.hallTicket.findFirst({
        where: { qrHash },
        include: { student: { include: { examDetails: true } } },
    });

    if (!hallTicket) {
        throw new AppError(MESSAGES.ERROR.INVALID_QR, 400);
    }

    const student = hallTicket.student;

    if (student.examDetails?.examAttended) {
        throw new AppError(MESSAGES.ERROR.ATTENDANCE_ALREADY_MARKED, 400);
    }

    await prisma.$transaction([
        prisma.studentExam.update({
            where: { studentId: student.id },
            data: {
                examAttended: true,
            },
        }),
        prisma.studentAdmission.update({
            where: { studentId: student.id },
            data: {
                status: AdmissionStatus.EXAM_ATTENDED,
            },
        }),
        prisma.attendanceRecord.create({
            data: {
                studentId: student.id,
                invigilatorId,
                scannedAt: new Date(),
                createdBy: invigilatorId, // audit
            },
        }),
    ]);

    logger.info(`Attendance marked for student=${student.id} by invigilator=${invigilatorId}`);
    return { message: `Attendance marked for ${student.name} (${student.applicationId})` };
};

/**
 * Mark student attendance manually by admin using Student ID.
 */
export const markAttendanceManually = async (studentId: string, attended: boolean, adminId: string | undefined) => {
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    if (typeof attended !== 'boolean') throw new AppError(MESSAGES.ERROR.ATTENDED_BOOLEAN, 400);

    // If already in that state, maybe return success but here we just update.
    
    await prisma.$transaction([
        prisma.studentExam.update({
            where: { studentId },
            data: {
                examAttended: attended,
                // updatedBy: adminId - Field not in schema
            }
        }),
        prisma.studentAdmission.update({
            where: { studentId },
            data: {
                // If attended true -> EXAM_ATTENDED
                // If attended false (unmark) -> Back to HALL_TICKET_GENERATED (assuming)
                status: attended ? AdmissionStatus.EXAM_ATTENDED : AdmissionStatus.HALL_TICKET_GENERATED,
                // updatedBy: adminId - Field not in schema
            }
        })
    ]);

    logger.info(`[markAttendanceManually] Attendance marked for ${studentId}: ${attended} by ${adminId}`);
};

/**
 * Update exam score for a single student.
 */
export const updateStudentExamScore = async (studentId: string, score: number, cutoff: number, adminId: string | undefined) => {
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    if (score === undefined || cutoff === undefined) {
        throw new AppError(MESSAGES.ERROR.SCORE_CUTOFF_REQUIRED, 400);
    }

    const isQualified = Number(score) >= Number(cutoff);

    const examDetails = await prisma.studentExam.update({
        where: { studentId },
        data: {
            examScore: Number(score),
            isQualified,
            // updatedBy: adminId - Field not in schema
        }
    });

    logger.info(`[updateStudentExamScore] Exam score updated for ${studentId}: ${score}, Qualified: ${isQualified}`);
    return { score: examDetails.examScore, isQualified: examDetails.isQualified };
};

/**
 * Create a new exam slot in a given center, respecting center capacity.
 */
export const createExamSlot = async (data: any, userId?: string) => {
    const { examCenterId } = data;

    if (!examCenterId) {
        throw new AppError(
            MESSAGES.ERROR.EXAM_CENTER_ID_REQUIRED,
            400
        );
    }

    const date = parseDate(data.date, 'date');
    const startTime = parseDate(data.startTime, 'startTime');
    const endTime = parseDate(data.endTime, 'endTime');
    const capacity = assertPositiveInt(data.capacity, 'capacity');

    if (startTime >= endTime) {
        throw new AppError(
            MESSAGES.ERROR.INVALID_TIME_RANGE,
            400
        );
    }

    const existingSlot = await prisma.examSlot.findFirst({
        where: {
            examCenterId,
            date,
            startTime,
            endTime,
        },
    });

    if (existingSlot) {
        logger.warn(
            `[createExamSlot] Slot conflict in center=${examCenterId} date=${date.toISOString()} time=${startTime.toISOString()}-${endTime.toISOString()}`
        );
        throw new AppError(
            MESSAGES.ERROR.EXAM_SLOT_EXISTS || 'Exam slot already exists for this time',
            409
        );
    }

    const center = await prisma.examCenter.findUnique({
        where: { id: examCenterId },
        include: { examSlots: true },
    });

    if (!center) throw new AppError(MESSAGES.ERROR.EXAM_CENTER_NOT_FOUND, 404);

    const currentTotalCapacity = center.examSlots.reduce((sum: number, s: any) => sum + s.capacity, 0);

    if (center.capacity && currentTotalCapacity + capacity > center.capacity) {
        logger.warn(
            `[createExamSlot] Capacity exceeded for center=${examCenterId}: current=${currentTotalCapacity} new=${capacity} max=${center.capacity}`
        );
        throw new AppError(
            `Cannot create slot. Total slot capacity (${currentTotalCapacity + capacity}) exceeds exam center capacity (${center.capacity})`,
            400
        );
    }

    const slot = await prisma.examSlot.create({
        data: {
            examCenterId,
            date,
            startTime,
            endTime,
            capacity,
            createdBy: userId,
        },
    });
    logger.info(`Exam slot created: ${slot.id} at ${slot.examCenterId}`);
    return slot;
};

/**
 * Get all future and booking-enabled slots that are not full.
 */
export const getAvailableSlots = async () => {
    // 1. Fetch available slots (future date, booking enabled)
    const slots = await prisma.examSlot.findMany({
        where: {
            date: {
                gte: new Date(),
            },
            isBookingEnabled: true,
        },
        include: {
            examCenter: true,
        },
        orderBy: {
            date: 'asc',
        },
    });

    // 2. Filter out full slots
    const availableSlots = slots.filter((slot: any) => slot.filled < slot.capacity);

    // 3. Group by Exam Center
    const centerMap = new Map();
    availableSlots.forEach((slot: any) => {
        const centerId = slot.examCenterId;

        if (!centerMap.has(centerId)) {
            centerMap.set(centerId, {
                id: slot.examCenter.id,
                name: slot.examCenter.name,
                city: slot.examCenter.city,
                address: slot.examCenter.address,
                availableSlots: []
            });
        }

        const centerData = centerMap.get(centerId);
        centerData.availableSlots.push({
            id: slot.id,
            date: formatDate(slot.date),
            startTime: formatTime(slot.startTime),
            endTime: formatTime(slot.endTime),
            capacity: slot.capacity,
            filled: slot.filled,
            seatsAvailable: slot.capacity - slot.filled,
            isBookingEnabled: slot.isBookingEnabled
        });
    });

    const result = Array.from(centerMap.values());
    logger.info(`Retrieved ${availableSlots.length} available slots across ${result.length} centers`);
    return result;
};

/**
 * Book an exam slot for a student, generate hall ticket, and update status.
 */
export const bookExamSlot = async (studentId: string, slotId: string, userId?: string) => {
    if (!studentId || !slotId) {
        throw new AppError(MESSAGES.ERROR.STUDENT_ID_SLOT_ID_REQUIRED, 400);
    }

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true },
    });
    if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

    if (
        student.admissionDetails?.status !== AdmissionStatus.TEST_FEE_PAID &&
        student.admissionDetails?.status !== AdmissionStatus.HALL_TICKET_GENERATED
    ) {
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_ELIGIBLE_SLOT, 400);
    }

    const existingExam = await prisma.studentExam.findUnique({
        where: { studentId },
    });

    if (existingExam?.examSlotId) {
        throw new AppError(
            MESSAGES.ERROR.SLOT_ALREADY_BOOKED || 'Student already has a slot booked',
            409
        );
    }

    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const slot = await tx.examSlot.findUnique({
            where: { id: slotId },
            include: { examCenter: true },
        });
        if (!slot) throw new AppError(MESSAGES.ERROR.SLOT_NOT_FOUND, 404);

        if (slot.filled >= slot.capacity) {
            throw new AppError(MESSAGES.ERROR.SLOT_FULL, 400);
        }

        const now = new Date();
        if (slot.date < now) {
            throw new AppError(
                MESSAGES.ERROR.SLOT_IN_PAST,
                400
            );
        }

        await tx.examSlot.update({
            where: { id: slotId },
            data: {
                filled: { increment: 1 },
                updatedBy: userId,
            },
        });

        const hallTicketUrl = `https://s3.aws.com/halltickets/${student.applicationId}.pdf`;

        await tx.studentExam.update({
            where: { studentId },
            data: {
                examSlotId: slotId,
                testDate: slot.date,
                testCenter: slot.examCenter.name,
                hallTicketUrl,
            },
        });

        await tx.studentAdmission.update({
            where: { studentId },
            data: {
                status: AdmissionStatus.HALL_TICKET_GENERATED,
            },
        });

        const hallTicket = await tx.hallTicket.create({
            data: {
                studentId,
                url: hallTicketUrl,
                qrHash: uuidv4(),
                createdBy: userId,
            },
        });

        return {
            studentId,
            slotId,
            hallTicketUrl,
            qrHash: hallTicket.qrHash,
            name: student.name,
            phone: student.phone,
            examCenter: slot.examCenter.name,
            hallTicketNumber: hallTicket.id,
            examTime: slot.date,
        };
    });

    logger.info(`Exam slot booked: student=${studentId} slot=${slotId}`);
    return result;
};

/**
 * Enable or disable booking for a slot.
 */
export const toggleSlotBooking = async (
    slotId: string,
    isBookingEnabled: boolean,
    userId?: string
) => {
    const slot = await prisma.examSlot.findUnique({ where: { id: slotId } });
    if (!slot) {
        throw new AppError(MESSAGES.ERROR.SLOT_NOT_FOUND, 404);
    }

    const updatedSlot = await prisma.examSlot.update({
        where: { id: slotId },
        data: { isBookingEnabled, updatedBy: userId },
        include: { examCenter: true },
    });

    logger.info(
        `Slot booking ${isBookingEnabled ? 'enabled' : 'disabled'}: slot=${slotId}`
    );
    return updatedSlot;
};

/**
 * Fetch all exam centers with their slots formatted for UI.
 */
export const getExamCenters = async () => {
    logger.info('[getExamCenters] Fetching all exam centers');
    const centers = await prisma.examCenter.findMany({ include: { examSlots: true } });
    logger.info(`[getExamCenters] Found ${centers.length} centers`);
    return centers.map(transformExamCenterWithSlots);
};

/**
 * Update an existing exam center with audit.
 */
export const updateExamCenter = async (id: string, data: any, userId?: string) => {
    logger.info(`[updateExamCenter] Updating center id=${id}`);
    const center = await prisma.examCenter.findUnique({ where: { id } });
    if (!center) {
        logger.warn(`[updateExamCenter] Center not found id=${id}`);
        throw new AppError(MESSAGES.ERROR.EXAM_CENTER_NOT_FOUND, 404);
    }

    const updatedCenter = await prisma.examCenter.update({
        where: { id },
        data: { ...data, updatedBy: userId },
    });
    logger.info(`[updateExamCenter] Successfully updated center id=${id}`);
    return updatedCenter;
};

/**
 * Delete an exam center (assuming no FK constraints prevent it).
 */
export const deleteExamCenter = async (id: string) => {
    logger.info(`[deleteExamCenter] Deleting center id=${id}`);
    const center = await prisma.examCenter.findUnique({ where: { id } });
    if (!center) {
        logger.warn(`[deleteExamCenter] Center not found id=${id}`);
        throw new AppError(MESSAGES.ERROR.EXAM_CENTER_NOT_FOUND, 404);
    }

    const result = await prisma.examCenter.update({
        where: { id },
        data: { isDeleted: true }
    });
    logger.info(`[deleteExamCenter] Successfully deleted center id=${id}`);
    return result;
};

/**
 * Fetch all exam slots for admin with their center info.
 */
export const getExamSlots = async () => {
    logger.info('[getExamSlots] Fetching all exam slots');
    const slots = await prisma.examSlot.findMany({
        include: { examCenter: true },
        orderBy: { date: 'asc' },
    });
    logger.info(`[getExamSlots] Found ${slots.length} slots`);
    return slots.map(transformSlot);
};

/**
 * Fetch all slots for a particular exam center.
 */
export const getExamSlotsByCenter = async (centerId: string) => {
    logger.info(`[getExamSlotsByCenter] Fetching slots for center=${centerId}`);
    const center = await prisma.examCenter.findUnique({
        where: { id: centerId },
        include: { examSlots: { orderBy: { date: 'asc' } } },
    });

    if (!center) {
        logger.warn(`[getExamSlotsByCenter] Center not found id=${centerId}`);
        throw new AppError(MESSAGES.ERROR.EXAM_CENTER_NOT_FOUND, 404);
    }

    logger.info(
        `[getExamSlotsByCenter] Found ${center.examSlots.length} slots for center=${centerId}`
    );
    return transformExamCenterWithSlots(center);
};

/**
 * Fetch a single exam slot with its center info.
 */
export const getExamSlot = async (id: string) => {
    const slot = await prisma.examSlot.findUnique({
        where: { id },
        include: { examCenter: true },
    });
    if (!slot) {
        logger.warn(`[getExamSlot] Slot not found id=${id}`);
        throw new AppError(MESSAGES.ERROR.SLOT_NOT_FOUND, 404);
    }
    return slot;
};

/**
 * Update an exam slot, ensuring capacity constraints and audits.
 */
export const updateExamSlot = async (id: string, data: any, userId?: string) => {
    const slot = await prisma.examSlot.findUnique({ where: { id } });
    if (!slot) throw new AppError(MESSAGES.ERROR.SLOT_NOT_FOUND, 404);

    if (data.capacity && data.capacity < slot.filled) {
        throw new AppError(MESSAGES.ERROR.CAPACITY_REDUCTION_ERROR, 400);
    }

    const updateData: any = { ...data };
    if (data.date) updateData.date = parseDate(data.date, 'date');
    if (data.startTime) updateData.startTime = parseDate(data.startTime, 'startTime');
    if (data.endTime) updateData.endTime = parseDate(data.endTime, 'endTime');

    if (data.capacity) {
        const center = await prisma.examCenter.findUnique({
            where: { id: slot.examCenterId },
            include: { examSlots: true },
        });

        if (!center) throw new AppError(MESSAGES.ERROR.EXAM_CENTER_NOT_FOUND, 404);

        const otherSlotsCapacity = center.examSlots
            .filter((s: any) => s.id !== id)
            .reduce((sum: number, s: any) => sum + s.capacity, 0);

        const newCapacity = Number(data.capacity);

        if (center.capacity && otherSlotsCapacity + newCapacity > center.capacity) {
            throw new AppError(
                `Cannot update slot. Total slot capacity (${
                    otherSlotsCapacity + newCapacity
                }) exceeds exam center capacity (${center.capacity})`,
                400
            );
        }
    }

    const updatedSlot = await prisma.examSlot.update({
        where: { id },
        data: { ...updateData, updatedBy: userId },
    });
    logger.info(`[updateExamSlot] Successfully updated slot id=${id}`);
    return updatedSlot;
};

/**
 * Delete an exam slot only if no students are booked.
 */
export const deleteExamSlot = async (id: string) => {
    logger.info(`[deleteExamSlot] Deleting slot id=${id}`);
    const slot = await prisma.examSlot.findUnique({ where: { id } });
    if (!slot) {
        logger.warn(`[deleteExamSlot] Slot not found id=${id}`);
        throw new AppError(MESSAGES.ERROR.SLOT_NOT_FOUND, 404);
    }

    if (slot.filled > 0) {
        logger.warn(
            `[deleteExamSlot] Cannot delete slot with booked students: id=${id} filled=${slot.filled}`
        );
        throw new AppError(MESSAGES.ERROR.SLOT_HAS_BOOKINGS, 400);
    }

    const result = await prisma.examSlot.update({
        where: { id },
        data: { isDeleted: true }
    });
    logger.info(`[deleteExamSlot] Successfully deleted slot id=${id}`);
    return result;
};

/**
 * Process bulk exam results from CSV content.
 */
export const processBulkResults = async (fileContent: string, cutoff: number) => {
    const { data, errors } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });

    if (errors.length > 0) throw new AppError(MESSAGES.ERROR.CSV_ERROR, 400);

    const results = [];
    const rows = data as any[];
    for (const row of rows) {
        try {
            const { applicationId, score } = row;
            const student = await prisma.student.findUnique({ where: { applicationId } });
            if (student) {
                const isQualified = Number(score) >= Number(cutoff);
                await prisma.studentExam.update({
                    where: { studentId: student.id },
                    data: { examScore: Number(score), isQualified }
                });
                results.push({ applicationId, status: 'Success' });
            } else {
                results.push({ applicationId, status: 'Failed', message: MESSAGES.ERROR.STUDENT_NOT_FOUND });
            }
        } catch (err: any) {
            results.push({ applicationId: row.applicationId, status: 'Failed', message: err.message });
        }
    }
    return results;
};
