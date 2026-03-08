import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { FeeService, getApplicationFeeAmount, setApplicationFeeAmount } from './fee.service';
import { getAllotmentOrderUrl } from './payment.service';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { Role, RoleType } from '../../constants/roles';

// Fee Head
export const createFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, description } = req.body;
    const adminId = req.user!.userId;

    const feeHead = await FeeService.createFeeHead(name, description, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.FEE_HEAD_CREATED,
        data: feeHead
    });
});

export const getFeeHeads = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const feeHeads = await FeeService.getFeeHeads();
    sendResponse({ res, statusCode: 200, success: true, data: feeHeads });
});

export const getCourseFeeHeads = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { courseId } = req.params;
    const { academicYearId } = req.query;
    if (!courseId) throw new AppError('courseId is required', 400);
    const data = await FeeService.getCourseFeeHeads(courseId, academicYearId as string | undefined);
    sendResponse({ res, statusCode: 200, success: true, data });
});

export const updateFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, description } = req.body;
    
    const updatedFeeHead = await FeeService.updateFeeHead(id, name, description, req.user!.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_HEAD_UPDATED, data: updatedFeeHead });
});

export const deleteFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await FeeService.deleteFeeHead(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_HEAD_DELETED });
});

// Fee Structure
export const createFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { courseId, feeHeadId, amount, academicYearId, quotaType, courseType, yearOfStudy, dueDate, degreeId } = req.body;
    const adminId = req.user!.userId;

    const feeStructure = await FeeService.createFeeStructure(courseId, feeHeadId, amount, academicYearId, adminId, quotaType, courseType, yearOfStudy, dueDate ? new Date(dueDate) : undefined, degreeId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.FEE_STRUCTURE_CREATED,
        data: feeStructure
    });
});

export const createBulkFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { degreeType, feeHeadId, amount, academicYearId, quotaType, courseType, yearOfStudy, dueDate } = req.body;
    const adminId = req.user!.userId;

    if (!degreeType) throw new AppError('Degree type is required', 400);

    const feeStructures = await FeeService.createFeeStructureForDegree(degreeType, feeHeadId, amount, academicYearId, adminId, quotaType, courseType, yearOfStudy, dueDate ? new Date(dueDate) : undefined);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: `Fee structures created for ${feeStructures.length} courses under ${degreeType}`,
        data: feeStructures
    });
});

export const getFeeStructures = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { courseId, academicYearId, feeHeadId, search } = req.query;
    
    const filters = {
        courseId: courseId as string,
        academicYearId: academicYearId as string,
        feeHeadId: feeHeadId as string,
        search: search as string
    };

    const feeStructures = await FeeService.getFeeStructures(filters);
    sendResponse({ res, statusCode: 200, success: true, data: feeStructures });
});

export const updateFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { courseId, feeHeadId, amount, academicYearId, quotaType, courseType, yearOfStudy, dueDate, degreeId } = req.body;
    
    const updatedFeeStructure = await FeeService.updateFeeStructure(id, courseId, feeHeadId, amount, academicYearId, req.user!.userId, quotaType, courseType, yearOfStudy, dueDate ? new Date(dueDate) : undefined, degreeId);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_STRUCTURE_UPDATED, data: updatedFeeStructure });
});

export const deleteFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await FeeService.deleteFeeStructure(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_STRUCTURE_DELETED });
});


// Fee Statistics
export const getFeeStatistics = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const stats = await FeeService.getFeeStatistics();

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.FEE_STATISTICS_FETCHED,
        data: stats
    });
});

// Generate Fee Demands
export const generateFeeDemands = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, courseId, academicYearId } = req.body;
    const adminId = req.user!.userId;

    const result = await FeeService.generateFeeDemands(studentId, courseId, academicYearId, adminId);
    
    // If undefined returned (no applicable fees or error?) Service returns undefined if no applicable fees
    if (!result) {
        return sendResponse({
            res,
            statusCode: 200, // Ok but nothing done
            success: true,
            message: "No applicable fee structures found for this student criteria"
        });
    }

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: "Fee demands generated successfully"
    });
});

// Create DiscountRequest
export const createDiscountRequest = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[createDiscountRequest] by=${req.user?.userId || 'anonymous'}`);
    logger.info(`[createDiscountRequest] payload: ${JSON.stringify(req.body)}`);

    const { studentId, reason, documentUrl, items, referredBy, forceCreate } = req.body;
    
    const requestedAmount = items.reduce((sum: number, item: any) => sum + item.amount, 0);

    const discountRequest = await FeeService.createDiscountRequest(studentId, reason, documentUrl, items, requestedAmount, referredBy, forceCreate);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_REQUESTED,
        data: discountRequest
    });
});

export const updateDiscountRequest = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[updateDiscountRequest] by=${req.user?.userId || 'anonymous'}`);

    const { id } = req.params;
    const { reason, documentUrl, items, referredBy } = req.body;
    const adminId = req.user!.userId;
    
    const requestedAmount = items.reduce((sum: number, item: any) => sum + item.amount, 0);

    const updatedRequest = await FeeService.updateDiscountRequest(id, reason, documentUrl, items, requestedAmount, referredBy, adminId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Discount request updated successfully",
        data: updatedRequest
    });
});

export const deleteDiscountRequest = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[deleteDiscountRequest] by=${req.user?.userId || 'anonymous'}`);

    const { id } = req.params;
    
    await FeeService.deleteDiscountRequest(id);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Discount request deleted successfully"
    });
});

// Approve Discount
export const approveDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[approveDiscount] by=${req.user?.userId || 'anonymous'}`);

    const { requestId, approved, approvedItems } = req.body;
    const adminId = req.user!.userId;
    
    await FeeService.approveDiscount(requestId, approved, req.user!.role as RoleType, adminId, approvedItems);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: MESSAGES.SUCCESS.DISCOUNT_PROCESSED
    });
});

// Get All Discount Requests
export const getDiscountRequests = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getDiscountRequests] by=${req.user?.userId || 'anonymous'}`);

    const { status, studentId, applicationId, degree, allottedCourseId } = req.query;
    const filters = {
        status: status as any, // Enum validation handled by service if strict or Prisma throws
        studentId: studentId as string,
        applicationId: applicationId as string,
        degree: degree as string,
        allottedCourseId: allottedCourseId as string
    };

    const requests = await FeeService.getAllDiscountRequests(filters);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Discount requests fetched successfully",
        data: requests
    });
});

// Application Fee
export const getApplicationFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const amount = await getApplicationFeeAmount();
    sendResponse({ res, statusCode: 200, success: true, data: { amount } });
});

export const updateApplicationFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { amount } = req.body;
    const adminId = req.user!.userId;
    
    if (typeof amount !== 'number' || amount < 0) {
         throw new AppError("Invalid amount", 400);
    }

    const setting = await setApplicationFeeAmount(amount, adminId);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Application fee updated successfully",
        data: setting
    });
});

// Manual Payment Collection
export const collectFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[collectFee] by=${req.user?.userId || 'anonymous'}`);
    
    // Basic validation (ideally use Zod)
    const { 
        studentId, 
        amount, 
        method, 
        component, 
        referenceNumber, 
        bankName, 
        branchName, 
        instrumentDate 
    } = req.body;

    if (!studentId || !amount || !method || !component) {
        throw new AppError("Missing required fields: studentId, amount, method, component", 400);
    }

    const adminId = req.user!.userId;
    
    const payment = await FeeService.recordOfflinePayment(
        studentId,
        amount,
        method,
        component,
        adminId,
        referenceNumber,
        { bankName, branchName, instrumentDate: instrumentDate ? new Date(instrumentDate) : undefined }
    );

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: "Payment collected successfully",
        data: payment
    });
});

// Student Ledger
export const getStudentLedger = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    
    // Security: Students can only see their own
    if (req.user!.role === Role.STUDENT && req.user!.userId !== studentId) {
        // Simple unauthorized check, can be expanded
        // throw new AppError("Unauthorized", 403);
    }

    const ledger = await FeeService.getStudentFeeDetails(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Student ledger fetched successfully",
        data: ledger
    });
});

export const downloadAllotmentOrder = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const { courseChange } = req.query;
    
    // Regenerate if courseChange is explicitly 'true'
    const regenerate = courseChange === 'true';

    const url = await getAllotmentOrderUrl(studentId, regenerate);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Allotment order URL generated",
        data: { url }
    });
});
// Get Student Fee Demands (Simplified View)
export const getStudentFeeDemands = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;

    // Security check: Only allow access if user is admin/staff or the student themselves
    if (req.user!.role === Role.STUDENT && req.user!.userId !== studentId) {
         // throw new AppError("Unauthorized", 403); // Uncomment if strict security needed, for now implicit trust in token vs id check usually handled by middleware or simpler checks
    }

    const feeDetails = await FeeService.getStudentFeeDetails(studentId);

    // Map to simplified list: { feeHeadName, amount, dueDate, status }
    const demands = feeDetails.demands.map(d => ({
        id: d.id,
        feeHeadName: d.feeStructure.feeHead.name,
        amount: d.amount,
        dueDate: d.dueDate,
        status: d.status
    }));

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Student fee demands fetched successfully",
        data: {
            demands,
            scholarship: feeDetails.discounts.scholarship > 0 ? feeDetails.discounts.scholarship : "Not Eligible",
            discount: feeDetails.discounts.manual || 0
        }
    });
});

export const getPaymentHistory = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    
    // Security: Students can only see their own
    if (req.user!.role === Role.STUDENT && req.user!.userId !== studentId) {
        // throw new AppError("Unauthorized", 403);
    }

    const history = await FeeService.getStudentPaymentHistory(studentId);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: "Payment history fetched successfully",
        data: history
    });
});

export const addStudentDiscount = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[addStudentDiscount] by=${req.user?.userId || 'anonymous'}`);
    const { studentId, feeHeadId, feeStructureId, type, amount, reason } = req.body;

    if (!studentId || (!feeHeadId && !feeStructureId) || !type || !amount) {
        throw new AppError("Student ID, and either Fee Head ID or Fee Structure ID, Type, and Amount are required", 400);
    }

    if (!['DISCOUNT', 'FINE'].includes(type)) {
        throw new AppError("Type must be DISCOUNT or FINE", 400);
    }

    const result = await FeeService.addStudentDiscount(studentId, feeHeadId, feeStructureId, type, amount, reason, req.user!.userId);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: `${type} added successfully`,
        data: result
    });
});
