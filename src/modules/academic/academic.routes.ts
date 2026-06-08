import { Router } from 'express';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middleware/validationMiddleware';
import {
    createAcademicYear, getAcademicYears, updateAcademicYear, deleteAcademicYear,
    createSchool, getSchools, getSchoolById, updateSchool, deleteSchool,
    createDepartment, getDepartments, getDepartmentById, updateDepartment, deleteDepartment,
    createCourse, getCourses, getCourseById, updateCourse, deleteCourse, getDegrees,
    getSeatStatus,
    createBatch, getBatches, getBatchById, updateBatch, deleteBatch,
    createSection, getSections, getSectionById, updateSection, deleteSection
} from './academic.controller';
import {
    createAcademicYearSchema, createSchoolSchema, createDepartmentSchema,
    createCourseSchema, createBatchSchema, createSectionSchema,
    createCourseCapacitySchema, upsertCourseCapacitySchema,
    bulkUpsertCourseCapacitySchema, updateCourseCapacitySchema,
} from '../../validators/adminValidators';
import { promoteStudentsController, getEnrollmentHistoryController, getYearWiseFinancialsController } from './yearPromotion.controller';
import {
    createCapacity, upsertCapacity, bulkUpsertCapacity,
    listCapacity, getCapacity, updateCapacity, deleteCapacity,
} from './courseCapacity.controller';

const router = Router();

router.post('/academic-year', authenticate, authorizePermission('academic.create.all'), validateRequest(createAcademicYearSchema), createAcademicYear);

router.get('/academic-year', authenticate, authorizePermission('academic.read.all'), getAcademicYears);

router.put('/academic-year/:id', authenticate, authorizePermission('academic.update.all'), updateAcademicYear);

router.delete('/academic-year/:id', authenticate, authorizePermission('academic.delete.all'), deleteAcademicYear);

router.post('/school', authenticate, authorizePermission('academic.create.all'), validateRequest(createSchoolSchema), createSchool);

router.get('/school', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSchools);

router.get('/school/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSchoolById);

router.put('/school/:id', authenticate, authorizePermission('academic.update.all'), updateSchool);

router.delete('/school/:id', authenticate, authorizePermission('academic.delete.all'), deleteSchool);

router.post('/department', authenticate, authorizePermission('academic.create.all'), validateRequest(createDepartmentSchema), createDepartment);

router.get('/department', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getDepartments);

router.get('/department/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getDepartmentById);

router.put('/department/:id', authenticate, authorizePermission('academic.update.all'), updateDepartment);

router.delete('/department/:id', authenticate, authorizePermission('academic.delete.all'), deleteDepartment);

router.post('/course', authenticate, authorizePermission('academic.create.all'), validateRequest(createCourseSchema), createCourse);

router.get('/degrees', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getDegrees);

router.get('/course', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getCourses);

router.get('/course/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getCourseById);

router.put('/course/:id', authenticate, authorizePermission('academic.update.all'), updateCourse);

router.delete('/course/:id', authenticate, authorizePermission('academic.delete.all'), deleteCourse);

router.get('/seat-status', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSeatStatus);

router.post('/batch', authenticate, authorizePermission('academic.create.all'), validateRequest(createBatchSchema), createBatch);

router.get('/batch', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getBatches);

router.get('/batch/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getBatchById);

router.put('/batch/:id', authenticate, authorizePermission('academic.update.all'), updateBatch);

router.delete('/batch/:id', authenticate, authorizePermission('academic.delete.all'), deleteBatch);

router.post('/section', authenticate, authorizePermission('academic.create.all'), validateRequest(createSectionSchema), createSection);

router.get('/section', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSections);

router.get('/section/:id', authenticate, authorizePermission(['academic.read.all', 'student.create.own', 'student.create.all']), getSectionById);

router.put('/section/:id', authenticate, authorizePermission('academic.update.all'), updateSection);

router.delete('/section/:id', authenticate, authorizePermission('academic.delete.all'), deleteSection);

router.post('/promote-students', authenticate, authorizePermission('academic.update.all'), promoteStudentsController);

router.get('/enrollment-history/:studentId', authenticate, authorizePermission(['academic.read.all', 'student.read.own']), getEnrollmentHistoryController);

router.get('/year-wise-financials/:studentId', authenticate, authorizePermission(['academic.read.all', 'finance.read.all', 'finance.read.own']), getYearWiseFinancialsController);

router.post('/capacity', authenticate, authorizePermission('academic.create.all'), validateRequest(createCourseCapacitySchema), createCapacity);

router.post('/capacity/upsert', authenticate, authorizePermission('academic.create.all'), validateRequest(upsertCourseCapacitySchema), upsertCapacity);

router.post('/capacity/bulk', authenticate, authorizePermission('academic.create.all'), validateRequest(bulkUpsertCourseCapacitySchema), bulkUpsertCapacity);

router.get('/capacity', authenticate, authorizePermission('academic.read.all'), listCapacity);

router.get('/capacity/:id', authenticate, authorizePermission('academic.read.all'), getCapacity);

router.put('/capacity/:id', authenticate, authorizePermission('academic.update.all'), validateRequest(updateCourseCapacitySchema), updateCapacity);

router.delete('/capacity/:id', authenticate, authorizePermission('academic.delete.all'), deleteCapacity);

export default router;
