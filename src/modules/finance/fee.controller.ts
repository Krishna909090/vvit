import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { FeeService, getApplicationFeeAmount, setApplicationFeeAmount } from './fee.service';
import { getAllotmentOrderUrl } from './payment.service';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { Role, RoleType } from '../../constants/roles';
import { assertStudentOwns } from '../../utils/ownership';
import { AdmissionEntryType } from '@prisma/client';

export const createFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, description, component } = req.body;
    const adminId = req.user!.userId;

    const feeHead = await FeeService.createFeeHead(name, description, adminId, component);

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
    const { academicYearId, entryType, instituteCode } = req.query;
    if (!courseId) throw new AppError('courseId is required', 400);
    if (entryType && !Object.values(AdmissionEntryType).includes(entryType as AdmissionEntryType)) {
        throw new AppError(`entryType must be one of: ${Object.values(AdmissionEntryType).join(', ')}`, 400);
    }
    const data = await FeeService.getCourseFeeHeads(
        courseId,
        academicYearId as string | undefined,
        entryType as AdmissionEntryType | undefined,
        instituteCode as string | undefined
    );
    sendResponse({ res, statusCode: 200, success: true, data });
});

export const updateFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, description, component } = req.body;

    const updatedFeeHead = await FeeService.updateFeeHead(id, name, description, req.user!.userId, component);

    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_HEAD_UPDATED, data: updatedFeeHead });
});

export const deleteFeeHead = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await FeeService.deleteFeeHead(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_HEAD_DELETED });
});

export const createFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const {
        courseId, feeHeadId, amount, academicYearId,
        quotaType, yearOfStudy,
        entryAcademicYearId, entryType, instituteCode,
    } = req.body;
    const adminId = req.user!.userId;

    const feeStructure = await FeeService.createFeeStructure(
        courseId, feeHeadId, amount, academicYearId, adminId,
        quotaType, yearOfStudy,
        entryAcademicYearId, entryType, instituteCode,
    );

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.FEE_STRUCTURE_CREATED,
        data: feeStructure
    });
});

export const bulkHeadsFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const {
        courseId, academicYearId, entryAcademicYearId,
        entryType, instituteCode, quotaType, yearOfStudy,
        feeHeads,
    } = req.body;
    const adminId = req.user!.userId;

    const result = await FeeService.createFeeStructuresForCombination({
        courseId, academicYearId, entryAcademicYearId,
        entryType, instituteCode, quotaType, yearOfStudy,
        feeHeads,
        userId: adminId,
    });

    const skipMsg = result.skippedCount > 0
        ? ` (${result.skippedCount} skipped — already exist: ${result.skipped.map(s => s.feeHeadName).join(', ')})`
        : '';

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: `Created ${result.createdCount} fee structure(s)${skipMsg}`,
        data: result,
    });
});

export const createBulkFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { degreeType, feeHeadId, amount, academicYearId, quotaType, yearOfStudy } = req.body;
    const adminId = req.user!.userId;

    if (!degreeType) throw new AppError('Degree type is required', 400);

    const result = await FeeService.createFeeStructureForDegree(degreeType, feeHeadId, amount, academicYearId, adminId, quotaType, yearOfStudy);

    const skipMsg = result.skippedCount > 0 ? ` (${result.skippedCount} skipped due to existing structures: ${result.skippedCourses.join(', ')})` : '';
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: `Fee structures created for ${result.createdCount} courses under ${degreeType}${skipMsg}`,
        data: result
    });
});

export const cloneFeeStructures = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { sourceAcademicYearId, targetAcademicYearId, multiplier, courseIds } = req.body;
    const adminId = req.user!.userId;

    const result = await FeeService.cloneFeeStructuresForAcademicYear(
        sourceAcademicYearId,
        targetAcademicYearId,
        adminId,
        { multiplier, courseIds }
    );

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: `Cloned ${result.cloned} fee structures from ${result.source} → ${result.target}` +
                 (result.skipped > 0 ? ` (${result.skipped} skipped — already exist in target)` : ''),
        data: result,
    });
});

export const getFeeStructures = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const {
        courseId, academicYearId, feeHeadId, search,
        entryAcademicYearId, entryType, instituteCode, quotaType, yearOfStudy,
        minAmount, maxAmount, includeDeleted,
        page, limit, sortBy, sortDir,
    } = req.query;

    const toNum = (v: any) => (v === undefined || v === '' ? undefined : Number(v));
    const toBool = (v: any) => v === 'true' || v === true;

    const result = await FeeService.getFeeStructures({
        courseId:            courseId            ? String(courseId)            : undefined,
        academicYearId:      academicYearId      ? String(academicYearId)      : undefined,
        feeHeadId:           feeHeadId           ? String(feeHeadId)           : undefined,
        entryAcademicYearId: entryAcademicYearId ? String(entryAcademicYearId) : undefined,
        entryType:           entryType           ? (String(entryType) as any)  : undefined,
        instituteCode:       instituteCode       ? (String(instituteCode) as any) : undefined,
        quotaType:           quotaType           ? (String(quotaType) as any)  : undefined,
        yearOfStudy:         toNum(yearOfStudy),
        minAmount:           toNum(minAmount),
        maxAmount:           toNum(maxAmount),
        includeDeleted:      toBool(includeDeleted),
        search:              search              ? String(search)              : undefined,
        page:                toNum(page),
        limit:               toNum(limit),
        sortBy:              sortBy              ? (String(sortBy) as any)     : undefined,
        sortDir:             sortDir             ? (String(sortDir) as any)    : undefined,
    });

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: { items: result.data, pagination: result.pagination },
    });
});

export const updateFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { courseId, feeHeadId, amount, academicYearId, quotaType, yearOfStudy } = req.body;

    const updatedFeeStructure = await FeeService.updateFeeStructure(id, courseId, feeHeadId, amount, academicYearId, req.user!.userId, quotaType, yearOfStudy);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_STRUCTURE_UPDATED, data: updatedFeeStructure });
});

export const deleteFeeStructure = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await FeeService.deleteFeeStructure(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.FEE_STRUCTURE_DELETED });
});

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

export const generateFeeDemands = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, courseId, academicYearId, deleteExisting, allowLegacyFallback, requireEnrollment, dueDateFallbackDays } = req.body;
    const adminId = req.user!.userId;

    const result = await FeeService.generateFeeDemands(
        studentId,
        courseId,
        academicYearId,
        adminId,
        Boolean(deleteExisting),
        {
            allowLegacyFallback,
            requireEnrollment,
            dueDateFallbackDays,
        }
    );

    if (result.generated === 0) {
        return sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: result.considered === 0
                ? "No applicable fee structures found for this student"
                : `All applicable demands already exist (skipped=${result.skipped})`,
            data: result
        });
    }

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: `Generated ${result.generated} fee demand(s)${result.fallbackUsed ? ' (legacy fallback used)' : ''}`,
        data: result
    });
});

export const generateFeeDemandsBulk = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { academicYearId, filters = {}, runOptions = {} } = req.body;
    const adminId = req.user!.userId;

    const result = await FeeService.generateFeeDemandsBulk(academicYearId, adminId, filters, runOptions);

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: `Bulk run complete: ok=${result.summary.studentsOk}, failed=${result.summary.studentsFailed}, demands=${result.summary.demandsGenerated}`,
        data: result
    });
});

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

export const getDiscountRequests = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[getDiscountRequests] by=${req.user?.userId || 'anonymous'}`);

    const { status, studentId, applicationId, degree, allottedCourseId } = req.query;
    const filters = {
        status: status as any,
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

export const collectFee = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    logger.info(`[collectFee] by=${req.user?.userId || 'anonymous'}`);

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

export const getStudentLedger = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const academicYearId = req.query.academicYearId as string | undefined;

    await assertStudentOwns(req, studentId);

    const ledger = await FeeService.getStudentFeeDetails(studentId, academicYearId);

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

    await assertStudentOwns(req, studentId);

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

export const getStudentFeeDemands = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId } = req.params;
    const academicYearId = req.query.academicYearId as string | undefined;

    await assertStudentOwns(req, studentId);

    const feeDetails = await FeeService.getStudentFeeDetails(studentId, academicYearId);

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

    await assertStudentOwns(req, studentId);

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

export const changeAccommodationType = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { studentId, newType, hostelId, hostelType, transportRouteId, reason } = req.body;
    const adminId = req.user!.userId;

    const result = await FeeService.changeAccommodationType(
        { studentId, newType, hostelId, hostelType, transportRouteId, reason },
        adminId
    );

    sendResponse({
        res,
        statusCode: 200,
        success: true,
        message: `Accommodation changed from ${result.oldType} to ${result.newType}`,
        data: result
    });
});

export const getFeeCorrections = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const {
        studentId, academicYearId, type, isSettled, carryForward, referenceType, applicationId, page, limit,
    } = req.query;

    const toBool = (v: any) => v === undefined || v === '' ? undefined : (v === 'true' || v === true);
    const toNum  = (v: any) => v === undefined || v === '' ? undefined : Number(v);

    const result = await FeeService.getFeeCorrections({
        studentId:      studentId      ? String(studentId)      : undefined,
        academicYearId: academicYearId ? String(academicYearId) : undefined,
        type:           type           ? (String(type) as any)  : undefined,
        isSettled:      toBool(isSettled),
        carryForward:   toBool(carryForward),
        referenceType:  referenceType  ? String(referenceType)  : undefined,
        applicationId:  applicationId  ? String(applicationId)  : undefined,
        page:           toNum(page),
        limit:          toNum(limit),
    });

    sendResponse({ res, statusCode: 200, success: true, message: 'Fee corrections fetched', data: result });
});

export const applyFeeCorrection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { feeDemandId, amount, remarks } = req.body;
    const adminId = req.user!.userId;

    logger.info(`[applyFeeCorrection] correction=${id} demand=${feeDemandId} amount=${amount} by=${adminId}`);

    const result = await FeeService.applyFeeCorrection(id, { feeDemandId, amount, remarks }, adminId);

    sendResponse({ res, statusCode: 200, success: true, message: 'Fee correction transferred to demand', data: result });
});

export const getCancellationMetrics = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { academicYearId, from, to, referenceType } = req.query;
    const result = await FeeService.getCancellationMetrics({
        academicYearId: academicYearId ? String(academicYearId) : undefined,
        from:           from           ? String(from)           : undefined,
        to:             to             ? String(to)             : undefined,
        referenceType:  referenceType  ? String(referenceType)  : undefined,
    });
    sendResponse({ res, statusCode: 200, success: true, message: 'Cancellation metrics', data: result });
});
