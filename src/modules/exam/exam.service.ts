

import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { AdmissionStatus } from '@prisma/client';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import Papa from 'papaparse';
import QRCode from 'qrcode';
import { encrypt, decrypt } from '../../utils/encryption';
import { formatDate, formatTime, formatDateTime } from '../../utils/dateFormatter';
import { generateHallTicketPDF } from '../../utils/pdfGenerator';
import { uploadFileToS3, getPresignedUrl, convertToPresignedUrl } from '../../utils/s3Utils';
import { sendHallTicketEmail } from '../../utils/emailService';

const parseDate = (value: string | Date, fieldName: string): Date => {
    let d: Date;
    if (value instanceof Date) {
        d = value;
    } else {
        const strVal = String(value).trim();

        const hasTimezone = strVal.toUpperCase().includes('Z') || /[+-]\d{1,2}:?\d{2}$/.test(strVal);

        if (!hasTimezone && strVal.length > 10) { 
            d = new Date(`${strVal}+05:30`);
        } else {
            d = new Date(value);
        }
    }

    if (Number.isNaN(d.getTime())) {
        throw new AppError(`${fieldName} is invalid date`, 400);
    }
    return d;
};

const assertPositiveInt = (value: any, fieldName: string) => {
    const num = Number(value);
    if (!Number.isInteger(num) || num <= 0) {
        throw new AppError(`${fieldName} must be a positive integer`, 400);
    }
    return num;
};

const transformExamCenterWithSlots = (center: any) => {
    return {
        ...center,
        slots: center.examSlots.map((slot: any) => ({
            id: slot.id,
            examCenterId: center.id,
            examCenterName: center.name,
            capacity: slot.capacity,
            filled: slot.filled,
            isBookingEnabled: slot.isBookingEnabled,
            date: formatDate(slot.date), 
            startTime: formatTime(slot.startTime),
            endTime: formatTime(slot.endTime),
        })),
        examSlots: undefined,
    };
};

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

export const markAttendanceByScan = async (qrHash: string, userId: string) => {
    if (!qrHash || !qrHash.trim()) {
        throw new AppError(MESSAGES.ERROR.QR_HASH_REQUIRED, 400);
    }

    let decryptedContent: string;
    try {
        decryptedContent = decrypt(qrHash);
        logger.info(`[markAttendanceByScan] Successfully decrypted QR for user=${userId}`);
    } catch (e) {
        logger.error(`[markAttendanceByScan] Decryption failed for user=${userId}: ${e}`);
        throw new AppError('Invalid or corrupted QR code', 400);
    }

    let studentId, centerId, slotId;
    try {

        const params = new URLSearchParams(decryptedContent);
        studentId = params.get('s');
        centerId = params.get('c');
        slotId = params.get('sl');

    } catch (e) {
        logger.warn(`[markAttendanceByScan] Failed to parse decrypted QR content: ${decryptedContent}`);
    }

    const hallTicket = await prisma.hallTicket.findFirst({
        where: { qrHash },
        include: { 
            student: { 
                include: { 
                    examDetails: { 
                        include: { 
                            examSlot: {
                                include: {
                                    examCenter: true
                                }
                            }
                        } 
                    } 
                } 
            } 
        },
    });

    if (!hallTicket) {
        throw new AppError(MESSAGES.ERROR.INVALID_QR, 400);
    }

    if (studentId && hallTicket.studentId !== studentId) {
         throw new AppError(MESSAGES.ERROR.INVALID_QR + ' (Student Mismatch)', 400);
    }

    const student = hallTicket.student;

    if (centerId && slotId) {
        if (student.examDetails?.examSlotId !== slotId) {
             throw new AppError('Student is not assigned to this slot', 400);
        }
        if (student.examDetails?.examSlot?.examCenterId !== centerId) {
             throw new AppError('Student is not assigned to this center', 400);
        }
    }

    const skipDateValidation = process.env.SKIP_DATE_VALIDATION === 'true';
    
    if (!skipDateValidation) {
        if (student.examDetails?.testDate) {
            const today = new Date();
            const examDate = new Date(student.examDetails.testDate);

            const todayStr = today.toISOString().split('T')[0];
            const examDateStr = examDate.toISOString().split('T')[0];

            if (todayStr !== examDateStr) {
                throw new AppError(`Cannot scan: Exam is scheduled for ${examDateStr}, not today (${todayStr})`, 400);
            }
        } else if (student.examDetails?.examSlot?.date) {
             const today = new Date();
             const examDate = new Date(student.examDetails.examSlot.date);
              const todayStr = today.toISOString().split('T')[0];
              const examDateStr = examDate.toISOString().split('T')[0];

              if (todayStr !== examDateStr) {
                  throw new AppError(`Cannot scan: Exam is scheduled for ${examDateStr}, not today (${todayStr})`, 400);
              }
        }
    } else {
        logger.warn(`[markAttendanceByScan] Date validation skipped for testing (user=${userId})`);
    }

    const existingRecord = await prisma.attendanceRecord.findFirst({
        where: {
            studentId: student.id,
            verified: true
        }
    });

    if (existingRecord) {
        throw new AppError('Attendance already verified for this student', 400);
    }

    const attendanceRecord = await prisma.attendanceRecord.upsert({
        where: {

            id: 'dummy-will-create-new'
        },
        create: {
            studentId: student.id,
            invigilatorId: userId,
            scannedAt: new Date(),
            verified: false,
            createdBy: userId,
        },
        update: {
            scannedAt: new Date(),
            invigilatorId: userId,
        }
    }).catch(async () => {

        return await prisma.attendanceRecord.create({
            data: {
                studentId: student.id,
                invigilatorId: userId,
                scannedAt: new Date(),
                verified: false,
                createdBy: userId,
            }
        });
    });

    logger.info(`QR scanned for student=${student.id} by user=${userId}, awaiting verification`);

    return {
        attendanceRecordId: attendanceRecord.id,
        student: {
            id: student.id,
            name: student.name,
            applicationId: student.applicationId,
            phone: student.phone,
            email: student.email,
            profilePhotoUrl: await convertToPresignedUrl(student.profilePhotoUrl),
            fatherName: student.fatherName,
            dob: student.dob,
        },
        examDetails: {
            examCenter: student.examDetails?.examSlot?.examCenter?.name,
            examCenterAddress: student.examDetails?.examSlot?.examCenter?.address,
            examDate: student.examDetails?.testDate ? formatDate(student.examDetails.testDate) : null,
            startTime: student.examDetails?.examSlot?.startTime ? formatTime(student.examDetails.examSlot.startTime) : null,
            endTime: student.examDetails?.examSlot?.endTime ? formatTime(student.examDetails.examSlot.endTime) : null,
        },
        message: 'Student details retrieved. Please verify and call verify API to mark attendance.'
    };
};

export const verifyStudentAttendance = async (attendanceRecordId: string, userId: string) => {
    if (!attendanceRecordId || !attendanceRecordId.trim()) {
        throw new AppError('Attendance record ID is required', 400);
    }

    const attendanceRecord = await prisma.attendanceRecord.findUnique({
        where: { id: attendanceRecordId },
        include: {
            student: {
                include: {
                    examDetails: {
                        include: {
                            examSlot: {
                                include: {
                                    examCenter: true
                                }
                            }
                        }
                    },
                    admissionDetails: true
                }
            }
        }
    });

    if (!attendanceRecord) {
        throw new AppError('Attendance record not found', 404);
    }

    if (attendanceRecord.invigilatorId !== userId) {
        throw new AppError('Unauthorized: You can only verify records you scanned', 403);
    }

    if (attendanceRecord.verified) {
        throw new AppError('Attendance already verified', 400);
    }

    const student = attendanceRecord.student;

    if (student.examDetails?.examAttended) {
        throw new AppError(MESSAGES.ERROR.ATTENDANCE_ALREADY_MARKED, 400);
    }

    if (!student.examDetails?.examSlotId) {
        throw new AppError('Student does not have an exam slot assigned', 400);
    }

    const validStatuses: AdmissionStatus[] = [
        AdmissionStatus.ENTRANCE_FEE_PAID,
        AdmissionStatus.EXAM_SCHEDULED
    ];
    
    if (!student.admissionDetails || !student.admissionDetails.status || !validStatuses.includes(student.admissionDetails.status)) {
        throw new AppError(
            `Student admission status (${student.admissionDetails?.status}) is not eligible for exam attendance. Must be TEST_FEE_PAID or HALL_TICKET_GENERATED.`,
            400
        );
    }

    const skipDateValidation = process.env.SKIP_DATE_VALIDATION === 'true';
    
    if (!skipDateValidation) {
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        
        let examDateStr: string | null = null;

        if (student.examDetails.testDate) {
            const examDate = new Date(student.examDetails.testDate);
            examDateStr = examDate.toISOString().split('T')[0];
        } else if (student.examDetails.examSlot?.date) {
            const examDate = new Date(student.examDetails.examSlot.date);
            examDateStr = examDate.toISOString().split('T')[0];
        }
        
        if (!examDateStr) {
            throw new AppError('Student exam date not found. Cannot verify attendance.', 400);
        }
        
        if (todayStr !== examDateStr) {
            throw new AppError(
                `Cannot verify attendance: Exam is scheduled for ${examDateStr}, not today (${todayStr}). Attendance can only be marked on the exam date.`,
                400
            );
        }
    } else {
        logger.warn(`[verifyStudentAttendance] Date validation skipped for testing (user=${userId})`);
    }

    if (student.examDetails.examSlot) {
        const examSlot = student.examDetails.examSlot;

        const currentSlot = await prisma.examSlot.findUnique({
            where: { id: examSlot.id }
        });
        
        if (!currentSlot) {
            throw new AppError('Exam slot no longer exists', 400);
        }
        
        if (currentSlot.isDeleted) {
            throw new AppError('Exam slot has been deleted', 400);
        }
    }

    const scanTime = new Date(attendanceRecord.scannedAt ?? new Date());
    const now = new Date();
    const hoursSinceScan = (now.getTime() - scanTime.getTime()) / (1000 * 60 * 60);

    if (hoursSinceScan > 24) {
        throw new AppError(
            `Cannot verify: QR code was scanned ${Math.floor(hoursSinceScan)} hours ago. Please scan again.`,
            400
        );
    }

    await prisma.$transaction([
        prisma.attendanceRecord.update({
            where: { id: attendanceRecordId },
            data: {
                verified: true,
                verifiedAt: new Date(),
                updatedBy: userId,
            },
        }),
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
    ]);

    logger.info(`Attendance verified and marked for student=${student.id} by user=${userId} after strict validation`);
    const verifiedAt = new Date();
    return { 
        message: `Attendance marked for ${student.name} (${student.applicationId})`,
        studentId: student.id,
        studentName: student.name,
        applicationId: student.applicationId,
        verifiedAt: formatDateTime(verifiedAt),
        examDate: student.examDetails.testDate || null,
        examCenter: student.examDetails.examSlot?.examCenter?.name
    };
};

export const markAttendanceManually = async (studentId: string, attended: boolean, adminId: string | undefined) => {
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    if (typeof attended !== 'boolean') throw new AppError(MESSAGES.ERROR.ATTENDED_BOOLEAN, 400);

    await prisma.$transaction([
        prisma.studentExam.update({
            where: { studentId },
            data: {
                examAttended: attended,

            }
        }),
        prisma.studentAdmission.update({
            where: { studentId },
            data: {

                status: attended ? AdmissionStatus.EXAM_ATTENDED : AdmissionStatus.EXAM_SCHEDULED,

            }
        })
    ]);

    logger.info(`[markAttendanceManually] Attendance marked for ${studentId}: ${attended} by ${adminId}`);
};

export const updateStudentExamScore = async (studentId: string, score: number, cutoff: number, adminId: string | undefined) => {
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    if (score === undefined || cutoff === undefined) {
        throw new AppError(MESSAGES.ERROR.SCORE_CUTOFF_REQUIRED, 400);
    }

    const isQualified = Number(score) >= Number(cutoff);

    await prisma.$transaction(async (tx) => {
        await tx.studentExam.update({
            where: { studentId },
            data: {
                examScore: Number(score),
                isQualified
            }
        });

        const student = await tx.student.findUnique({
             where: { id: studentId },
             select: { applicationId: true }
        });

        await tx.academicQualification.create({
            data: {
                studentId,
                level: 'VVITAT',
                gpaOrMarks: score.toString(),
                board: 'VVIT',
                yearOfPassing: new Date().getFullYear().toString(),
                hallTicketNumber: student?.applicationId || 'UNKNOWN',
                percentage: Number(score),
                createdBy: adminId,
                updatedBy: adminId
            }
        });

        if (isQualified) {
            await tx.studentAdmission.update({
                where: { studentId },
                data: { status: AdmissionStatus.EXAM_QUALIFIED }
            });
        } else {
             await tx.studentAdmission.update({
                where: { studentId },
                data: { status: AdmissionStatus.EXAM_NOT_QUALIFIED }
            });
        }
    });

    logger.info(`[updateStudentExamScore] Exam score updated for ${studentId}: ${score}, Qualified: ${isQualified}, Status: ${isQualified ? 'EXAM_QUALIFIED' : 'EXAM_NOT_QUALIFIED'}`);
    return { score: Number(score), isQualified };
};

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

    const potentialOverlaps = await prisma.examSlot.findMany({
        where: {
            examCenterId,
            isDeleted: false,

             startTime: {
                lt: endTime 
            },
            endTime: {
                gt: startTime
            }
        }
    });

    if (potentialOverlaps.length > 0) {
         logger.warn(
            `[createExamSlot] Slot conflict in center=${examCenterId}. Overlaps with ${potentialOverlaps.length} existing slot(s). New: ${startTime.toISOString()}-${endTime.toISOString()}`
        );
        throw new AppError(
            MESSAGES.ERROR.EXAM_SLOT_EXISTS || 'Exam slot time overlaps with an existing slot',
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
        include: {
            examCenter: true
        }
    });
    logger.info(`Exam slot created: ${slot.id} at ${slot.examCenterId}`);

    return {
        id: slot.id,
        examCenterId: slot.examCenterId,
        examCenterName: slot.examCenter.name,
        date: formatDate(slot.date),
        startTime: formatTime(slot.startTime),
        endTime: formatTime(slot.endTime),
        capacity: slot.capacity,
        filled: slot.filled,
        isBookingEnabled: slot.isBookingEnabled,
        createdAt: formatDateTime(slot.createdAt),
        isDeleted: slot.isDeleted
    };
};

export const getAvailableSlots = async () => {

    const slots = await prisma.examSlot.findMany({
        where: {
            date: {
                gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
            isBookingEnabled: true,
            isDeleted: false,
            examCenter: {
                isDeleted: false,
            },
        },
        include: {
            examCenter: true,
        },
        orderBy: [
            { date: 'asc' },
            { startTime: 'asc' }
        ],
    });

    const availableSlots = slots.filter((slot: any) => slot.filled < slot.capacity);

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

export const bookExamSlot = async (studentId: string, slotId: string, userId?: string) => {
    if (!studentId || !slotId) {
        throw new AppError(MESSAGES.ERROR.STUDENT_ID_SLOT_ID_REQUIRED, 400);
    }

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true },
    });
    if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

    const existingExam = await prisma.studentExam.findUnique({
        where: { studentId },
    });

    if (existingExam?.examSlotId) {
        throw new AppError(
            MESSAGES.ERROR.SLOT_ALREADY_BOOKED || 'Student already has a slot booked',
            409
        );
    }

    const result = await prisma.$transaction(async (tx) => {
        const slot = await tx.examSlot.findUnique({
            where: { id: slotId },
            include: { examCenter: true },
        });
        if (!slot) throw new AppError(MESSAGES.ERROR.SLOT_NOT_FOUND, 404);

        if ((slot.filled ?? 0) >= slot.capacity) {
            throw new AppError(MESSAGES.ERROR.SLOT_FULL, 400);
        }

        const now = new Date();
        const skipDateValidation = process.env.SKIP_DATE_VALIDATION === 'true';
        
        if (!skipDateValidation) {
            if (slot.startTime < now) {
                throw new AppError(
                    MESSAGES.ERROR.SLOT_IN_PAST,
                    400
                );
            }

            const oneDayInMs = 24 * 60 * 60 * 1000;
            if (slot.startTime.getTime() - now.getTime() < oneDayInMs) {
                throw new AppError(
                    "Booking closed. You must book your slot at least 24 hours in advance.",
                    400
                );
            }
        }

        await tx.examSlot.update({
            where: { id: slotId },
            data: {
                filled: { increment: 1 },
                updatedBy: userId,
            },
        });

        const uniqueHash = uuidv4();

        const plainContent = `s=${studentId}&c=${slot.examCenterId}&sl=${slotId}&h=${uniqueHash}`;

        const encryptedContent = encrypt(plainContent);

        await tx.studentExam.upsert({
            where: { studentId },
            update: {
                examSlotId: slotId,
                testDate: slot.date,
                testCenter: slot.examCenter.name,
            },
            create: {
                studentId,
                examSlotId: slotId,
                testDate: slot.date,
                testCenter: slot.examCenter.name,
            }
        });

        const protectedStatuses: AdmissionStatus[] = [
            AdmissionStatus.SEAT_ALLOTTED,
            AdmissionStatus.ADMISSION_CONFIRMED,
            AdmissionStatus.ENROLLED,
            AdmissionStatus.CANCELLED
        ];
        const currentAdmission = await tx.studentAdmission.findUnique({ where: { studentId } });
        const shouldUpdateStatus = !currentAdmission || !protectedStatuses.includes(currentAdmission.status as AdmissionStatus);

        const examYear = await tx.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });
        await tx.studentAdmission.upsert({
            where: { studentId },
            update: {
                ...(shouldUpdateStatus ? { status: AdmissionStatus.EXAM_SCHEDULED } : {}),
            },
            create: {
                studentId,
                academicYearId: examYear.id,
                status: AdmissionStatus.EXAM_SCHEDULED,
            }
        });

        const existingHallTicket = await tx.hallTicket.findFirst({
            where: { studentId },
            orderBy: { generatedAt: 'desc' }
        });

        const hallTicket = existingHallTicket
            ? await tx.hallTicket.update({
                where: { id: existingHallTicket.id },
                data: {
                    qrHash: encryptedContent,
                    url: null,
                    updatedBy: userId,
                }
            })
            : await tx.hallTicket.create({
                data: {
                    studentId,
                    academicYearId: examYear.id,
                    qrHash: encryptedContent,
                    url: null,
                    createdBy: userId,
                },
            });

        return {
            slot,
            encryptedContent,
            hallTicketId: hallTicket.id,
            uniqueHash
        };
    });

    let qrCodeImage = '';
    let hallTicketUrl: string | null = null;
    
    try {
        const qrCodeBuffer = await QRCode.toBuffer(result.encryptedContent);
        qrCodeImage = `data:image/png;base64,${qrCodeBuffer.toString('base64')}`;

        let profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl, 300) || '';

        const pdfBuffer = await generateHallTicketPDF({
            studentName: student.name || '',
            applicationId: student.applicationId || '',
            rollNumber: student.applicationId || '',
            fatherName: student.fatherName || '',
            motherName: student.motherName || '',
            examCenterName: result.slot.examCenter.name || '',
            examCenterAddress: result.slot.examCenter.address || '',
            examDate: formatDate(result.slot.date) || '',
            startTime: formatTime(result.slot.startTime) || '',
            endTime: formatTime(result.slot.endTime) || '',
            profilePhotoUrl: profilePhotoUrl,
            qrCodeBuffer: qrCodeBuffer,
            session: 'Entrance Exam 2026',
            program: student.degreeType || 'B.Tech'
        });
        
        const key = `students/${studentId}/hall_tickets/${slotId}_${Date.now()}.pdf`;
        const rawS3Url = await uploadFileToS3(pdfBuffer, key, 'application/pdf');

        if (rawS3Url) {
            await prisma.hallTicket.update({
                where: { id: result.hallTicketId },
                data: { url: rawS3Url }
            });

            try {
                hallTicketUrl = await getPresignedUrl(key, 3600);
            } catch (err) {
                logger.warn(`Failed to generate presigned URL after upload: ${err}`);
                hallTicketUrl = rawS3Url;
            }
        }

        if (student.email) {
            try {
                await sendHallTicketEmail(
                     student.email,
                     {
                         studentName: student.name,
                         applicationId: student.applicationId || '',
                         examDate: formatDate(result.slot.date) || '',
                         startTime: formatTime(result.slot.startTime) || '',
                         examCenterName: result.slot.examCenter.name || '',
                         examCenterAddress: result.slot.examCenter.address || 'Refer Hall Ticket for Address',
                     },
                     pdfBuffer
                 );
                 logger.info(`[bookExamSlot] Hall Ticket email sent to ${student.email}`);
            } catch (emailErr) {
                logger.error(`[bookExamSlot] Failed to send Hall Ticket email: ${emailErr}`);

            }
        }

    } catch (e) {

        logger.error(`[bookExamSlot] Failed to generate/upload PDF for student ${studentId}. Slot is booked but ticket missing URL. Error: ${e}`);

    }

    logger.info(`Exam slot booked: student=${studentId} slot=${slotId}`);
    
    return {

        studentId,
        name: student.name,
        firstName: student.name.split(' ')[0],
        lastName: student.name.split(' ').slice(1).join(' ') || student.name,
        phone: student.phone,
        email: student.email,
        profilePhotoUrl: student.profilePhotoUrl,
        applicationId: student.applicationId,

        slotId,
        examCenter: result.slot.examCenter.name,
        examCenterAddress: result.slot.examCenter.address,
        examCenterCity: result.slot.examCenter.city,
        examDate: formatDate(result.slot.date),
        examDay: new Date(result.slot.date).toLocaleDateString('en-US', { weekday: 'long' }),
        startTime: formatTime(result.slot.startTime),
        endTime: formatTime(result.slot.endTime),

        hallTicketNumber: result.hallTicketId,
        qrCodeImage,
        qrHash: result.encryptedContent,
        hallTicketUrl
    };
};

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

export const getExamCenters = async () => {
    logger.info('[getExamCenters] Fetching all exam centers');
    const centers = await prisma.examCenter.findMany({
        where: { isDeleted: false },
        include: {
            examSlots: {
                where: { isDeleted: false },
                orderBy: { date: 'asc' },
            },
        },
    });
    logger.info(`[getExamCenters] Found ${centers.length} centers`);
    return centers.map(transformExamCenterWithSlots);
};

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

export const getExamSlots = async () => {
    logger.info('[getExamSlots] Fetching all exam slots');
    const slots = await prisma.examSlot.findMany({
        where: {
            isDeleted: false,
            examCenter: {
                isDeleted: false,
            },
        },
        include: { examCenter: true },
        orderBy: { date: 'asc' },
    });
    logger.info(`[getExamSlots] Found ${slots.length} slots`);
    return slots.map(transformSlot);
};

export const getExamSlotsByCenter = async (centerId: string) => {
    logger.info(`[getExamSlotsByCenter] Fetching slots for center=${centerId}`);
    const center = await prisma.examCenter.findUnique({
        where: { id: centerId, isDeleted: false },
        include: {
            examSlots: {
                where: { isDeleted: false },
                orderBy: { date: 'asc' },
            },
        },
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

export const updateExamSlot = async (id: string, data: any, userId?: string) => {
    const slot = await prisma.examSlot.findUnique({ where: { id } });
    if (!slot) throw new AppError(MESSAGES.ERROR.SLOT_NOT_FOUND, 404);

    if (data.capacity && data.capacity < (slot.filled ?? 0)) {
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

export const deleteExamSlot = async (id: string) => {
    logger.info(`[deleteExamSlot] Deleting slot id=${id}`);
    const slot = await prisma.examSlot.findUnique({ where: { id } });
    if (!slot) {
        logger.warn(`[deleteExamSlot] Slot not found id=${id}`);
        throw new AppError(MESSAGES.ERROR.SLOT_NOT_FOUND, 404);
    }

    if ((slot.filled ?? 0) > 0) {
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

export const processBulkResults = async (fileContent: string, cutoff: number) => {
    const { data, errors } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });

    if (errors.length > 0) throw new AppError(MESSAGES.ERROR.CSV_ERROR, 400);

    const results = [];
    const rows = data as any[];

    const applicationIds = rows.map((row: any) => row.applicationId).filter(Boolean);

    const students = await prisma.student.findMany({
        where: { applicationId: { in: applicationIds } },
        select: { id: true, applicationId: true }
    });

    const studentMap = new Map(students.map(s => [s.applicationId, s.id]));

    const updatePromises = [];
    
    for (const row of rows) {
        try {
            const { applicationId, score } = row;
            const studentId = studentMap.get(applicationId);
            
            if (studentId) {
                const isQualified = Number(score) >= Number(cutoff);

                updatePromises.push(
                    prisma.studentExam.update({
                        where: { studentId },
                        data: { examScore: Number(score), isQualified }
                    }).then(() => ({ applicationId, status: 'Success' }))
                    .catch((err: any) => ({ applicationId, status: 'Failed', message: err.message }))
                );
            } else {
                results.push({ applicationId, status: 'Failed', message: MESSAGES.ERROR.STUDENT_NOT_FOUND });
            }
        } catch (err: any) {
            results.push({ applicationId: row.applicationId, status: 'Failed', message: err.message });
        }
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < updatePromises.length; i += BATCH_SIZE) {
        const batch = updatePromises.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
    }
    
    logger.info(`[processBulkResults] Processed ${rows.length} records: ${results.filter(r => r.status === 'Success').length} success, ${results.filter(r => r.status === 'Failed').length} failed`);
    
    return results;
};

export const processBulkResultsJSON = async (records: { applicationId: string; score: number; status: string }[]) => {
    const results: any[] = [];

    const applicationIds = records.map(r => r.applicationId).filter(Boolean);

    const students = await prisma.student.findMany({
        where: { applicationId: { in: applicationIds } },
        select: { id: true, applicationId: true }
    });

    const studentMap = new Map(students.map(s => [s.applicationId, s.id]));

    const studentIds = students.map(s => s.id);
    const examRecords = await prisma.studentExam.findMany({
        where: { studentId: { in: studentIds } },
        select: { studentId: true, examAttended: true }
    });
    const examMap = new Map(examRecords.map(e => [e.studentId, e.examAttended]));

    const updatePromises: Promise<any>[] = [];

    for (const row of records) {
        const { applicationId, score, status: qualStatus } = row;
        const studentId = studentMap.get(applicationId);

        if (!studentId) {
            results.push({ ...row, result: 'Failed', message: 'Student not found' });
            continue;
        }

        if (!examMap.get(studentId)) {
            results.push({ ...row, result: 'Failed', message: 'Student has not attended the exam' });
            continue;
        }

        const numScore = Number(score);
        if (isNaN(numScore)) {
            results.push({ ...row, result: 'Failed', message: 'Invalid score value' });
            continue;
        }

        const upperStatus = (qualStatus || '').toUpperCase().trim();
        if (upperStatus !== 'Q' && upperStatus !== 'NQ') {
            results.push({ ...row, result: 'Failed', message: 'Status must be "Q" (Qualified) or "NQ" (Not Qualified)' });
            continue;
        }

        const isQualified = upperStatus === 'Q';

        updatePromises.push(
            (async () => {
                try {

                    await prisma.studentExam.update({
                        where: { studentId },
                        data: { examScore: numScore, isQualified }
                    });

                    const existingVvitat = await prisma.academicQualification.findFirst({
                        where: { studentId, level: 'VVITAT' }
                    });

                    if (existingVvitat) {
                        await prisma.academicQualification.update({
                            where: { id: existingVvitat.id },
                            data: {
                                percentage: null,
                                board: 'VVITU',
                                gpaOrMarks: String(numScore),
                                hallTicketNumber: applicationId,
                                verificationStatus: 'APPROVED'
                            }
                        });
                    } else {
                        await prisma.academicQualification.create({
                            data: {
                                studentId,
                                level: 'VVITAT',
                                board: 'VVITU',
                                yearOfPassing: new Date().getFullYear().toString(),
                                percentage: null,
                                gpaOrMarks: String(numScore),
                                hallTicketNumber: applicationId,
                                verificationStatus: 'APPROVED'
                            }
                        });
                    }

                    return { ...row, result: 'Success' };
                } catch (err: any) {
                    return { ...row, result: 'Failed', message: err.message };
                }
            })()
        );
    }

    const BATCH_SIZE = 50;
    for (let i = 0; i < updatePromises.length; i += BATCH_SIZE) {
        const batch = updatePromises.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
    }

    logger.info(`[processBulkResultsJSON] Processed ${records.length} records: ${results.filter(r => r.status === 'Success').length} success, ${results.filter(r => r.status === 'Failed').length} failed`);

    return results;
};

export const getStudentsByAdmissionStatus = async (status: AdmissionStatus) => {
    logger.info(`[getStudentsByAdmissionStatus] Fetching students for status=${status}`);

    const statusChain: AdmissionStatus[] = [];
    
    switch (status) {
        case AdmissionStatus.EXAM_SCHEDULED:
            statusChain.push(
                AdmissionStatus.EXAM_SCHEDULED,
                AdmissionStatus.ENTRANCE_FEE_PAID,
                AdmissionStatus.REGISTERED
            );
            break;
        case AdmissionStatus.ENTRANCE_FEE_PAID:
            statusChain.push(
                AdmissionStatus.ENTRANCE_FEE_PAID,
                AdmissionStatus.REGISTERED
            );
            break;
        case AdmissionStatus.EXAM_ATTENDED:
            statusChain.push(
                AdmissionStatus.EXAM_ATTENDED,
                AdmissionStatus.EXAM_SCHEDULED,
                AdmissionStatus.ENTRANCE_FEE_PAID,
                AdmissionStatus.REGISTERED
            );
            break;
        case AdmissionStatus.DOCUMENTS_SUBMITTED:
            statusChain.push(
                AdmissionStatus.DOCUMENTS_SUBMITTED,
                AdmissionStatus.EXAM_ATTENDED,
                AdmissionStatus.EXAM_SCHEDULED,
                AdmissionStatus.ENTRANCE_FEE_PAID,
                AdmissionStatus.REGISTERED
            );
            break;
        case AdmissionStatus.SEAT_ALLOTTED:
            statusChain.push(
                AdmissionStatus.SEAT_ALLOTTED,
                AdmissionStatus.DOCUMENTS_SUBMITTED,
                AdmissionStatus.EXAM_ATTENDED,
                AdmissionStatus.EXAM_SCHEDULED,
                AdmissionStatus.ENTRANCE_FEE_PAID,
                AdmissionStatus.REGISTERED
            );
            break;
        case AdmissionStatus.ADMISSION_CONFIRMED:
            statusChain.push(
                AdmissionStatus.ADMISSION_CONFIRMED,
                AdmissionStatus.SEAT_ALLOTTED,
                AdmissionStatus.DOCUMENTS_SUBMITTED,
                AdmissionStatus.EXAM_ATTENDED,
                AdmissionStatus.EXAM_SCHEDULED,
                AdmissionStatus.ENTRANCE_FEE_PAID,
                AdmissionStatus.REGISTERED
            );
            break;
        default:

            statusChain.push(status);
    }
    
    const students = await prisma.student.findMany({
        where: {
            admissionDetails: {
                status: {
                    in: statusChain
                }
            }
        },
        include: {
            admissionDetails: true,
            examDetails: {
                include: {
                    examSlot: {
                        include: {
                            examCenter: true
                        }
                    }
                }
            },
            user: {
                select: {
                    id: true,
                    name: true,
                    email: true,
                    phone: true,
                    role: true
                }
            }
        },
        orderBy: {
            createdAt: 'desc'
        }
    });
    
    logger.info(`[getStudentsByAdmissionStatus] Found ${students.length} students for status=${status} (including progression chain)`);
    
    return {
        requestedStatus: status,
        includedStatuses: statusChain,
        count: students.length,
        students: students.map(student => ({
            id: student.id,
            applicationId: student.applicationId,
            name: student.name,
            email: student.email,
            phone: student.phone,
            currentStatus: student.admissionDetails?.status,
            examAttended: student.examDetails?.examAttended || false,
            examScore: student.examDetails?.examScore,
            isQualified: student.examDetails?.isQualified,
            examCenter: student.examDetails?.examSlot?.examCenter?.name,
            examDate: student.examDetails?.testDate || null,
            createdAt: formatDateTime(student.createdAt)
        }))
    };
};

export const getHallTicketDetails = async (studentId: string) => {
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            examDetails: {
                include: {
                    examSlot: {
                        include: {
                            examCenter: true
                        }
                    }
                }
            }
        }
    });

    if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

    if (!student.examDetails?.examSlot) {
        throw new AppError('Student does not have an exam slot booked', 404);
    }

    const hallTicket = await prisma.hallTicket.findFirst({
        where: { studentId },
        orderBy: { generatedAt: 'desc' }
    });

    if (!hallTicket) {
        throw new AppError('Hall ticket not found', 404);
    }

    let qrCodeImage = '';
    if (hallTicket.qrHash) {
        try {
            qrCodeImage = await QRCode.toDataURL(hallTicket.qrHash);
        } catch (e) {
            logger.error(`Failed to regenerate QR code for student ${studentId}: ${e}`);
        }
    }

    let hallTicketDownloadUrl = await convertToPresignedUrl(hallTicket.url);

    const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);

    const slot = student.examDetails.examSlot;

    return {

        studentId,
        name: student.name,
        firstName: student.name.split(' ')[0],
        lastName: student.name.split(' ').slice(1).join(' ') || student.name,
        phone: student.phone,
        email: student.email,
        profilePhotoUrl,
        applicationId: student.applicationId,

        slotId: slot.id,
        examCenter: slot.examCenter.name,
        examCenterAddress: slot.examCenter.address,
        examCenterCity: slot.examCenter.city,
        examDate: formatDate(slot.date),
        examDay: new Date(slot.date).toLocaleDateString('en-US', { weekday: 'long' }),
        startTime: formatTime(slot.startTime),
        endTime: formatTime(slot.endTime),

        hallTicketNumber: hallTicket.id,
        qrCodeImage,
        qrHash: hallTicket.qrHash,
        hallTicketDownloadUrl
    };
};

export const markAttendanceByApplicationId = async (applicationId: string, userId: string) => {
    if (!applicationId || !applicationId.trim()) {
        throw new AppError('Application ID is required', 400);
    }

    const student = await prisma.student.findUnique({
        where: { applicationId },
        include: {
            examDetails: {
                include: {
                    examSlot: {
                        include: {
                            examCenter: true
                        }
                    }
                }
            }
        }
    });

    if (!student) {
        throw new AppError('Student not found with this Application ID', 404);
    }

    if (!student.examDetails || !student.examDetails.examSlot) {
         throw new AppError('Student does not have an assigned exam slot', 400);
    }

    const skipDateValidation = process.env.SKIP_DATE_VALIDATION === 'true';
    
    if (!skipDateValidation) {
        if (student.examDetails?.testDate) {
            const today = new Date();
            const examDate = new Date(student.examDetails.testDate);
            
            const todayStr = today.toISOString().split('T')[0];
            const examDateStr = examDate.toISOString().split('T')[0];

            if (todayStr !== examDateStr) {
                throw new AppError(`Cannot scan: Exam is scheduled for ${examDateStr}, not today (${todayStr})`, 400);
            }
        } else if (student.examDetails?.examSlot?.date) {
             const today = new Date();
             const examDate = new Date(student.examDetails.examSlot.date);
              const todayStr = today.toISOString().split('T')[0];
              const examDateStr = examDate.toISOString().split('T')[0];

              if (todayStr !== examDateStr) {
                  throw new AppError(`Cannot scan: Exam is scheduled for ${examDateStr}, not today (${todayStr})`, 400);
              }
        }
    } else {
        logger.warn(`[markAttendanceByApplicationId] Date validation skipped for testing (user=${userId})`);
    }

    const existingRecord = await prisma.attendanceRecord.findFirst({
        where: {
            studentId: student.id,
            verified: true
        }
    });

    if (existingRecord) {
        throw new AppError('Attendance already verified for this student', 400);
    }

    const attendanceRecord = await prisma.attendanceRecord.create({
        data: {
            studentId: student.id,
            invigilatorId: userId,
            scannedAt: new Date(),
            verified: false,
            createdBy: userId,
        }
    });

    logger.info(`Manual ApplicationId scan for student=${student.id} by user=${userId}`);

    return {
        attendanceRecordId: attendanceRecord.id,
        student: {
            id: student.id,
            name: student.name,
            applicationId: student.applicationId,
            phone: student.phone,
            email: student.email,
            profilePhotoUrl: await convertToPresignedUrl(student.profilePhotoUrl),
            fatherName: student.fatherName,
            dob: student.dob,
        },
        examDetails: {
            examCenter: student.examDetails?.examSlot?.examCenter?.name,
            examCenterAddress: student.examDetails?.examSlot?.examCenter?.address,
            examDate: student.examDetails?.testDate ? formatDate(student.examDetails.testDate) : null,
            startTime: student.examDetails?.examSlot?.startTime ? formatTime(student.examDetails.examSlot.startTime) : null,
            endTime: student.examDetails?.examSlot?.endTime ? formatTime(student.examDetails.examSlot.endTime) : null,
        },
        message: 'Student details retrieved. Please verify and call verify API to mark attendance.'
    };
};
