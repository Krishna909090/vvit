import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createSchool, getSchools, getSchoolById, updateSchool, deleteSchool,
    createDepartment, getDepartments, getDepartmentById, updateDepartment, deleteDepartment,
    createCourse, getCourses, getCourseById, updateCourse, deleteCourse, getDegrees,
    createSpecialization, getSpecializations, getSpecializationById, updateSpecialization, deleteSpecialization, getSeatStatus,
    createAcademicYear, getAcademicYears, updateAcademicYear, deleteAcademicYear,
    createBatch, getBatches, getBatchById, updateBatch, deleteBatch,
    createSection, getSections, getSectionById, updateSection, deleteSection
} from './academic.controller';
import {
    createSchoolSchema,
    createDepartmentSchema, createCourseSchema, createSpecializationSchema,
    createAcademicYearSchema, createBatchSchema, createSectionSchema
} from '../../validators/adminValidators';

const router = Router();

// Academic Permissions: Strict CRUD + Scope
// POST -> academic.create.all
// GET -> academic.read.all
// PUT -> academic.update.all
// DELETE -> academic.delete.all

// Academic Year
router.post('/academic-year', authenticate, authorizePermission('academic.create.all'), validateRequest(createAcademicYearSchema), createAcademicYear);
router.get('/academic-year', authenticate, authorizePermission('academic.read.all'), getAcademicYears);
router.put('/academic-year/:id', authenticate, authorizePermission('academic.update.all'), updateAcademicYear);
router.delete('/academic-year/:id', authenticate, authorizePermission('academic.delete.all'), deleteAcademicYear);

// School
router.post('/school', authenticate, authorizePermission('academic.create.all'), validateRequest(createSchoolSchema), createSchool);
router.get('/school', authenticate, authorizePermission('academic.read.all'), getSchools);
router.get('/school/:id', authenticate, authorizePermission('academic.read.all'), getSchoolById);
router.put('/school/:id', authenticate, authorizePermission('academic.update.all'), updateSchool);
router.delete('/school/:id', authenticate, authorizePermission('academic.delete.all'), deleteSchool);

// Department
router.post('/department', authenticate, authorizePermission('academic.create.all'), validateRequest(createDepartmentSchema), createDepartment);
router.get('/department', authenticate, authorizePermission('academic.read.all'), getDepartments);
router.get('/department/:id', authenticate, authorizePermission('academic.read.all'), getDepartmentById);
router.put('/department/:id', authenticate, authorizePermission('academic.update.all'), updateDepartment);
router.delete('/department/:id', authenticate, authorizePermission('academic.delete.all'), deleteDepartment);

// Course
router.post('/course', authenticate, authorizePermission('academic.create.all'), validateRequest(createCourseSchema), createCourse);
router.get('/degrees', authenticate, authorizePermission('academic.read.all'), getDegrees);
router.get('/course', authenticate, authorizePermission('academic.read.all'), getCourses);
router.get('/course/:id', authenticate, authorizePermission('academic.read.all'), getCourseById);
router.put('/course/:id', authenticate, authorizePermission('academic.update.all'), updateCourse);
router.delete('/course/:id', authenticate, authorizePermission('academic.delete.all'), deleteCourse);

// Specialization 
router.post('/specialization', authenticate, authorizePermission('academic.create.all'), validateRequest(createSpecializationSchema), createSpecialization);
router.get('/specialization/check-seat-status', authenticate, authorizePermission('academic.read.all'), getSeatStatus);
router.get('/specialization', authenticate, authorizePermission('academic.read.all'), getSpecializations);
router.get('/specialization/:id', authenticate, authorizePermission('academic.read.all'), getSpecializationById);
router.put('/specialization/:id', authenticate, authorizePermission('academic.update.all'), updateSpecialization);
router.delete('/specialization/:id', authenticate, authorizePermission('academic.delete.all'), deleteSpecialization);

// Batch
router.post('/batch', authenticate, authorizePermission('academic.create.all'), validateRequest(createBatchSchema), createBatch);
router.get('/batch', authenticate, authorizePermission('academic.read.all'), getBatches);
router.get('/batch/:id', authenticate, authorizePermission('academic.read.all'), getBatchById);
router.put('/batch/:id', authenticate, authorizePermission('academic.update.all'), updateBatch);
router.delete('/batch/:id', authenticate, authorizePermission('academic.delete.all'), deleteBatch);

// Section
router.post('/section', authenticate, authorizePermission('academic.create.all'), validateRequest(createSectionSchema), createSection);
router.get('/section', authenticate, authorizePermission('academic.read.all'), getSections);
router.get('/section/:id', authenticate, authorizePermission('academic.read.all'), getSectionById);
router.put('/section/:id', authenticate, authorizePermission('academic.update.all'), updateSection);
router.delete('/section/:id', authenticate, authorizePermission('academic.delete.all'), deleteSection);

export default router;
