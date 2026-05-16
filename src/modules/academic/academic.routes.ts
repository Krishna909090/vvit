import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createAcademicYear, getAcademicYears, updateAcademicYear, deleteAcademicYear,
    createSchool, getSchools, getSchoolById, updateSchool, deleteSchool,
    createDepartment, getDepartments, getDepartmentById, updateDepartment, deleteDepartment,
    createCourse, getCourses, getCourseById, updateCourse, deleteCourse, getDegrees,
    createSpecialization, getSpecializations, getSpecializationById, updateSpecialization, deleteSpecialization, getSeatStatus,
    createBatch, getBatches, getBatchById, updateBatch, deleteBatch,
    createSection, getSections, getSectionById, updateSection, deleteSection
} from './academic.controller';
import {
    createAcademicYearSchema, createSchoolSchema, createDepartmentSchema,
    createCourseSchema, createSpecializationSchema, createBatchSchema, createSectionSchema,
    createCourseCapacitySchema, upsertCourseCapacitySchema,
    bulkUpsertCourseCapacitySchema, updateCourseCapacitySchema,
} from '../../validators/adminValidators';
import { promoteStudentsController, getEnrollmentHistoryController, getYearWiseFinancialsController } from './yearPromotion.controller';
import {
    createCapacity, upsertCapacity, bulkUpsertCapacity,
    listCapacity, getCapacity, updateCapacity, deleteCapacity,
} from './courseCapacity.controller';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  ACADEMIC YEAR ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /academic-year
 * @desc    Create a new academic year with a code, date range, and active status.
 * @side    Inserts a new academic year record; logs the creating admin.
 * @body    { code: string, startDate: string, endDate: string, isActive: boolean }
 * @returns 201 - { success: true, message: string, data: AcademicYear }
 */
router.post('/academic-year', authenticate, authorizePermission('academic.create.all'), validateRequest(createAcademicYearSchema), createAcademicYear);

/**
 * @route   GET /academic-year
 * @desc    Retrieve all academic years.
 * @side    None (read-only).
 * @returns 200 - { success: true, data: AcademicYear[] }
 */
router.get('/academic-year', authenticate, authorizePermission('academic.read.all'), getAcademicYears);

/**
 * @route   PUT /academic-year/:id
 * @desc    Update an existing academic year's details (code, dates, active flag).
 * @side    Mutates the academic year record in the database.
 * @params  id - UUID of the academic year to update.
 * @body    Partial { code?: string, startDate?: string, endDate?: string, isActive?: boolean }
 * @returns 200 - { success: true, message: string, data: AcademicYear }
 */
router.put('/academic-year/:id', authenticate, authorizePermission('academic.update.all'), updateAcademicYear);

/**
 * @route   DELETE /academic-year/:id
 * @desc    Permanently delete an academic year.
 * @side    Removes the academic year record; may cascade to dependent data.
 * @params  id - UUID of the academic year to delete.
 * @returns 200 - { success: true, message: string }
 */
router.delete('/academic-year/:id', authenticate, authorizePermission('academic.delete.all'), deleteAcademicYear);

// ═══════════════════════════════════════════════════════════
//  SCHOOL ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /school
 * @desc    Create a new school (top-level academic unit).
 * @side    Inserts a school record; logs the creating admin.
 * @body    { name: string, code: string }
 * @returns 201 - { success: true, message: string, data: School }
 */
router.post('/school', authenticate, authorizePermission('academic.create.all'), validateRequest(createSchoolSchema), createSchool);

/**
 * @route   GET /school
 * @desc    Retrieve all schools. Accessible to admins and student-creation flows.
 * @side    None (read-only).
 * @returns 200 - { success: true, data: School[] }
 */
router.get('/school', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSchools);

/**
 * @route   GET /school/:id
 * @desc    Retrieve a single school by its ID.
 * @side    None (read-only).
 * @params  id - UUID of the school.
 * @returns 200 - { success: true, data: School }
 */
router.get('/school/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSchoolById);

/**
 * @route   PUT /school/:id
 * @desc    Update a school's name or code.
 * @side    Mutates the school record in the database.
 * @params  id - UUID of the school to update.
 * @body    { name?: string, code?: string }
 * @returns 200 - { success: true, message: string, data: School }
 */
router.put('/school/:id', authenticate, authorizePermission('academic.update.all'), updateSchool);

/**
 * @route   DELETE /school/:id
 * @desc    Permanently delete a school.
 * @side    Removes the school record; may cascade to child departments.
 * @params  id - UUID of the school to delete.
 * @returns 200 - { success: true, message: string }
 */
router.delete('/school/:id', authenticate, authorizePermission('academic.delete.all'), deleteSchool);

// ═══════════════════════════════════════════════════════════
//  DEPARTMENT ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /department
 * @desc    Create a new department under a school.
 * @side    Inserts a department record linked to the specified school.
 * @body    { name: string, code: string, schoolId: string }
 * @returns 201 - { success: true, message: string, data: Department }
 */
router.post('/department', authenticate, authorizePermission('academic.create.all'), validateRequest(createDepartmentSchema), createDepartment);

/**
 * @route   GET /department
 * @desc    Retrieve all departments, with optional text search filtering.
 * @side    None (read-only).
 * @query   search? - Optional search string to filter departments by name/code.
 * @returns 200 - { success: true, data: Department[] }
 */
router.get('/department', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getDepartments);

/**
 * @route   GET /department/:id
 * @desc    Retrieve a single department by its ID.
 * @side    None (read-only).
 * @params  id - UUID of the department.
 * @returns 200 - { success: true, data: Department }
 */
router.get('/department/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getDepartmentById);

/**
 * @route   PUT /department/:id
 * @desc    Update a department's name, code, or parent school.
 * @side    Mutates the department record in the database.
 * @params  id - UUID of the department to update.
 * @body    { name?: string, code?: string, schoolId?: string }
 * @returns 200 - { success: true, message: string, data: Department }
 */
router.put('/department/:id', authenticate, authorizePermission('academic.update.all'), updateDepartment);

/**
 * @route   DELETE /department/:id
 * @desc    Permanently delete a department.
 * @side    Removes the department record; may cascade to child courses.
 * @params  id - UUID of the department to delete.
 * @returns 200 - { success: true, message: string }
 */
router.delete('/department/:id', authenticate, authorizePermission('academic.delete.all'), deleteDepartment);

// ═══════════════════════════════════════════════════════════
//  COURSE ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /course
 * @desc    Create a new course under a department with degree type and seat capacity.
 * @side    Inserts a course record; associates it with a department and degree.
 * @body    { name: string, code: string, departmentId: string, degree: string, totalSeats: number, omrId?: number }
 * @returns 201 - { success: true, message: string, data: Course }
 */
router.post('/course', authenticate, authorizePermission('academic.create.all'), validateRequest(createCourseSchema), createCourse);

/**
 * @route   GET /degrees
 * @desc    Retrieve a distinct list of all degree types (e.g., B.Tech, M.Tech).
 * @side    None (read-only).
 * @returns 200 - { success: true, data: string[] }
 */
router.get('/degrees', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getDegrees);

/**
 * @route   GET /course
 * @desc    Retrieve courses, optionally filtered by department, degree, or search text.
 * @side    None (read-only).
 * @query   departmentId? - UUID to filter by department. degree? - Degree type filter. search? - Text search.
 * @returns 200 - { success: true, data: Course[] }
 */
router.get('/course', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getCourses);

/**
 * @route   GET /course/:id
 * @desc    Retrieve a single course by its ID.
 * @side    None (read-only).
 * @params  id - UUID of the course.
 * @returns 200 - { success: true, data: Course }
 */
router.get('/course/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getCourseById);

/**
 * @route   PUT /course/:id
 * @desc    Update a course's name, code, department, seat count, or OMR ID.
 * @side    Mutates the course record in the database.
 * @params  id - UUID of the course to update.
 * @body    { name?: string, code?: string, departmentId?: string, totalSeats?: number, omrId?: number }
 * @returns 200 - { success: true, message: string, data: Course }
 */
router.put('/course/:id', authenticate, authorizePermission('academic.update.all'), updateCourse);

/**
 * @route   DELETE /course/:id
 * @desc    Permanently delete a course.
 * @side    Removes the course record; may cascade to child specializations.
 * @params  id - UUID of the course to delete.
 * @returns 200 - { success: true, message: string }
 */
router.delete('/course/:id', authenticate, authorizePermission('academic.delete.all'), deleteCourse);

// ═══════════════════════════════════════════════════════════
//  SPECIALIZATION ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /specialization
 * @desc    Create a new specialization (branch) under a course with seat allocation.
 * @side    Inserts a specialization record linked to the given course.
 * @body    { code: string, name: string, totalSeats: number, courseId: string }
 * @returns 201 - { success: true, message: string, data: Specialization }
 */
router.post('/specialization', authenticate, authorizePermission('academic.create.all'), validateRequest(createSpecializationSchema), createSpecialization);

/**
 * @route   GET /specialization/check-seat-status
 * @desc    Retrieve seat availability status across all specializations (filled vs total).
 * @side    None (read-only).
 * @returns 200 - { success: true, data: SeatStatus[] }
 */
router.get('/specialization/check-seat-status', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSeatStatus);

/**
 * @route   GET /specialization
 * @desc    Retrieve all specializations.
 * @side    None (read-only).
 * @returns 200 - { success: true, data: Specialization[] }
 */
router.get('/specialization', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSpecializations);

/**
 * @route   GET /specialization/:id
 * @desc    Retrieve a single specialization by its ID.
 * @side    None (read-only).
 * @params  id - UUID of the specialization.
 * @returns 200 - { success: true, data: Specialization }
 */
router.get('/specialization/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSpecializationById);

/**
 * @route   PUT /specialization/:id
 * @desc    Update a specialization's code, name, or total seats.
 * @side    Mutates the specialization record in the database.
 * @params  id - UUID of the specialization to update.
 * @body    { code?: string, name?: string, totalSeats?: number }
 * @returns 200 - { success: true, message: string, data: Specialization }
 */
router.put('/specialization/:id', authenticate, authorizePermission('academic.update.all'), updateSpecialization);

/**
 * @route   DELETE /specialization/:id
 * @desc    Permanently delete a specialization.
 * @side    Removes the specialization record; may cascade to child batches.
 * @params  id - UUID of the specialization to delete.
 * @returns 200 - { success: true, message: string }
 */
router.delete('/specialization/:id', authenticate, authorizePermission('academic.delete.all'), deleteSpecialization);

// ═══════════════════════════════════════════════════════════
//  BATCH ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /batch
 * @desc    Create a new batch (intake group) under a specialization with a date range.
 * @side    Inserts a batch record linked to the given specialization.
 * @body    { name: string, specializationId: string, startDate: string, endDate: string }
 * @returns 201 - { success: true, message: string, data: Batch }
 */
router.post('/batch', authenticate, authorizePermission('academic.create.all'), validateRequest(createBatchSchema), createBatch);

/**
 * @route   GET /batch
 * @desc    Retrieve batches, optionally filtered by specialization.
 * @side    None (read-only).
 * @query   specializationId? - UUID to filter batches by specialization.
 * @returns 200 - { success: true, data: Batch[] }
 */
router.get('/batch', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getBatches);

/**
 * @route   GET /batch/:id
 * @desc    Retrieve a single batch by its ID.
 * @side    None (read-only).
 * @params  id - UUID of the batch.
 * @returns 200 - { success: true, data: Batch }
 */
router.get('/batch/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getBatchById);

/**
 * @route   PUT /batch/:id
 * @desc    Update a batch's name, specialization, or date range.
 * @side    Mutates the batch record in the database.
 * @params  id - UUID of the batch to update.
 * @body    { name?: string, specializationId?: string, startDate?: string, endDate?: string }
 * @returns 200 - { success: true, message: string, data: Batch }
 */
router.put('/batch/:id', authenticate, authorizePermission('academic.update.all'), updateBatch);

/**
 * @route   DELETE /batch/:id
 * @desc    Permanently delete a batch.
 * @side    Removes the batch record; may cascade to child sections.
 * @params  id - UUID of the batch to delete.
 * @returns 200 - { success: true, message: string }
 */
router.delete('/batch/:id', authenticate, authorizePermission('academic.delete.all'), deleteBatch);

// ═══════════════════════════════════════════════════════════
//  SECTION ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /section
 * @desc    Create a new section (class division) under a batch.
 * @side    Inserts a section record linked to the given batch.
 * @body    { name: string, batchId: string }
 * @returns 201 - { success: true, message: string, data: Section }
 */
router.post('/section', authenticate, authorizePermission('academic.create.all'), validateRequest(createSectionSchema), createSection);

/**
 * @route   GET /section
 * @desc    Retrieve sections, optionally filtered by batch.
 * @side    None (read-only).
 * @query   batchId? - UUID to filter sections by batch.
 * @returns 200 - { success: true, data: Section[] }
 */
router.get('/section', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSections);

/**
 * @route   GET /section/:id
 * @desc    Retrieve a single section by its ID.
 * @side    None (read-only).
 * @params  id - UUID of the section.
 * @returns 200 - { success: true, data: Section }
 */
router.get('/section/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSectionById);

/**
 * @route   PUT /section/:id
 * @desc    Update a section's name or parent batch.
 * @side    Mutates the section record in the database.
 * @params  id - UUID of the section to update.
 * @body    { name?: string, batchId?: string }
 * @returns 200 - { success: true, message: string, data: Section }
 */
router.put('/section/:id', authenticate, authorizePermission('academic.update.all'), updateSection);

/**
 * @route   DELETE /section/:id
 * @desc    Permanently delete a section.
 * @side    Removes the section record from the database.
 * @params  id - UUID of the section to delete.
 * @returns 200 - { success: true, message: string }
 */
router.delete('/section/:id', authenticate, authorizePermission('academic.delete.all'), deleteSection);

// ═══════════════════════════════════════════════════════════
//  YEAR PROMOTION & ENROLLMENT HISTORY ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /promote-students
 * @desc    Bulk-promote all eligible students from one academic year to another.
 *          Copies enrollment records forward and advances each student's year level.
 * @side    Creates new enrollment records for the target academic year; skips already-promoted students.
 * @body    { fromAcademicYearId: string, toAcademicYearId: string }
 * @returns 200 - { status: 'success', message: string, data: { promoted: number, skipped: number, failed: number } }
 */
router.post('/promote-students', authenticate, authorizePermission('academic.update.all'), promoteStudentsController);

/**
 * @route   GET /enrollment-history/:studentId
 * @desc    Retrieve the full enrollment history for a student across all academic years.
 * @side    None (read-only).
 * @params  studentId - UUID of the student.
 * @returns 200 - { status: 'success', data: EnrollmentRecord[] }
 */
router.get('/enrollment-history/:studentId', authenticate, authorizePermission(['academic.read.all', 'student.read.own']), getEnrollmentHistoryController);

/**
 * @route   GET /year-wise-financials/:studentId
 * @desc    Retrieve year-wise financial summary (fees, payments, dues) for a student.
 * @side    None (read-only).
 * @params  studentId - UUID of the student.
 * @returns 200 - { status: 'success', data: YearWiseFinancial[] }
 */
router.get('/year-wise-financials/:studentId', authenticate, authorizePermission(['academic.read.all', 'finance.read.all', 'finance.read.own']), getYearWiseFinancialsController);

// ═══════════════════════════════════════════════════════════
//  COURSE CAPACITY (per Course × AcademicYear)
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /capacity
 * @desc    Create a per-year capacity row for a course (strict — fails on duplicate).
 * @body    { courseId, academicYearId, totalSeats, filledSeats? }
 */
router.post('/capacity', authenticate, authorizePermission('academic.create.all'), validateRequest(createCourseCapacitySchema), createCapacity);

/**
 * @route   POST /capacity/upsert
 * @desc    Create-or-update single (course × year) capacity. Idempotent.
 * @body    { courseId, academicYearId, totalSeats }
 */
router.post('/capacity/upsert', authenticate, authorizePermission('academic.create.all'), validateRequest(upsertCourseCapacitySchema), upsertCapacity);

/**
 * @route   POST /capacity/bulk
 * @desc    Bulk upsert capacity for many courses in one academic year.
 * @body    { academicYearId, rows: [{ courseId, totalSeats }] }
 */
router.post('/capacity/bulk', authenticate, authorizePermission('academic.create.all'), validateRequest(bulkUpsertCourseCapacitySchema), bulkUpsertCapacity);

/**
 * @route   GET /capacity
 * @desc    List capacity rows. Optional filters: courseId, academicYearId.
 */
router.get('/capacity', authenticate, authorizePermission('academic.read.all'), listCapacity);

/**
 * @route   GET /capacity/:id
 * @desc    Get a single capacity row by id.
 */
router.get('/capacity/:id', authenticate, authorizePermission('academic.read.all'), getCapacity);

/**
 * @route   PUT /capacity/:id
 * @desc    Update totalSeats and/or filledSeats on a specific capacity row.
 * @body    { totalSeats?, filledSeats? }
 */
router.put('/capacity/:id', authenticate, authorizePermission('academic.update.all'), validateRequest(updateCourseCapacitySchema), updateCapacity);

/**
 * @route   DELETE /capacity/:id
 * @desc    Delete a capacity row (only allowed when filledSeats = 0).
 */
router.delete('/capacity/:id', authenticate, authorizePermission('academic.delete.all'), deleteCapacity);

export default router;
