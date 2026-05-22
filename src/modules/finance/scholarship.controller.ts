import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { AppError } from '../../utils/AppError';
import { ScholarshipService } from './scholarship.service';
import { sendResponse } from '../../utils/response';
import { assertStudentOwns } from '../../utils/ownership';

export const createScholarshipRule = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, minPercentile, discountPercentage, totalSlots } = req.body;
    
    // Basic validation
    if (!name || minPercentile === undefined || discountPercentage === undefined || totalSlots === undefined) {
        throw new AppError("Missing required fields", 400);
    }
    
    const rule = await ScholarshipService.createRule(req.body, req.user!.userId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: "Scholarship Rule Created",
        data: rule
    });
});

export const getScholarshipRules = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const rules = await ScholarshipService.getAllRules();
    sendResponse({ res, statusCode: 200, success: true, data: rules });
});

export const updateScholarshipRule = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const rule = await ScholarshipService.updateRule(id, req.body);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Scholarship Rule Updated",
        data: rule
    });
});

export const deleteScholarshipRule = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    await ScholarshipService.deleteRule(id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Scholarship Rule Deleted (Soft Delete)"
    });
});

export const manualAllocate = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, ruleId } = req.body;
    if (!studentId || !ruleId) throw new AppError("Student ID and Rule ID required", 400);
    
    const allocation = await ScholarshipService.allocateManualRule(studentId, ruleId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: "Scholarship Allocated Manually",
        data: allocation
    });
});

export const checkEligibility = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    // Handling GET request params
    const { studentId } = req.params;

    if (!studentId) {
        throw new AppError("Student ID (param) required", 400);
    }

    await assertStudentOwns(req, studentId); // IDOR guard

    // Service now auto-fetches data from DB (Read-Only)
    const result = await ScholarshipService.checkEligibility(studentId);
    
    sendResponse({
        res,
        statusCode: 200,
        success: result.eligible,
        message: result.eligible ? "Eligible" : result.reason,
        data: result
    });
});

export const verifyEligibility = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, remarks, ruleId } = req.body;
    await ScholarshipService.verifyEligibility(studentId, remarks, req.user!.userId, ruleId);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Eligibility Verification Recorded"
    });
});

export const allocateScholarship = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, ruleId } = req.body; // Explicit allocation after verification
    
    const result = await ScholarshipService.allocateScholarship(studentId, ruleId, req.user!.userId);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: "Scholarship Reserved Successfully",
        data: result
    });
});

export const updateStudentScholarship = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, scholarshipPercentage, feeHeadId } = req.body;
    
    if (!studentId || scholarshipPercentage === undefined) {
        throw new AppError("Student ID and Scholarship Percentage required", 400);
    }
    
    const result = await ScholarshipService.updateStudentScholarship(studentId, Number(scholarshipPercentage), req.user!.userId, feeHeadId);
    
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Scholarship Updated and Fees Reconciled",
        data: result
    });
});
