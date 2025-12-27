import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createSchool, getSchools, getSchoolById, updateSchool, deleteSchool,
    createDepartment, getDepartments, getDepartmentById, updateDepartment, deleteDepartment,
    createCourse, getCourses, getCourseById, updateCourse, deleteCourse, getDegrees,
    createSpecialization, getSpecializations, getSpecializationById, updateSpecialization, deleteSpecialization,
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

// Academic Year
// Academic Year
router.post('/academic-year', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createAcademicYearSchema), createAcademicYear);
router.get('/academic-year', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getAcademicYears);
router.put('/academic-year/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateAcademicYear);
router.delete('/academic-year/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteAcademicYear);

// School
router.post('/school', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createSchoolSchema), createSchool);
router.get('/school', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getSchools);
router.get('/school/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getSchoolById);
router.put('/school/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateSchool);
router.delete('/school/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteSchool);

// Department
router.post('/department', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createDepartmentSchema), createDepartment);
router.get('/department', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getDepartments);
router.get('/department/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getDepartmentById);
router.put('/department/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateDepartment);
router.delete('/department/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteDepartment);

// Course
router.post('/course', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createCourseSchema), createCourse);
router.get('/degrees', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getDegrees);
router.get('/course', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getCourses);
router.get('/course/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getCourseById);
router.put('/course/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateCourse);
router.delete('/course/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteCourse);

// Specialization 
router.post('/specialization', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createSpecializationSchema), createSpecialization);
router.get('/specialization', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getSpecializations);
router.get('/specialization/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getSpecializationById);
router.put('/specialization/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateSpecialization);
router.delete('/specialization/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteSpecialization);

// Batch
router.post('/batch', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createBatchSchema), createBatch);
router.get('/batch', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getBatches);
router.get('/batch/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getBatchById);
router.put('/batch/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateBatch);
router.delete('/batch/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteBatch);

// Section
router.post('/section', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createSectionSchema), createSection);
router.get('/section', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getSections);
router.get('/section/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getSectionById);
router.put('/section/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateSection);
router.delete('/section/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteSection);

export default router;
