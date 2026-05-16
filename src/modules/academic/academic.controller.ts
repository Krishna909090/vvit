import { Request, Response, NextFunction } from 'express';
import { catchAsync } from '../../utils/catchAsync';
import { MESSAGES } from '../../constants/messages';
import { sendResponse } from '../../utils/response';
import { AcademicService } from './academic.service';

// --- ERP CONTROLLERS: Academics ---

// School
export const createSchool = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, code } = req.body;
    const adminId = req.user?.userId;

    const school = await AcademicService.createSchool(name, code, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: "School created successfully",
        data: school
    });
});

export const getSchools = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const schools = await AcademicService.getSchools();
    sendResponse({ res, statusCode: 200, success: true, data: schools });
});

export const getSchoolById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const school = await AcademicService.getSchoolById(id);
    sendResponse({ res, statusCode: 200, success: true, data: school });
});

export const updateSchool = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, code } = req.body;
    
    const updatedSchool = await AcademicService.updateSchool(id, name, code, req.user?.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: "School updated successfully", data: updatedSchool });
});

export const deleteSchool = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await AcademicService.deleteSchool(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: "School deleted successfully" });
});

// Department
export const createDepartment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, code, schoolId } = req.body;
    const adminId = req.user?.userId;

    const department = await AcademicService.createDepartment(name, code, schoolId, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.DEPARTMENT_CREATED,
        data: department
    });
});

export const getDepartments = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { search } = req.query;
    const departments = await AcademicService.getDepartments(search as string);
    sendResponse({ res, statusCode: 200, success: true, data: departments });
});

export const getDepartmentById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const department = await AcademicService.getDepartmentById(id);
    sendResponse({ res, statusCode: 200, success: true, data: department });
});

export const updateDepartment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, code, schoolId } = req.body;
    
    const updatedDepartment = await AcademicService.updateDepartment(id, name, code, schoolId, req.user?.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.DEPARTMENT_UPDATED, data: updatedDepartment });
});

export const deleteDepartment = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await AcademicService.deleteDepartment(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.DEPARTMENT_DELETED });
});

// Course
export const createCourse = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, code, departmentId, degree, omrId } = req.body;
    const adminId = req.user?.userId;

    const course = await AcademicService.createCourse(name, code, departmentId, degree, adminId, omrId !== undefined ? Number(omrId) : undefined);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: "Course created successfully",
        data: course
    });
});

export const getCourses = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { departmentId, degree, search } = req.query;
    
    const courses = await AcademicService.getCourses(departmentId as string, degree as string, search as string);
    
    sendResponse({ res, statusCode: 200, success: true, data: courses });
});

export const getDegrees = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const degrees = await AcademicService.getDegrees();
    sendResponse({ res, statusCode: 200, success: true, data: degrees });
});

export const getCourseById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const course = await AcademicService.getCourseById(id);
    sendResponse({ res, statusCode: 200, success: true, data: course });
});

export const updateCourse = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, code, departmentId, omrId } = req.body;

    const updatedCourse = await AcademicService.updateCourse(id, name, code, departmentId, req.user?.userId, omrId !== undefined ? Number(omrId) : undefined);
    
    sendResponse({ res, statusCode: 200, success: true, message: "Course updated successfully", data: updatedCourse });
});

export const deleteCourse = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await AcademicService.deleteCourse(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: "Course deleted successfully" });
});

// Specialization
export const createSpecialization = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { code, name, courseId } = req.body;
    const adminId = req.user?.userId;

    const specialization = await AcademicService.createSpecialization(code, name, courseId, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: "Specialization created successfully",
        data: specialization
    });
});

export const getSpecializations = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const specializations = await AcademicService.getSpecializations();
    sendResponse({ res, statusCode: 200, success: true, data: specializations });
});

export const getSeatStatus = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const seatStatus = await AcademicService.getSeatStatus();
    sendResponse({ 
        res, 
        statusCode: 200, 
        success: true, 
        data: seatStatus 
    });
});

export const getSpecializationById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const specialization = await AcademicService.getSpecializationById(id);
    sendResponse({ res, statusCode: 200, success: true, data: specialization });
});

export const updateSpecialization = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { code, name } = req.body;

    const updatedSpecialization = await AcademicService.updateSpecialization(id, code, name, req.user?.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: "Specialization updated successfully", data: updatedSpecialization });
});

export const deleteSpecialization = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await AcademicService.deleteSpecialization(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: "Specialization deleted successfully" });
});

// Academic Year
export const createAcademicYear = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { code, startDate, endDate, isActive } = req.body;
    const adminId = req.user?.userId;

    const academicYear = await AcademicService.createAcademicYear(code, startDate, endDate, isActive, adminId);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.ACADEMIC_YEAR_CREATED,
        data: academicYear
    });
});

export const getAcademicYears = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const academicYears = await AcademicService.getAcademicYears();
    sendResponse({ res, statusCode: 200, success: true, data: academicYears });
});

export const updateAcademicYear = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    const updatedAcademicYear = await AcademicService.updateAcademicYear(id, req.body, req.user?.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.ACADEMIC_YEAR_UPDATED, data: updatedAcademicYear });
});

export const deleteAcademicYear = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    await AcademicService.deleteAcademicYear(id, req.user?.userId);

    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.ACADEMIC_YEAR_DELETED });
});

// Batch
export const createBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, courseId, startDate, endDate } = req.body;
    const adminId = req.user?.userId;

    const batch = await AcademicService.createBatch(name, courseId, startDate, endDate, adminId);

    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.BATCH_CREATED,
        data: batch
    });
});

export const getBatches = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { courseId } = req.query;

    const batches = await AcademicService.getBatches(courseId as string);

    sendResponse({ res, statusCode: 200, success: true, data: batches });
});

export const getBatchById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const batch = await AcademicService.getBatchById(id);
    sendResponse({ res, statusCode: 200, success: true, data: batch });
});

export const updateBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, courseId, startDate, endDate } = req.body;

    const updatedBatch = await AcademicService.updateBatch(id, name, courseId, startDate, endDate, req.user?.userId);

    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.BATCH_UPDATED, data: updatedBatch });
});

export const deleteBatch = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await AcademicService.deleteBatch(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.BATCH_DELETED });
});

// Section
export const createSection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { name, batchId } = req.body;
    const adminId = req.user?.userId;

    const section = await AcademicService.createSection(name, batchId, adminId);
    
    sendResponse({
        res,
        statusCode: 201,
        success: true,
        message: MESSAGES.SUCCESS.SECTION_CREATED,
        data: section
    });
});

export const getSections = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { batchId } = req.query;
    
    const sections = await AcademicService.getSections(batchId as string);
    
    sendResponse({ res, statusCode: 200, success: true, data: sections });
});

export const getSectionById = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const section = await AcademicService.getSectionById(id);
    sendResponse({ res, statusCode: 200, success: true, data: section });
});

export const updateSection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const { name, batchId } = req.body;
    
    const updatedSection = await AcademicService.updateSection(id, name, batchId, req.user?.userId);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.SECTION_UPDATED, data: updatedSection });
});

export const deleteSection = catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    
    await AcademicService.deleteSection(id);
    
    sendResponse({ res, statusCode: 200, success: true, message: MESSAGES.SUCCESS.SECTION_DELETED });
});
