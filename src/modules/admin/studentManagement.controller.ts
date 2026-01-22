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

// Request Course Change
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

// Approve Course Change
export const approveCourseChange = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveCourseChange] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, approved } = req.body;
    
    await AdminStudentService.approveCourseChange(requestId, approved, req.user?.role, req.user?.userId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.COURSE_CHANGE_PROCESSED
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
        message: result.message
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
    const { status } = req.body;

    const result = await AdminStudentService.validateAcademicQualification(id, status, req.user?.userId);

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
        data: { paymentId: result.paymentId }
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
        message: result.message
    });
});



