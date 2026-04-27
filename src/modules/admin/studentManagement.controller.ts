import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { AdminStudentService } from './adminStudent.service';
import * as StudentService from '../student/student.service';
import prisma from '../../config/prisma';
import { Role } from '../../constants/roles';
import fs from 'fs';
import path from 'path';

// Export Applications as CSV
export const exportApplicationsCsv = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[exportApplicationsCsv] by=${req.user?.userId || 'anonymous'}`);
    const csv = await AdminStudentService.exportApplicationsCsv(req.query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=applications.csv');
    res.send(csv);
});

// Get All Applications
export const getAllApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getAllApplications] by=${req.user?.userId || 'anonymous'}`);
    logger.debug && logger.debug(`[getAllApplications] query=${JSON.stringify(req.query)}`);

    const result = await AdminStudentService.getAllApplications(req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

// Get Expanded Applications (with filters)
export const getApplicationsExtended = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getApplicationsExtended] by=${req.user?.userId || 'anonymous'}`);
    const result = await AdminStudentService.getApplicationsExtended(req.query);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

// Upload Bulk Applications
export const uploadBulkApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[uploadBulkApplications] by=${req.user?.userId || 'anonymous'}`);

    if (!req.file) {
        logger.warn('[uploadBulkApplications] no file uploaded');
        throw new AppError(MESSAGES.ERROR.NO_FILE_UPLOADED, 400);
    }

    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    
    try {
        const results = await AdminStudentService.processBulkApplications(fileContent, req.user?.userId);
        
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: MESSAGES.SUCCESS.BULK_UPLOAD_PROCESSED,
            data: results
        });
    } finally {
        try {
            fs.unlinkSync(req.file.path);
        } catch (e) {
            logger.warn(`[uploadBulkApplications] failed to delete temp file: ${e}`);
        }
    }
});

// Request Cancellation
export const requestCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestCancellation] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, reason, refundAmount } = req.body;
    
    const cancellation = await AdminStudentService.requestCancellation(studentId, reason, refundAmount);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.CANCELLATION_REQUESTED,
        data: cancellation
    });
});

// Approve Cancellation
export const approveCancellation = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveCancellation] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, approved } = req.body;
    
    // Logic for role check handled in service or here? Logic for role is access control.
    // Service has check: if (adminRole !== Role.SUPER_ADMIN).
    // So pass role to service.
    
    const result = await AdminStudentService.approveCancellation(requestId, approved, req.user?.role, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: approved ? MESSAGES.SUCCESS.CANCELLATION_APPROVED : MESSAGES.SUCCESS.CANCELLATION_REJECTED
    });
});

// Verify Docs & Allot Seat
export const verifyAndAllotSeat = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[verifyAndAllotSeat] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, approved, allottedCourseId } = req.body;
    
    const result = await AdminStudentService.verifyAndAllotSeat(studentId, approved, allottedCourseId, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: result.success,
        message: result.message
    });
});

// Re-upload a single document on behalf of a student
export const reUploadDocument = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { documentKey, url } = req.body;

    if (!documentKey || !url) throw new AppError('documentKey and url are required', 400);

    const doc = await StudentService.reUploadDocument(studentId, documentKey, url);

    logger.info(`[admin.reUploadDocument] studentId=${studentId} documentKey=${documentKey}`);
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FILE_UPLOADED, data: doc });
});

// Verify Student Document
export const verifyStudentDocument = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { documentKey, status, remarks } = req.body;

    const doc = await AdminStudentService.verifyStudentDocument(studentId, documentKey, status, remarks);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DOCUMENT_VERIFIED,
        data: doc
    });
});

// Request Course Change (generic)
export const requestCourseChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestCourseChange] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, newCourseId, reason } = req.body;
    
    const request = await AdminStudentService.requestCourseChange(studentId, newCourseId, reason);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.COURSE_CHANGE_FORWARDED,
        data: request
    });
});

// Request Branch Change (same program, different branch)
export const requestBranchChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestBranchChange] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, newCourseId, reason, recommendedByManagement, branchChangeFee } = req.body;

    const request = await AdminStudentService.requestBranchChange(studentId, newCourseId, reason, recommendedByManagement, branchChangeFee);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Branch change request forwarded for approval',
        data: request
    });
});

// Request Program Change (cross-program transfer, e.g. B.Tech → BBA)
export const requestProgramChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[requestProgramChange] by=${req.user?.userId || 'anonymous'}`);

    const { studentId, newCourseId, reason } = req.body;

    const request = await AdminStudentService.requestProgramChange(studentId, newCourseId, reason);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Program change request forwarded for approval',
        data: request
    });
});

// Approve Course Change
export const approveCourseChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveCourseChange] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, approved, recommendedByManagement, branchChangeFee } = req.body;

    await AdminStudentService.approveCourseChange(requestId, approved, req.user?.role, req.user?.userId, recommendedByManagement, branchChangeFee);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.COURSE_CHANGE_PROCESSED
    });
});

// Debug: Inspect raw allotments for a course
export const debugCourseAllotments = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[debugCourseAllotments] by=${req.user?.userId || 'anonymous'}`);
    const { courseId } = req.params;
    const result = await AdminStudentService.debugCourseAllotments(courseId);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Debug data fetched',
        data: result
    });
});

// Get Course Change Requests
export const getCourseChangeRequests = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getCourseChangeRequests] by=${req.user?.userId || 'anonymous'}`);

    const result = await AdminStudentService.getCourseChangeRequests(req.query);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

// Update Admission Details
export const updateAdmissionDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateAdmissionDetails] by=${req.user?.userId || 'anonymous'}`);

    await AdminStudentService.updateAdmissionDetails(req.body, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.ADMISSION_DETAILS_UPDATED
    });
});

// Bulk-allocate vacant beds in a single room to a list of students
export const bulkAllocateRoomBeds = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { roomId, studentIds, hostelPaymentMode, academicYearId } = req.body;
    logger.info(`[bulkAllocateRoomBeds] roomId=${roomId} count=${studentIds?.length} mode=${hostelPaymentMode} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot bulk-allocate beds', 403);
    }

    const result = await AdminStudentService.bulkAllocateRoomBeds(
        roomId, studentIds, hostelPaymentMode, academicYearId, req.user?.userId
    );

    sendResponse({
        res,
        statusCode: result.success ? 200 : 400,
        success: result.success,
        message: result.success
            ? `Allocated ${result.allocated} student(s) to room ${result.roomNumber}`
            : 'Pre-validation failed — no students were allocated',
        data: result
    });
});

// Re-assign a student to a different hostel/bed AFTER initial bed allocation
export const reassignHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { hostelId, bedId, hostelPaymentMode, reason } = req.body;
    logger.info(`[reassignHostel] studentId=${studentId} hostelId=${hostelId} bedId=${bedId} mode=${hostelPaymentMode} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot reassign their own hostel', 403);
    }

    const result = await AdminStudentService.reassignHostel(
        studentId,
        { hostelId, bedId, hostelPaymentMode, reason },
        req.user?.userId
    );

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Hostel re-assigned successfully',
        data: result
    });
});

// Allocate a specific bed to a student already assigned to a hostel
export const allocateBed = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { bedId, academicYearId } = req.body;
    logger.info(`[allocateBed] studentId=${studentId} bedId=${bedId} by=${req.user?.userId || 'anonymous'}`);

    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot allocate their own bed', 403);
    }

    const result = await AdminStudentService.allocateBed(studentId, bedId, academicYearId, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Bed allocated successfully',
        data: result
    });
});

// List vacant beds in a hostel for the assignment-UI dropdown
export const getAvailableBeds = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { hostelId } = req.params;
    const { sharing, roomType, floor } = req.query as any;

    const result = await AdminStudentService.getAvailableBeds(hostelId, {
        sharing: sharing !== undefined ? Number(sharing) : undefined,
        roomType: roomType ? String(roomType).toUpperCase() : undefined,
        floor: floor !== undefined ? Number(floor) : undefined
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: result
    });
});

// Assign hostel — flips accommodationType from NONE to HOSTEL
export const assignHostel = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { hostelId, hostelPaymentMode } = req.body;
    logger.info(`[assignHostel] studentId=${studentId} hostelId=${hostelId} mode=${hostelPaymentMode} by=${req.user?.userId || 'anonymous'} role=${req.user?.role || 'unknown'}`);

    // Students cannot self-assign hostel
    if (req.user?.role === Role.STUDENT) {
        throw new AppError('Students cannot assign their own hostel', 403);
    }

    const updated = await AdminStudentService.assignHostel(
        studentId,
        hostelId,
        hostelPaymentMode,
        req.user?.userId
    );

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Hostel assigned successfully',
        data: updated
    });
});

// Get Student Certificates
export const getStudentCertificates = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    
    const docs = await AdminStudentService.getStudentCertificates(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: docs
    });
});

// Download Student Documents as Zip
export const downloadStudentDocuments = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    
    const zipFilePath = await AdminStudentService.generateStudentDocumentsZip(studentId);
    const zipFileName = path.basename(zipFilePath);

    res.download(zipFilePath, zipFileName, (err) => {
        if (err) logger.error(`Download error: ${err}`);
        try {
            fs.unlinkSync(zipFilePath); 
        } catch (e) {
            logger.warn(`Failed to delete zip file: ${zipFilePath}`);
        }
    });
});

// Download Application PDF
export const downloadApplication = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;

    const pdfBuffer = await AdminStudentService.downloadApplication(studentId);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=application_${studentId}.pdf`);
    res.send(pdfBuffer);
});

// Update Roll Number
export const updateRollNumber = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateRollNumber] by=${req.user?.userId || 'anonymous'}`);
    const { studentId, rollNumber, sectionId, academicYearId } = req.body;
    
    const result = await AdminStudentService.updateRollNumber(studentId, rollNumber, sectionId, academicYearId, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Roll Number Updated Successfully",
        data: result
    });
});

// Update Student Admission Status Manually
export const updateStudentStatus = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateStudentStatus] by=${req.user?.userId || 'anonymous'}`);
    const { studentId, status } = req.body;
    
    const result = await AdminStudentService.updateStudentAdmissionStatus(studentId, status, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message
    });
});

// Set Scholarship Eligibility Manual
export const setScholarshipEligibility = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[setScholarshipEligibility] by=${req.user?.userId || 'anonymous'}`);
    const { studentId, ruleId } = req.body;
    
    await AdminStudentService.setScholarshipEligibility(studentId, ruleId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Scholarship eligibility updated successfully'
    });
});

// Update Student Personal Details
export const updateStudentPersonalDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateStudentPersonalDetails] by=${req.user?.userId || 'anonymous'}`);
    
    // SECURITY: If Student Role, enforce Own Data Check
    if (req.user?.role === Role.STUDENT) {
        if (!req.user.userId) throw new AppError('User ID missing', 400);

        const student = await StudentService.getStudentByUserId(req.user.userId);
        if (!student) {
            throw new AppError('Student profile not found for this user', 404);
        }
        
        // Force the studentId to match their own profile
        req.body.studentId = student.id;
    }

    const { studentId, ...updateData } = req.body;

    const result = await AdminStudentService.updateStudentPersonalDetails(studentId, updateData, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message,
        data: result.profilePhotoUrl ? { profilePhotoUrl: result.profilePhotoUrl } : undefined
    });
});

// Get All Student Details
export const getStudentDetails = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;

    const data = await AdminStudentService.getStudentDetails(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data
    });
});

// Get Student Details By Application ID
export const getStudentDetailsByApplicationId = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { applicationId } = req.params;

    const data = await AdminStudentService.getStudentDetailsByApplicationId(applicationId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data
    });
});

// Update Academic Qualification
export const updateAcademicQualification = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateAcademicQualification] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;

    // SECURITY: If Student Role, enforce Ownership Check
    if (req.user?.role === Role.STUDENT) {
        if (!req.user.userId) throw new AppError('User ID missing', 400);

        const student = await StudentService.getStudentByUserId(req.user.userId);
        if (!student) {
            throw new AppError('Student profile not found', 404);
        }

        const qualification = await prisma.academicQualification.findUnique({
            where: { id }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        if (qualification.studentId !== student.id) {
            logger.warn(`[Security] Student ${student.id} tried to update qualification ${id} belonging to ${qualification.studentId}`);
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
    }

    const { ...updateData } = req.body;

    const result = await AdminStudentService.updateAcademicQualification(id, updateData, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Academic qualification updated successfully',
        data: result
    });
});

// Delete Academic Qualification
export const deleteAcademicQualification = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[deleteAcademicQualification] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;

    // SECURITY: If Student Role, enforce Ownership Check
    if (req.user?.role === Role.STUDENT) {
        if (!req.user.userId) throw new AppError('User ID missing', 400);

        const student = await StudentService.getStudentByUserId(req.user.userId);
        if (!student) {
            throw new AppError('Student profile not found', 404);
        }

        const qualification = await prisma.academicQualification.findUnique({
            where: { id }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        if (qualification.studentId !== student.id) {
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
    }

    const result = await AdminStudentService.deleteAcademicQualification(id);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message
    });
});

// Validate Academic Qualification
export const validateAcademicQualification = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[validateAcademicQualification] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;
    const { status, remarks } = req.body;

    const result = await AdminStudentService.validateAcademicQualification(id, status, remarks, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message
    });
});

// Update Student Scholarship
export const updateStudentScholarship = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateStudentScholarship] by=${req.user?.userId || 'anonymous'}`);
    const { studentId } = req.body;

    const result = await AdminStudentService.updateStudentScholarship(studentId, req.body, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Student scholarship updated successfully',
        data: result
    });
});

// Get Student Scholarships
export const getStudentScholarships = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getStudentScholarships] by=${req.user?.userId || 'anonymous'}`);
    const { studentId } = req.params;

    const results = await AdminStudentService.getStudentScholarships(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: results
    });
});

// Get Scholarship Stats
export const getScholarshipStats = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getScholarshipStats] by=${req.user?.userId || 'anonymous'}`);

    const stats = await AdminStudentService.getScholarshipStats();

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: stats
    });
});

// Edit Student Scholarship (PUT)
export const editStudentScholarship = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[editStudentScholarship] by=${req.user?.userId || 'anonymous'}`);
    const { id } = req.params;

    const result = await AdminStudentService.editStudentScholarship(id, req.body, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'Student scholarship updated successfully',
        data: result
    });
});

// Finalize Admission (One-Shot Payment & Allocation)
export const finalizeAdmission = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[finalizeAdmission] by=${req.user?.userId || 'anonymous'}`);

    const result = await AdminStudentService.finalizeAdmission(req.body, req.user?.userId!);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: result.message,
        data: result
    });
});

// Verify Online Payment & Finalize
export const verifyPayment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[verifyPayment] by=${req.user?.userId || 'anonymous'}`);

    const { paymentId } = req.body;
    const result = await AdminStudentService.verifyAndCompletePayment(paymentId, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result?.message,
        data: result
    });
});

// Get Admission Fee Invoice
export const getAdmissionInvoice = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getAdmissionInvoice] by=${req.user?.userId || 'anonymous'}`);
    const { studentId } = req.params;

    // Security check: if student, ensure accessing own data
    if (req.user?.role === Role.STUDENT) {
        // ... (student ID check logic if standardized, or rely on service if we passed userId)
        // For now, assuming standard admin/student access pattern.
        // Assuming studentId param is expected.
        const userStudent = await StudentService.getStudentByUserId(req.user.userId!);
        if (userStudent && userStudent.id !== studentId) {
             throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }
    }

    const result = await AdminStudentService.getAdmissionInvoice(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});





// Send Status Email (Manual Trigger)
export const sendStatusEmail = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[sendStatusEmail] by=${req.user?.userId || 'anonymous'}`);

    const result = await AdminStudentService.sendStatusEmail(req.body);

    sendResponse({
        res,
        statusCode: 200,
        success: result.success,
        message: 'Email sent successfully'
    });
});

// Reverse Admission Payment (Delete mistaken bank-transfer / offline payment and undo all side-effects)
export const reverseAdmissionPayment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[reverseAdmissionPayment] by=${req.user?.userId || 'anonymous'}`);

    const { paymentId, reason } = req.body;

    if (!paymentId) {
        throw new AppError('paymentId is required', 400);
    }

    const result = await AdminStudentService.reverseAdmissionPayment(
        paymentId,
        req.user?.userId!,
        reason
    );

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: result.message,
        data: result.reversed
    });
});

// Get Financial Applications
export const getFinancialApplications = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getFinancialApplications] by=${req.user?.userId || 'anonymous'}`);
    const result = await AdminStudentService.getFinancialApplications(req.query);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DATA_FETCHED,
        data: result
    });
});

// Assign PRO to Student
export const updateSeatAllotedBy = catchAsync(async (req: Request, res: Response, _next: NextFunction) => {
    const { studentId, seatAllotedBy } = req.body;
    const result = await AdminStudentService.updateSeatAllotedBy(studentId, seatAllotedBy, req.user?.userId);
    sendResponse({ res, statusCode: 200, success: true, message: 'seatAllotedBy updated successfully', data: result });
});

export const assignPro = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, proNumber } = req.body;

    const proRecord = await prisma.pRO.findUnique({ where: { proNumber } });
    if (!proRecord) {
        throw new AppError('PRO not found with the given proNumber', 404);
    }

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) {
        throw new AppError('Student not found', 404);
    }

    const updatedStudent = await prisma.student.update({
        where: { id: studentId },
        data: { proId: proRecord.id }
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'PRO assigned to student successfully',
        data: { studentId: updatedStudent.id, proId: updatedStudent.proId, proNumber }
    });
});

export const editPro = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, proNumber } = req.body;

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) {
        throw new AppError('Student not found', 404);
    }

    if (!proNumber) {
        // Remove PRO assignment
        const updatedStudent = await prisma.student.update({
            where: { id: studentId },
            data: { proId: null }
        });

        return sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: 'PRO removed from student successfully',
            data: { studentId: updatedStudent.id, proId: null, proNumber: null }
        });
    }

    const proRecord = await prisma.pRO.findUnique({ where: { proNumber } });
    if (!proRecord) {
        throw new AppError('PRO not found with the given proNumber', 404);
    }

    const updatedStudent = await prisma.student.update({
        where: { id: studentId },
        data: { proId: proRecord.id }
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: 'PRO updated for student successfully',
        data: { studentId: updatedStudent.id, proId: updatedStudent.proId, proNumber }
    });
});

// ═══════════════════════════════════════════════════════════
//  WAITING LIST
// ═══════════════════════════════════════════════════════════

export const addToWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.addToWaitingList(req.body, req.user!.userId);
    sendResponse({ res, statusCode: 201, success: true, message: 'Student added to waiting list', data: result });
});

export const getWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.getWaitingList(req.query as any);
    sendResponse({ res, statusCode: 200, success: true, message: 'Waiting list fetched', data: result });
});

export const getStudentWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.getStudentWaitingList(req.params.studentId);
    sendResponse({ res, statusCode: 200, success: true, message: 'Student waiting list fetched', data: result });
});

export const allotFromWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.allotFromWaitingList(req.body.waitingListId, req.user!.userId);
    sendResponse({ res, statusCode: 200, success: true, message: `Seat allotted to ${result.studentName} in ${result.courseName}`, data: result });
});

export const removeFromWaitingList = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const result = await AdminStudentService.removeFromWaitingList(req.body, req.user!.userId);
    sendResponse({ res, statusCode: 200, success: true, message: `${result.cancelled} entries removed from waiting list`, data: result });
});
