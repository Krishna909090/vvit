import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../utils/catchAsync';
import { AppError } from '../utils/AppError';
import prisma from '../config/prisma';
import logger from '../utils/logger';
import { AdmissionStatus, DiscountStatus, Role, CancellationStatus, AccommodationType, HostelType, FeeStatus, RequestStatus, StudentDocumentStatus, AgentCommissionStatus } from '@prisma/client';
import { MESSAGES } from '../constants/messages';
import Papa from 'papaparse';
import { registerStudent } from '../services/studentService';
import fs from 'fs';
import archiver from 'archiver';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { sendResponse } from '../utils/response';

// Phase 3: Mark Attendance
export const markAttendance = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[markAttendance] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[markAttendance] payload=${JSON.stringify(req.body)}`);

    const { studentId, attended } = req.body;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    if (typeof attended !== 'boolean') throw new AppError(MESSAGES.ERROR.ATTENDED_BOOLEAN, 400);

    await prisma.$transaction([
        prisma.studentExam.update({
            where: { studentId },
            data: {
                examAttended: attended
            }
        }),
        prisma.studentAdmission.update({
            where: { studentId },
            data: {
                status: attended ? AdmissionStatus.EXAM_ATTENDED : AdmissionStatus.HALL_TICKET_GENERATED
            }
        })
    ]);

    const student = await prisma.student.findUnique({ where: { id: studentId } });

    logger.info(`[markAttendance] Attendance marked for ${student?.applicationId}: ${attended}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ATTENDANCE_MARKED
    });
});

// Phase 5: Verify Docs & Allot Seat
export const verifyAndAllotSeat = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[verifyAndAllotSeat] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[verifyAndAllotSeat] payload=${JSON.stringify(req.body)}`);

    const { studentId, approved, allottedBranch } = req.body;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    if (!approved) {
        // Reject logic (maybe reset status or custom status)
        logger.info(`[verifyAndAllotSeat] Documents rejected for student=${studentId}`);
        sendResponse({
            res,
            statusCode: 200,
            success: false,
            message: MESSAGES.ERROR.DOCUMENTS_REJECTED
        });
        return;
    }

    if (!allottedBranch) throw new AppError(MESSAGES.ERROR.ALLOTTED_BRANCH_REQUIRED, 400);

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) {
        logger.warn(`[verifyAndAllotSeat] student not found id=${studentId}`);
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    await prisma.$transaction(async (tx) => {
        await tx.studentAdmission.update({
            where: { studentId },
            data: {
                status: AdmissionStatus.SEAT_ALLOTTED,
                allottedBranch
            }
        });

        // Update branch seats
        const branch = await tx.branch.findUnique({ where: { code: allottedBranch } });
        if (branch) {
            await tx.branch.update({
                where: { code: allottedBranch },
                data: { filledSeats: { increment: 1 } }
            });
        }
        // Create Seat Allocation Record
        await tx.seatAllocation.create({
            data: {
                studentId,
                newBranch: allottedBranch,
                allocatedBy: req.user?.userId || 'ADMIN',
                notes: 'Initial Seat Allotment'
            }
        });
    });

    logger.info(`[verifyAndAllotSeat] Seat allotted for ${student.applicationId}: ${allottedBranch}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.SEAT_ALLOTTED
    });
});

// Request Branch Change (Admin)
export const requestBranchChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestBranchChange] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[requestBranchChange] payload=${JSON.stringify(req.body)}`);

    const { studentId, newBranch, reason } = req.body;
    const adminId = req.user?.userId || 'system';

    if (!studentId || !newBranch || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_NEWBRANCH_REASON_REQUIRED, 400);

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });

    if (!student || !student.admissionDetails?.allottedBranch) {
        logger.warn(`[requestBranchChange] student missing or no allotted branch id=${studentId}`);
        throw new AppError(MESSAGES.ERROR.STUDENT_NO_ALLOTTED_BRANCH, 400);
    }

    const oldBranch = student.admissionDetails.allottedBranch;

    // Create Request
    const request = await prisma.branchChangeRequest.create({
        data: {
            studentId,
            fromBranch: oldBranch,
            toBranch: newBranch,
            reason,
            status: RequestStatus.FORWARDED, // Forward to Super Admin
            forwardedTo: 'SUPER_ADMIN'
        }
    });

    logger.info(`[requestBranchChange] Branch change requested for ${student.applicationId} from ${oldBranch} to ${newBranch}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.BRANCH_CHANGE_FORWARDED,
        data: request
    });
});

// Approve Branch Change (Super Admin)
export const approveBranchChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveBranchChange] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[approveBranchChange] payload=${JSON.stringify(req.body)}`);

    const { requestId, approved } = req.body;
    const adminId = req.user?.userId;

    if (req.user?.role !== Role.SUPER_ADMIN) {
        throw new AppError(MESSAGES.ERROR.ONLY_SUPER_ADMIN_APPROVE_BRANCH, 403);
    }

    if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

    const request = await prisma.branchChangeRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppError(MESSAGES.ERROR.REQUEST_NOT_FOUND, 404);

    const status = approved ? RequestStatus.APPROVED : RequestStatus.REJECTED;

    await prisma.$transaction(async (tx) => {
        // Update Request
        await tx.branchChangeRequest.update({
            where: { id: requestId },
            data: {
                status,
                actionedBy: adminId,
                actionedAt: new Date()
            }
        });

        if (approved) {
            // Update Student Branch
            await tx.studentAdmission.update({
                where: { studentId: request.studentId },
                data: { allottedBranch: request.toBranch }
            });

            // Update Branch Seats (Decrement old, Increment new)
            await tx.branch.update({
                where: { code: request.fromBranch },
                data: { filledSeats: { decrement: 1 } }
            });
            await tx.branch.update({
                where: { code: request.toBranch },
                data: { filledSeats: { increment: 1 } }
            });

            // Log it
            await tx.branchChangeLog.create({
                data: {
                    studentId: request.studentId,
                    oldBranch: request.fromBranch,
                    newBranch: request.toBranch,
                    approvedBy: adminId || 'SUPER_ADMIN'
                }
            });
        }
    });

    logger.info(`[approveBranchChange] Request ${requestId} processed: ${status}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.BRANCH_CHANGE_PROCESSED
    });
});

// Create Discount Request (Admin)
export const createDiscountRequest = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[createDiscountRequest] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[createDiscountRequest] payload=${JSON.stringify(req.body)}`);

    const { studentId, reason, documentUrl } = req.body;
    if (!studentId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_REASON_REQUIRED, 400);

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) {
        logger.warn(`[createDiscountRequest] student not found id=${studentId}`);
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    const discountRequest = await prisma.discountRequest.create({
        data: {
            studentId,
            reason,
            documentUrl,
            status: DiscountStatus.FORWARDED_TO_SUPER_ADMIN // Admin creates it, so directly forward
        }
    });

    logger.info(`[createDiscountRequest] created requestId=${discountRequest.id} for student=${studentId}`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_REQUESTED,
        data: discountRequest
    });
});

// Discount Review (Admin)
export const reviewDiscountRequest = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[reviewDiscountRequest] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[reviewDiscountRequest] payload=${JSON.stringify(req.body)}`);

    const { requestId, remarks } = req.body;
    if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

    const request = await prisma.discountRequest.update({
        where: { id: requestId },
        data: {
            status: DiscountStatus.FORWARDED_TO_SUPER_ADMIN,
            remarks
        }
    });

    logger.info(`[reviewDiscountRequest] Discount request forwarded: ${requestId}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_FORWARDED
    });
});

// Discount Approval (Super Admin)
export const approveDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveDiscount] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[approveDiscount] payload=${JSON.stringify(req.body)}`);

    const { requestId, approved } = req.body;
    if (req.user?.role !== Role.SUPER_ADMIN) {
        logger.warn(`[approveDiscount] forbidden by user=${req.user?.userId}`);
        throw new AppError(MESSAGES.ERROR.ONLY_SUPER_ADMIN_APPROVE_DISCOUNT, 403);
    }

    if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

    const status = approved ? DiscountStatus.APPROVED : DiscountStatus.REJECTED;

    const request = await prisma.discountRequest.update({
        where: { id: requestId },
        data: { status }
    });

    logger.info(`[approveDiscount] Discount request ${requestId} ${status}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_PROCESSED
    });
});

// Dashboard Stats
export const getDashboardStats = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getDashboardStats] by=${req.user?.userId || 'anonymous'}`);
    const totalApplications = await prisma.student.count();
    const paidApplications = await prisma.studentAdmission.count({ where: { feeStatus: FeeStatus.FULL } });
    const pendingPayment = await prisma.studentAdmission.count({ where: { feeStatus: { not: FeeStatus.FULL } } });

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

    recentApplications.forEach(app => {
        const dateStr = app.createdAt.toISOString().split('T')[0];
        if (dayWiseSummary[dateStr] !== undefined) {
            dayWiseSummary[dateStr]++;
        }
    });

    const summaryArray = Object.entries(dayWiseSummary).map(([date, count]) => ({ date, count }));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: {
            totalApplications,
            paidApplications,
            pendingPayment,
            dayWiseSummary: summaryArray
        }
    });
});

// Get All Applications
export const getAllApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getAllApplications] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[getAllApplications] query=${JSON.stringify(req.query)}`);

    const { page = 1, limit = 10, search } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const where: any = {};
    if (search) {
        where.OR = [
            { name: { contains: String(search), mode: 'insensitive' } },
            { email: { contains: String(search), mode: 'insensitive' } },
            { phone: { contains: String(search), mode: 'insensitive' } },
            { applicationId: { contains: String(search), mode: 'insensitive' } }
        ];
    }

    const [students, total] = await prisma.$transaction([
        prisma.student.findMany({
            where,
            skip,
            take: Number(limit),
            orderBy: { createdAt: 'desc' },
            include: {
                admissionDetails: true,
                examDetails: true
            }
        }),
        prisma.student.count({ where })
    ]);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: {
            students,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / Number(limit))
            }
        }
    });
});

// Upload Bulk Applications
export const uploadBulkApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[uploadBulkApplications] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[uploadBulkApplications] file=${req.file?.originalname || 'n/a'}`);

    if (!req.file) {
        logger.warn('[uploadBulkApplications] no file uploaded');
        throw new AppError(MESSAGES.ERROR.NO_FILE_UPLOADED, 400);
    }

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    const { data, errors } = Papa.parse(fileContent, {
        header: true,
        skipEmptyLines: true
    });

    if (errors.length > 0) {
        throw new AppError(MESSAGES.ERROR.CSV_PARSE_ERROR, 400);
    }

    const students: any[] = data;
    const results = [];

    for (const studentData of students) {
        try {
            // Map CSV fields to Student model fields
            // Parse date DD/MM/YYYY to Date object
            // Handle various date formats if needed, but assuming DD/MM/YYYY
            let dob: Date;
            if (studentData.date_of_birth.includes('/')) {
                const [day, month, year] = studentData.date_of_birth.split('/');
                dob = new Date(`${year}-${month}-${day}`);
            } else {
                dob = new Date(studentData.date_of_birth);
            }

            const mappedData = {
                name: studentData.full_name,
                fatherName: studentData.father_name,
                motherName: studentData.mother_name,
                email: studentData.email,
                phone: studentData.mobile,
                gender: studentData.gender,
                dob: dob, // Ensure format is YYYY-MM-DD or parseable
                aadharNumber: studentData.aadhar_number,
                category: studentData.category,
                address: studentData.address,
                city: studentData.city,
                state: studentData.state,
                pincode: studentData.pincode,
                pref1: studentData.branch_preference_1,
                pref2: studentData.branch_preference_2,
                pref3: studentData.branch_preference_3,
                isOffline: true,
                courseType: studentData.course_type || 'B.Tech', // Default or from CSV
                profilePhotoUrl: studentData.profile_photo_url || 'https://via.placeholder.com/150', // Placeholder if missing
            };

            const student = await registerStudent(mappedData, null);
            results.push({ email: student.email, status: 'Success', id: student.applicationId });
        } catch (err: any) {
            results.push({ email: studentData.email, status: 'Failed', error: err.message });
        }
    }

    // Cleanup uploaded file
    try {
        fs.unlinkSync(req.file.path);
    } catch (e) {
        logger.warn(`[uploadBulkApplications] failed to delete temp file: ${e}`);
    }

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.BULK_UPLOAD_PROCESSED,
        data: results
    });
});

// Request Cancellation
export const requestCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestCancellation] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[requestCancellation] payload=${JSON.stringify(req.body)}`);

    const { studentId, reason, refundAmount } = req.body;
    if (!studentId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_REASON_REQUIRED, 400);

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) {
        logger.warn(`[requestCancellation] student not found id=${studentId}`);
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    const cancellation = await prisma.cancellationRequest.create({
        data: {
            studentId,
            reason,
            refundAmount: Number(refundAmount),
            status: CancellationStatus.REQUESTED
        }
    });

    logger.info(`[requestCancellation] cancellation requested id=${cancellation.id} for student=${studentId}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.CANCELLATION_REQUESTED,
        data: cancellation
    });
});

// Approve Cancellation (Super Admin)
export const approveCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveCancellation] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[approveCancellation] payload=${JSON.stringify(req.body)}`);

    const { requestId, approved } = req.body;
    const adminId = req.user?.userId;

    if (req.user?.role !== Role.SUPER_ADMIN) {
        logger.warn(`[approveCancellation] forbidden by user=${adminId}`);
        throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
    }

    if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

    const request = await prisma.cancellationRequest.findUnique({
        where: { id: requestId },
        include: { student: { include: { admissionDetails: true } } }
    });

    if (!request) {
        logger.warn(`[approveCancellation] request not found id=${requestId}`);
        throw new AppError(MESSAGES.ERROR.REQUEST_NOT_FOUND, 404);
    }

    const status = approved ? CancellationStatus.APPROVED : CancellationStatus.REJECTED;

    await prisma.$transaction(async (tx) => {
        await tx.cancellationRequest.update({
            where: { id: requestId },
            data: { status, approvedBy: adminId }
        });

        if (approved) {
            // Update student status
            await tx.studentAdmission.update({
                where: { studentId: request.studentId },
                data: { status: AdmissionStatus.CANCELLED }
            });

            // Update branch seats if allotted
            if (request.student.admissionDetails?.allottedBranch) {
                await tx.branch.update({
                    where: { code: request.student.admissionDetails.allottedBranch },
                    data: { filledSeats: { decrement: 1 } }
                });
            }
        }
    });

    logger.info(`[approveCancellation] request ${requestId} processed status=${status}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: approved ? MESSAGES.SUCCESS.CANCELLATION_APPROVED : MESSAGES.SUCCESS.CANCELLATION_REJECTED
    });
});

// Get Student Certificates
export const getStudentCertificates = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getStudentCertificates] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[getStudentCertificates] params=${JSON.stringify(req.params)}`);

    const { studentId } = req.params;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            documents: true,
            examDetails: true
        }
    });

    if (!student) {
        logger.warn(`[getStudentCertificates] student not found id=${studentId}`);
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    const docs = {
        profilePhotoUrl: student.profilePhotoUrl,
        hallTicketUrl: student.examDetails?.hallTicketUrl,
        ...student.documents.reduce((acc: any, doc) => {
            acc[doc.documentKey] = doc.url;
            return acc;
        }, {})
    };

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: docs
    });
});

// Update Exam Score (Admin)
export const updateExamScore = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateExamScore] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[updateExamScore] payload=${JSON.stringify(req.body)}`);

    const { studentId, score, cutoff } = req.body;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    if (score === undefined || cutoff === undefined) {
        throw new AppError(MESSAGES.ERROR.SCORE_CUTOFF_REQUIRED, 400);
    }

    const isQualified = Number(score) >= Number(cutoff);

    const examDetails = await prisma.studentExam.update({
        where: { studentId },
        data: {
            examScore: Number(score),
            isQualified
        }
    });

    logger.info(`[updateExamScore] Exam score updated for ${studentId}: ${score}, Qualified: ${isQualified}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.EXAM_SCORE_UPDATED,
        data: { score: examDetails.examScore, isQualified: examDetails.isQualified }
    });
});

// Download Student Documents as Zip
export const downloadStudentDocuments = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[downloadStudentDocuments] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[downloadStudentDocuments] params=${JSON.stringify(req.params)}`);

    const { studentId } = req.params;
    if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            documents: true,
            examDetails: true
        }
    });

    if (!student) {
        logger.warn(`[downloadStudentDocuments] student not found id=${studentId}`);
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    const documents = [
        { name: 'profile_photo', url: student.profilePhotoUrl },
        { name: 'hall_ticket', url: student.examDetails?.hallTicketUrl },
        ...student.documents.map(doc => ({ name: doc.documentKey, url: doc.url })),
        { name: 'discount_doc', url: (await prisma.discountRequest.findFirst({ where: { studentId } }))?.documentUrl }
    ].filter(doc => doc.url);

    if (documents.length === 0) {
        throw new AppError(MESSAGES.ERROR.NO_DOCUMENTS_FOUND, 400);
    }

    const zipFileName = `${student.applicationId}_documents.zip`;
    const zipFilePath = path.join(__dirname, `../../temp/${zipFileName}`);

    // Ensure temp directory exists
    if (!fs.existsSync(path.join(__dirname, '../../temp'))) {
        fs.mkdirSync(path.join(__dirname, '../../temp'), { recursive: true });
    }

    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
        res.download(zipFilePath, zipFileName, (err) => {
            if (err) logger.error(`Download error: ${err}`);
            fs.unlinkSync(zipFilePath); // Delete after download
        });
    });

    archive.on('error', (err) => {
        throw err;
    });

    archive.pipe(output);

    for (const doc of documents) {
        if (doc.url) {
            try {
                const response = await axios.get(doc.url, { responseType: 'stream' });
                const ext = path.extname(doc.url) || '.pdf'; // Default to pdf if no extension
                archive.append(response.data, { name: `${doc.name}${ext}` });
            } catch (err) {
                logger.error(`Failed to download ${doc.name} from ${doc.url}`);
            }
        }
    }

    await archive.finalize();
});

// Transport Route Management
export const createTransportRoute = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[createTransportRoute] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[createTransportRoute] payload=${JSON.stringify(req.body)}`);

    const { name, cost, busNumber, capacity } = req.body;
    const adminId = req.user?.userId;

    if (!name || cost === undefined || !busNumber || !capacity) {
        throw new AppError(MESSAGES.ERROR.TRANSPORT_FIELDS_REQUIRED, 400);
    }

    const route = await prisma.transportRoute.create({
        data: {
            name,
            cost: Number(cost),
            busNumber,
            capacity: Number(capacity),
            filled: 0,
            createdBy: adminId
        }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.TRANSPORT_ROUTE_CREATED,
        data: route
    });
});

export const getTransportRoutes = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getTransportRoutes] by=${req.user?.userId || 'anonymous'}`);
    const routes = await prisma.transportRoute.findMany();
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.TRANSPORT_ROUTES_FETCHED,
        data: routes
    });
});

// Update Admission Details (Accommodation & Fees)
export const updateAdmissionDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateAdmissionDetails] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[updateAdmissionDetails] payload=${JSON.stringify(req.body)}`);

    const { studentId, accommodationType, hostelType, hostelId, transportRouteId, paidAmount } = req.body;
    const adminId = req.user?.userId;

    if (!studentId || !accommodationType) throw new AppError(MESSAGES.ERROR.STUDENT_ACCOMMODATION_REQUIRED, 400);

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });
    if (!student || !student.admissionDetails) {
        logger.warn(`[updateAdmissionDetails] student not found id=${studentId}`);
        throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
    }

    const admission = student.admissionDetails;
    let totalFee = 125000; // Fixed Fees: Tuition(100k) + Admission(10k) + Skill(10k) + Book(5k)

    await prisma.$transaction(async (tx) => {
        // 1. Release previous allocation if exists
        if (admission.accommodationType === AccommodationType.HOSTEL && admission.hostelId) {
            // If changing to something else or a different hostel
            if (accommodationType !== AccommodationType.HOSTEL || hostelId !== admission.hostelId) {
                await tx.hostel.update({
                    where: { id: admission.hostelId },
                    data: { filled: { decrement: 1 }, updatedBy: adminId }
                });
            }
        } else if (admission.accommodationType === AccommodationType.TRANSPORT && admission.transportRouteId) {
            // If changing to something else or a different route
            if (accommodationType !== AccommodationType.TRANSPORT || transportRouteId !== admission.transportRouteId) {
                await tx.transportRoute.update({
                    where: { id: admission.transportRouteId },
                    data: { filled: { decrement: 1 }, updatedBy: adminId }
                });
            }
        }

        // 2. Assign new allocation
        if (accommodationType === AccommodationType.HOSTEL) {
            if (!hostelId) throw new AppError(MESSAGES.ERROR.HOSTEL_ID_REQUIRED, 400);

            if (hostelId !== admission.hostelId) {
                const hostel = await tx.hostel.findUnique({ where: { id: hostelId } });
                if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

                if (hostel.filled >= hostel.capacity) throw new AppError(MESSAGES.ERROR.HOSTEL_FULL, 400);

                await tx.hostel.update({
                    where: { id: hostelId },
                    data: { filled: { increment: 1 }, updatedBy: adminId }
                });
                totalFee += hostel.cost;
            } else {
                // Same hostel, just recalculate fee
                const hostel = await tx.hostel.findUnique({ where: { id: hostelId } });
                if (hostel) totalFee += hostel.cost;
            }
        }
        else if (accommodationType === AccommodationType.TRANSPORT) {
            if (!transportRouteId) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_ID_REQUIRED, 400);

            if (transportRouteId !== admission.transportRouteId) {
                const route = await tx.transportRoute.findUnique({ where: { id: transportRouteId } });
                if (!route) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_NOT_FOUND, 404);

                if (route.filled >= route.capacity) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_FULL, 400);

                await tx.transportRoute.update({
                    where: { id: transportRouteId },
                    data: { filled: { increment: 1 }, updatedBy: adminId }
                });
                totalFee += route.cost;
            } else {
                // Same route, just recalculate fee
                const route = await tx.transportRoute.findUnique({ where: { id: transportRouteId } });
                if (route) totalFee += route.cost;
            }
        }

        const currentPaid = admission.paidFee + Number(paidAmount || 0);
        let feeStatus: FeeStatus = FeeStatus.PENDING;
        if (currentPaid >= totalFee) feeStatus = FeeStatus.FULL;
        else if (currentPaid > 0) feeStatus = FeeStatus.PARTIAL;

        await tx.studentAdmission.update({
            where: { studentId },
            data: {
                accommodationType,
                hostelType: accommodationType === AccommodationType.HOSTEL ? hostelType : null,
                hostelId: accommodationType === AccommodationType.HOSTEL ? hostelId : null,
                transportRouteId: accommodationType === AccommodationType.TRANSPORT ? transportRouteId : null,
                totalFee,
                paidFee: currentPaid,
                feeStatus,
            }
        });
    });

    logger.info(`[updateAdmissionDetails] updated student=${studentId}`);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ADMISSION_DETAILS_UPDATED
    });
});

// Fee Statistics
export const getFeeStatistics = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
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

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.FEE_STATISTICS_FETCHED,
        data: {
            fullyPaid: { male: stats[0], female: stats[1] },
            partialPaid: { male: stats[2], female: stats[3] },
            hostel: { sharing4: stats[4], sharing8: stats[5] },
            stateWise: stateStats
        }
    });
});

// Add Admin (Super Admin)
export const addAdmin = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { phone, name, email } = req.body;
    // Check if user exists
    let user = await prisma.user.findUnique({ where: { phone } });
    if (user) {
        await prisma.user.update({
            where: { id: user.id },
            data: {
                role: Role.ADMIN,
                name: name || user.name,
                email: email || user.email
            }
        });
    } else {
        // Create new admin user
        user = await prisma.user.create({
            data: {
                phone,
                name,
                email,
                role: Role.ADMIN
            }
        });
    }
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ADMIN_ADDED
    });
});

// Generate Invigilator Credentials
export const generateInvigilatorCredentials = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[generateInvigilatorCredentials] by=${req.user?.userId || 'anonymous'}`);
    const { count, validFrom, validUntil } = req.body;
    const adminId = req.user?.userId;

    if (!count || !validFrom || !validUntil) {
        throw new AppError(MESSAGES.ERROR.COUNT_VALID_FROM_UNTIL_REQUIRED, 400);
    }

    const credentials = [];
    for (let i = 0; i < Number(count); i++) {
        const token = uuidv4().substring(0, 8).toUpperCase(); // Simple 8 char token
        credentials.push({
            adminId: adminId || 'system',
            token,
            validFrom: new Date(validFrom),
            validUntil: new Date(validUntil)
        });
    }

    await prisma.invigilatorCredential.createMany({ data: credentials });

    logger.info(`Generated ${count} invigilator credentials`);
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.CREDENTIALS_GENERATED,
        data: credentials
    });
});


// Get Agent Commissions
export const getAgentCommissions = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { agentId } = req.query;
    const where: any = {};
    if (agentId) where.agentId = String(agentId);

    const commissions = await prisma.agentCommission.findMany({
        where,
        include: { agent: true, student: true }
    });
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.COMMISSIONS_FETCHED,
        data: commissions
    });
});

// Upload Bulk Results
export const uploadBulkResults = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.file) throw new AppError(MESSAGES.ERROR.NO_FILE_UPLOADED, 400);
    const { cutoff } = req.body;
    if (!cutoff) throw new AppError(MESSAGES.ERROR.CUTOFF_REQUIRED, 400);

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
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
    fs.unlinkSync(req.file.path);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.BULK_RESULTS_PROCESSED,
        data: results
    });
});

// Hostel Management
export const createHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, type, capacity, cost, blockName, roomNumber } = req.body;
    const adminId = req.user?.userId;

    if (!name || !type || !capacity || !cost) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

    const hostel = await prisma.hostel.create({
        data: {
            name,
            type,
            capacity: Number(capacity),
            cost: Number(cost),
            blockName,
            roomNumber,
            filled: 0,
            createdBy: adminId
        }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_CREATED,
        data: hostel
    });
});

// Create Branch
export const createBranch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { code, name, totalSeats } = req.body;
    const adminId = req.user?.userId;

    if (!code || !name || !totalSeats) throw new AppError(MESSAGES.ERROR.CODE_NAME_SEATS_REQUIRED, 400);

    const branch = await prisma.branch.create({
        data: {
            code,
            name,
            totalSeats: Number(totalSeats),
            filledSeats: 0,
            createdBy: adminId
        }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.BRANCH_CREATED,
        data: branch
    });
});

export const getHostels = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const hostels = await prisma.hostel.findMany();
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.HOSTELS_FETCHED,
        data: hostels
    });
});

export const updateHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { hostelId } = req.params;
    const { filled } = req.body;

    const hostel = await prisma.hostel.update({
        where: { id: hostelId },
        data: { filled: Number(filled) }
    });
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_UPDATED,
        data: hostel
    });
});

// --- ERP CONTROLLERS ---

// Academics
export const createDepartment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, code } = req.body;
    const adminId = req.user?.userId;
    const department = await prisma.department.create({
        data: { name, code, createdBy: adminId }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.DEPARTMENT_CREATED,
        data: department
    });
});

export const createProgram = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, departmentId } = req.body;
    const adminId = req.user?.userId;
    const program = await prisma.program.create({
        data: { name, departmentId, createdBy: adminId }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.PROGRAM_CREATED,
        data: program
    });
});

export const createBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, programId, startDate, endDate } = req.body;
    const adminId = req.user?.userId;
    const batch = await prisma.batch.create({
        data: {
            name,
            programId,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            createdBy: adminId
        }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.BATCH_CREATED,
        data: batch
    });
});

export const createSection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, batchId } = req.body;
    const adminId = req.user?.userId;
    const section = await prisma.section.create({
        data: { name, batchId, createdBy: adminId }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.SECTION_CREATED,
        data: section
    });
});

// Hostel (Detailed)
export const createHostelBlock = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { hostelId, name, type } = req.body;
    const adminId = req.user?.userId;
    const block = await prisma.hostelBlock.create({
        data: { hostelId, name, type, createdBy: adminId }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_BLOCK_CREATED,
        data: block
    });
});

export const createHostelRoom = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { blockId, number, capacity, type } = req.body;
    const adminId = req.user?.userId;

    const room = await prisma.hostelRoom.create({
        data: { blockId, number, capacity: Number(capacity), type, createdBy: adminId }
    });

    // Auto-create beds
    const beds = [];
    for (let i = 1; i <= Number(capacity); i++) {
        beds.push({
            roomId: room.id,
            number: `${number}-${String.fromCharCode(64 + i)}`, // e.g., 101-A
            createdBy: adminId
        });
    }
    await prisma.hostelBed.createMany({ data: beds });

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.HOSTEL_ROOM_BEDS_CREATED,
        data: room
    });
});

// Transport (Detailed)
export const createVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { number, capacity, driverName, driverPhone } = req.body;
    const adminId = req.user?.userId;
    const vehicle = await prisma.vehicle.create({
        data: { number, capacity: Number(capacity), driverName, driverPhone, createdBy: adminId }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.VEHICLE_CREATED,
        data: vehicle
    });
});

export const createTransportStop = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { routeId, name, sequence, pickupTime, dropTime } = req.body;
    const adminId = req.user?.userId;
    const stop = await prisma.transportStop.create({
        data: {
            routeId,
            name,
            sequence: Number(sequence),
            pickupTime: new Date(pickupTime),
            dropTime: new Date(dropTime),
            createdBy: adminId
        }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.TRANSPORT_STOP_CREATED,
        data: stop
    });
});

// Academic Year
export const createAcademicYear = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { code, startDate, endDate, isActive } = req.body;
    const adminId = req.user?.userId;

    const academicYear = await prisma.academicYear.create({
        data: {
            code,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            isActive: isActive !== undefined ? isActive : true,
            createdBy: adminId
        }
    });

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.ACADEMIC_YEAR_CREATED,
        data: academicYear
    });
});

// Finance
export const createFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, description } = req.body;
    const adminId = req.user?.userId;
    const feeHead = await prisma.feeHead.create({
        data: { name, description, createdBy: adminId }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.FEE_HEAD_CREATED,
        data: feeHead
    });
});

export const createFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { programId, feeHeadId, amount, academicYearId } = req.body;
    const adminId = req.user?.userId;
    const feeStructure = await prisma.feeStructure.create({
        data: {
            programId,
            feeHeadId,
            amount: Number(amount),
            academicYearId,
            createdBy: adminId
        }
    });
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.FEE_STRUCTURE_CREATED,
        data: feeStructure
    });
});

export const verifyStudentDocument = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { documentKey, status, remarks } = req.body;

    if (!studentId || !documentKey || !status) {
        throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);
    }

    const existingDoc = await prisma.studentDocument.findUnique({
        where: {
            studentId_documentKey: {
                studentId,
                documentKey
            }
        }
    });

    if (!existingDoc) {
        throw new AppError(MESSAGES.ERROR.DOCUMENT_NOT_FOUND, 404);
    }

    const doc = await prisma.studentDocument.update({
        where: {
            studentId_documentKey: {
                studentId,
                documentKey
            }
        },
        data: {
            status: status as StudentDocumentStatus,
            remarks
        }
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DOCUMENT_VERIFIED,
        data: doc
    });
});
// --- CRUD Operations for Master Data ---

// Department
export const getDepartments = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const departments = await prisma.department.findMany({ include: { programs: true } });
    sendResponse({ res, statusCode: 200, success: true, data: departments });
});

export const updateDepartment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, code } = req.body;
    const department = await prisma.department.findUnique({ where: { id } });
    if (!department) throw new AppError(MESSAGES.ERROR.DEPARTMENT_NOT_FOUND, 404);

    const updatedDepartment = await prisma.department.update({
        where: { id },
        data: { name, code, updatedBy: req.user?.userId }
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.DEPARTMENT_UPDATED, data: updatedDepartment });
});

export const deleteDepartment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const department = await prisma.department.findUnique({ where: { id } });
    if (!department) throw new AppError(MESSAGES.ERROR.DEPARTMENT_NOT_FOUND, 404);

    await prisma.department.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.DEPARTMENT_DELETED });
});

// Program
export const getPrograms = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { departmentId } = req.query;
    const where: any = {};
    if (departmentId) {
        where.departmentId = String(departmentId);
    }
    const programs = await prisma.program.findMany({
        where,
        include: { department: true, batches: true }
    });
    sendResponse({ res, statusCode: 200, success: true, data: programs });
});

export const updateProgram = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, departmentId } = req.body;
    const program = await prisma.program.findUnique({ where: { id } });
    if (!program) throw new AppError(MESSAGES.ERROR.PROGRAM_NOT_FOUND, 404);

    const updatedProgram = await prisma.program.update({
        where: { id },
        data: { name, departmentId, updatedBy: req.user?.userId }
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.PROGRAM_UPDATED, data: updatedProgram });
});

export const deleteProgram = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const program = await prisma.program.findUnique({ where: { id } });
    if (!program) throw new AppError(MESSAGES.ERROR.PROGRAM_NOT_FOUND, 404);

    await prisma.program.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.PROGRAM_DELETED });
});

// Branch
export const getBranches = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const branches = await prisma.branch.findMany();
    sendResponse({ res, statusCode: 200, success: true, data: branches });
});

export const updateBranch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { code, name, totalSeats } = req.body;
    const branch = await prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new AppError(MESSAGES.ERROR.BRANCH_NOT_FOUND, 404);

    const updatedBranch = await prisma.branch.update({
        where: { id },
        data: { code, name, totalSeats: Number(totalSeats), updatedBy: req.user?.userId }
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.BRANCH_UPDATED, data: updatedBranch });
});

export const deleteBranch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const branch = await prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new AppError(MESSAGES.ERROR.BRANCH_NOT_FOUND, 404);

    await prisma.branch.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.BRANCH_DELETED });
});

// Fee Head
export const getFeeHeads = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const feeHeads = await prisma.feeHead.findMany();
    sendResponse({ res, statusCode: 200, success: true, data: feeHeads });
});

export const updateFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, description } = req.body;
    const feeHead = await prisma.feeHead.findUnique({ where: { id } });
    if (!feeHead) throw new AppError(MESSAGES.ERROR.FEE_HEAD_NOT_FOUND, 404);

    const updatedFeeHead = await prisma.feeHead.update({
        where: { id },
        data: { name, description, updatedBy: req.user?.userId }
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_HEAD_UPDATED, data: updatedFeeHead });
});

export const deleteFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const feeHead = await prisma.feeHead.findUnique({ where: { id } });
    if (!feeHead) throw new AppError(MESSAGES.ERROR.FEE_HEAD_NOT_FOUND, 404);

    await prisma.feeHead.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_HEAD_DELETED });
});

// Fee Structure
export const getFeeStructures = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const feeStructures = await prisma.feeStructure.findMany({
        include: { program: true, feeHead: true, academicYear: true }
    });
    sendResponse({ res, statusCode: 200, success: true, data: feeStructures });
});

export const updateFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { programId, feeHeadId, amount, academicYearId } = req.body;
    const feeStructure = await prisma.feeStructure.findUnique({ where: { id } });
    if (!feeStructure) throw new AppError(MESSAGES.ERROR.FEE_STRUCTURE_NOT_FOUND, 404);

    const updatedFeeStructure = await prisma.feeStructure.update({
        where: { id },
        data: {
            programId,
            feeHeadId,
            amount: Number(amount),
            academicYearId,
            updatedBy: req.user?.userId
        }
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_STRUCTURE_UPDATED, data: updatedFeeStructure });
});

export const deleteFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const feeStructure = await prisma.feeStructure.findUnique({ where: { id } });
    if (!feeStructure) throw new AppError(MESSAGES.ERROR.FEE_STRUCTURE_NOT_FOUND, 404);

    await prisma.feeStructure.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_STRUCTURE_DELETED });
});

// Academic Year
export const getAcademicYears = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const academicYears = await prisma.academicYear.findMany({ orderBy: { startDate: 'desc' } });
    sendResponse({ res, statusCode: 200, success: true, data: academicYears });
});

export const updateAcademicYear = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { code, startDate, endDate, isActive } = req.body;
    const data: any = { code, updatedBy: req.user?.userId };
    if (startDate) data.startDate = new Date(startDate);
    if (endDate) data.endDate = new Date(endDate);
    if (isActive !== undefined) data.isActive = isActive;

    const academicYear = await prisma.academicYear.findUnique({ where: { id } });
    if (!academicYear) throw new AppError(MESSAGES.ERROR.ACADEMIC_YEAR_NOT_FOUND, 404);

    const updatedAcademicYear = await prisma.academicYear.update({
        where: { id },
        data
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.ACADEMIC_YEAR_UPDATED, data: updatedAcademicYear });
});

export const deleteAcademicYear = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const academicYear = await prisma.academicYear.findUnique({ where: { id } });
    if (!academicYear) throw new AppError(MESSAGES.ERROR.ACADEMIC_YEAR_NOT_FOUND, 404);

    await prisma.academicYear.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.ACADEMIC_YEAR_DELETED });
});

// Batch
export const getBatches = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { programId } = req.query;
    const where: any = {};
    if (programId) where.programId = String(programId);

    const batches = await prisma.batch.findMany({
        where,
        include: { program: true },
        orderBy: { startDate: 'desc' }
    });
    sendResponse({ res, statusCode: 200, success: true, data: batches });
});

export const updateBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, programId, startDate, endDate } = req.body;
    const data: any = { name, programId, updatedBy: req.user?.userId };
    if (startDate) data.startDate = new Date(startDate);
    if (endDate) data.endDate = new Date(endDate);

    const batch = await prisma.batch.findUnique({ where: { id } });
    if (!batch) throw new AppError(MESSAGES.ERROR.BATCH_NOT_FOUND, 404);

    const updatedBatch = await prisma.batch.update({
        where: { id },
        data
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.BATCH_UPDATED, data: updatedBatch });
});

export const deleteBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const batch = await prisma.batch.findUnique({ where: { id } });
    if (!batch) throw new AppError(MESSAGES.ERROR.BATCH_NOT_FOUND, 404);

    await prisma.batch.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.BATCH_DELETED });
});

// Section
export const getSections = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { batchId } = req.query;
    const where: any = {};
    if (batchId) where.batchId = String(batchId);

    const sections = await prisma.section.findMany({
        where,
        include: { batch: true }
    });
    sendResponse({ res, statusCode: 200, success: true, data: sections });
});

export const updateSection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, batchId } = req.body;
    const section = await prisma.section.findUnique({ where: { id } });
    if (!section) throw new AppError(MESSAGES.ERROR.SECTION_NOT_FOUND, 404);

    const updatedSection = await prisma.section.update({
        where: { id },
        data: { name, batchId, updatedBy: req.user?.userId }
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.SECTION_UPDATED, data: updatedSection });
});

export const deleteSection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const section = await prisma.section.findUnique({ where: { id } });
    if (!section) throw new AppError(MESSAGES.ERROR.SECTION_NOT_FOUND, 404);

    await prisma.section.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.SECTION_DELETED });
});

// Hostel Block
export const getHostelBlocks = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { hostelId } = req.query;
    const where: any = {};
    if (hostelId) where.hostelId = String(hostelId);

    const blocks = await prisma.hostelBlock.findMany({ where, include: { hostel: true } });
    sendResponse({ res, statusCode: 200, success: true, data: blocks });
});

export const updateHostelBlock = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, type, hostelId } = req.body;
    const block = await prisma.hostelBlock.findUnique({ where: { id } });
    if (!block) throw new AppError(MESSAGES.ERROR.HOSTEL_BLOCK_NOT_FOUND, 404);

    const updatedBlock = await prisma.hostelBlock.update({
        where: { id },
        data: { name, type, hostelId, updatedBy: req.user?.userId }
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.HOSTEL_BLOCK_UPDATED, data: updatedBlock });
});

export const deleteHostelBlock = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const block = await prisma.hostelBlock.findUnique({ where: { id } });
    if (!block) throw new AppError(MESSAGES.ERROR.HOSTEL_BLOCK_NOT_FOUND, 404);

    await prisma.hostelBlock.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.HOSTEL_BLOCK_DELETED });
});

// Hostel Room
export const getHostelRooms = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { blockId } = req.query;
    const where: any = {};
    if (blockId) where.blockId = String(blockId);

    const rooms = await prisma.hostelRoom.findMany({ where, include: { block: true } });
    sendResponse({ res, statusCode: 200, success: true, data: rooms });
});

export const updateHostelRoom = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { number, capacity, type, blockId } = req.body;
    const room = await prisma.hostelRoom.findUnique({ where: { id } });
    if (!room) throw new AppError(MESSAGES.ERROR.HOSTEL_ROOM_NOT_FOUND, 404);

    const updatedRoom = await prisma.hostelRoom.update({
        where: { id },
        data: {
            number,
            capacity: capacity ? Number(capacity) : undefined,
            type,
            blockId,
            updatedBy: req.user?.userId
        }
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.HOSTEL_ROOM_UPDATED, data: updatedRoom });
});

export const deleteHostelRoom = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const room = await prisma.hostelRoom.findUnique({ where: { id } });
    if (!room) throw new AppError(MESSAGES.ERROR.HOSTEL_ROOM_NOT_FOUND, 404);

    await prisma.hostelRoom.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.HOSTEL_ROOM_DELETED });
});

// Vehicle
export const getVehicles = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const vehicles = await prisma.vehicle.findMany();
    sendResponse({ res, statusCode: 200, success: true, data: vehicles });
});

export const updateVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { number, capacity, driverName, driverPhone } = req.body;
    const vehicle = await prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);

    const updatedVehicle = await prisma.vehicle.update({
        where: { id },
        data: {
            number,
            capacity: capacity ? Number(capacity) : undefined,
            driverName,
            driverPhone,
            updatedBy: req.user?.userId
        }
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.VEHICLE_UPDATED, data: updatedVehicle });
});

export const deleteVehicle = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const vehicle = await prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new AppError(MESSAGES.ERROR.VEHICLE_NOT_FOUND, 404);

    await prisma.vehicle.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.VEHICLE_DELETED });
});

// Transport Stop
export const getTransportStops = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { routeId } = req.query;
    const where: any = {};
    if (routeId) where.routeId = String(routeId);

    const stops = await prisma.transportStop.findMany({
        where,
        include: { route: true },
        orderBy: { sequence: 'asc' }
    });
    sendResponse({ res, statusCode: 200, success: true, data: stops });
});

export const updateTransportStop = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, sequence, pickupTime, dropTime, routeId } = req.body;
    const data: any = { name, routeId, updatedBy: req.user?.userId };
    if (sequence !== undefined) data.sequence = Number(sequence);
    if (pickupTime) data.pickupTime = new Date(pickupTime);
    if (dropTime) data.dropTime = new Date(dropTime);

    const stop = await prisma.transportStop.findUnique({ where: { id } });
    if (!stop) throw new AppError(MESSAGES.ERROR.TRANSPORT_STOP_NOT_FOUND, 404);

    const updatedStop = await prisma.transportStop.update({
        where: { id },
        data
    });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.TRANSPORT_STOP_UPDATED, data: updatedStop });
});

export const deleteTransportStop = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const stop = await prisma.transportStop.findUnique({ where: { id } });
    if (!stop) throw new AppError(MESSAGES.ERROR.TRANSPORT_STOP_NOT_FOUND, 404);

    await prisma.transportStop.delete({ where: { id } });
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.TRANSPORT_STOP_DELETED });
});
