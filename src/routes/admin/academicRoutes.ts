import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    createDepartment, getDepartments, getDepartmentById, updateDepartment, deleteDepartment,
    createCourse, getCourses, getCourseById, updateCourse, deleteCourse,
    createSpecialization, getSpecializations, getSpecializationById, updateSpecialization, deleteSpecialization,
    createAcademicYear, getAcademicYears, updateAcademicYear, deleteAcademicYear,
    createBatch, getBatches, updateBatch, deleteBatch,
    createSection, getSections, updateSection, deleteSection
} from '../../controllers/admin/academicController';
import {
    createDepartmentSchema, createCourseSchema, createSpecializationSchema,
    createAcademicYearSchema, createBatchSchema, createSectionSchema
} from '../../validators/adminValidators';

const router = Router();

// Academic Year
/**
 * @swagger
 * /admin/academic-year:
 *   post:
 *     summary: Create a new academic year
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *               - startDate
 *               - endDate
 *             properties:
 *               code:
 *                 type: string
 *               startDate:
 *                 type: string
 *                 format: date-time
 *               endDate:
 *                 type: string
 *                 format: date-time
 *               isActive:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Academic Year created
 */
// Academic Year
/**
 * @swagger
 * /admin/academic-year:
 *   post:
 *     summary: Create a new academic year
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *               - startDate
 *               - endDate
 *             properties:
 *               code:
 *                 type: string
 *               startDate:
 *                 type: string
 *                 format: date-time
 *               endDate:
 *                 type: string
 *                 format: date-time
 *               isActive:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Academic Year created
 */
router.post('/academic-year', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createAcademicYearSchema), createAcademicYear);
router.get('/academic-year', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getAcademicYears);
router.put('/academic-year/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateAcademicYear);
router.delete('/academic-year/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteAcademicYear);

// Department
/**
 * @swagger
 * /admin/department:
 *   post:
 *     summary: Create a new department
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - code
 *             properties:
 *               name:
 *                 type: string
 *               code:
 *                 type: string
 *     responses:
 *       200:
 *         description: Department created
 */
router.post('/department', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createDepartmentSchema), createDepartment);
router.get('/department', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getDepartments);
router.get('/department/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getDepartmentById);
router.put('/department/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateDepartment);
router.delete('/department/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteDepartment);

// Course
/**
 * @swagger
 * /admin/course:
 *   post:
 *     summary: Create a new course (Formerly Program/Branch)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *               - name
 *               - totalSeats
 *             properties:
 *               code:
 *                 type: string
 *               name:
 *                 type: string
 *               totalSeats:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Course created successfully
 */
router.post('/course', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createCourseSchema), createCourse);
router.get('/course', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getCourses);
router.get('/course/:id', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN, Role.AGENT]), getCourseById);
router.put('/course/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateCourse);
router.delete('/course/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteCourse);

// Specialization 
/**
 * @swagger
 * /admin/specialization:
 *   post:
 *     summary: Create a new specialization (Formerly Branch)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - courseId
 *               - name
 *               - code
 *             properties:
 *               courseId:
 *                 type: string
 *               name:
 *                 type: string
 *               code:
 *                 type: string
 *     responses:
 *       201:
 *         description: Specialization created successfully
 */
router.post('/specialization', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createSpecializationSchema), createSpecialization);
router.get('/specialization', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getSpecializations);
router.get('/specialization/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getSpecializationById);
router.put('/specialization/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateSpecialization);
router.delete('/specialization/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteSpecialization);

// Batch
/**
 * @swagger
 * /admin/batch:
 *   post:
 *     summary: Create a new batch
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - courseId
 *               - startDate
 *               - endDate
 *             properties:
 *               name:
 *                 type: string
 *               courseId:
 *                 type: string
 *                 format: uuid
 *               startDate:
 *                 type: string
 *                 format: date-time
 *               endDate:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Batch created
 */
router.post('/batch', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createBatchSchema), createBatch);
router.get('/batch', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getBatches);
router.put('/batch/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateBatch);
router.delete('/batch/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteBatch);

// Section
/**
 * @swagger
 * /admin/section:
 *   post:
 *     summary: Create a new section
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - batchId
 *             properties:
 *               name:
 *                 type: string
 *               batchId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Section created
 */
router.post('/section', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createSectionSchema), createSection);
router.get('/section', authorize([Role.ADMIN, Role.SUPER_ADMIN, Role.STUDENT, Role.AGENT]), getSections);
router.put('/section/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateSection);
router.delete('/section/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteSection);

export default router;
