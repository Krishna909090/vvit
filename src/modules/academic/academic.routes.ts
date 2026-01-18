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
    createCourseSchema, createSpecializationSchema, createBatchSchema, createSectionSchema
} from '../../validators/adminValidators';

const router = Router();

// Academic Year
router.post('/academic-year', authenticate, authorizePermission('academic.batch.manage'), validateRequest(createAcademicYearSchema), createAcademicYear);
router.get('/academic-year', authenticate, authorizePermission('academic.course.view'), getAcademicYears);
router.put('/academic-year/:id', authenticate, authorizePermission('academic.batch.manage'), updateAcademicYear);
router.delete('/academic-year/:id', authenticate, authorizePermission('academic.batch.manage'), deleteAcademicYear);

// School
router.post('/school', authenticate, authorizePermission('academic.course.create'), validateRequest(createSchoolSchema), createSchool);
router.get('/school', authenticate, authorizePermission(['academic.course.view', 'student.create']), getSchools);
router.get('/school/:id', authenticate, authorizePermission(['academic.course.view', 'student.create']), getSchoolById);
router.put('/school/:id', authenticate, authorizePermission('academic.course.create'), updateSchool);
router.delete('/school/:id', authenticate, authorizePermission('academic.course.create'), deleteSchool);

// Department
router.post('/department', authenticate, authorizePermission('academic.course.create'), validateRequest(createDepartmentSchema), createDepartment);
router.get('/department', authenticate, authorizePermission(['academic.course.view', 'student.create']), getDepartments);
router.get('/department/:id', authenticate, authorizePermission(['academic.course.view', 'student.create']), getDepartmentById);
router.put('/department/:id', authenticate, authorizePermission('academic.course.create'), updateDepartment);
router.delete('/department/:id', authenticate, authorizePermission('academic.course.create'), deleteDepartment);

// Course
router.post('/course', authenticate, authorizePermission('academic.course.create'), validateRequest(createCourseSchema), createCourse);
router.get('/degrees', authenticate, authorizePermission(['academic.course.view', 'student.create']), getDegrees);
router.get('/course', authenticate, authorizePermission(['academic.course.view', 'student.create']), getCourses);
router.get('/course/:id', authenticate, authorizePermission(['academic.course.view', 'student.create']), getCourseById);
router.put('/course/:id', authenticate, authorizePermission('academic.course.create'), updateCourse);
router.delete('/course/:id', authenticate, authorizePermission('academic.course.create'), deleteCourse);

// Specialization
router.post('/specialization', authenticate, authorizePermission('academic.course.create'), validateRequest(createSpecializationSchema), createSpecialization);
router.get('/specialization/check-seat-status', authenticate, authorizePermission('academic.course.create'), getSeatStatus);
router.get('/specialization', authenticate, authorizePermission(['academic.course.view', 'student.create']), getSpecializations);
router.get('/specialization/:id', authenticate, authorizePermission(['academic.course.view', 'student.create']), getSpecializationById);
router.put('/specialization/:id', authenticate, authorizePermission('academic.course.create'), updateSpecialization);
router.delete('/specialization/:id', authenticate, authorizePermission('academic.course.create'), deleteSpecialization);

// Batch
router.post('/batch', authenticate, authorizePermission('academic.batch.manage'), validateRequest(createBatchSchema), createBatch);
router.get('/batch', authenticate, authorizePermission(['academic.course.view', 'student.create']), getBatches);
router.get('/batch/:id', authenticate, authorizePermission(['academic.course.view', 'student.create']), getBatchById);
router.put('/batch/:id', authenticate, authorizePermission('academic.batch.manage'), updateBatch);
router.delete('/batch/:id', authenticate, authorizePermission('academic.batch.manage'), deleteBatch);

// Section
router.post('/section', authenticate, authorizePermission('academic.batch.manage'), validateRequest(createSectionSchema), createSection);
router.get('/section', authenticate, authorizePermission(['academic.course.view', 'student.create']), getSections);
router.get('/section/:id', authenticate, authorizePermission(['academic.course.view', 'student.create']), getSectionById);
router.put('/section/:id', authenticate, authorizePermission('academic.batch.manage'), updateSection);
router.delete('/section/:id', authenticate, authorizePermission('academic.batch.manage'), deleteSection);

export default router;
