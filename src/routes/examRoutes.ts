import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../middlewares/validationMiddleware';
import {
    createExamDate,
    createExamCenter,
    generateInvigilatorCredentials,
    loginInvigilator,
    scanAttendance,
    createExamSlot,
    getAvailableSlots,
    bookExamSlot
} from '../controllers/examController';
import {
    createExamDateSchema,
    createExamCenterSchema,
    generateInvigilatorCredentialSchema,
    invigilatorLoginSchema,
    scanAttendanceSchema,
    createExamSlotSchema,
    bookExamSlotSchema
} from '../validators/examValidators';

const router = Router();

// Admin Routes
/**
 * @swagger
 * /exam/dates:
 *   post:
 *     summary: Create exam date
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - date
 *             properties:
 *               date:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Exam date created
 */
router.post('/dates', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createExamDateSchema), createExamDate);

/**
 * @swagger
 * /exam/centers:
 *   post:
 *     summary: Create exam center
 *     tags: [Exam]
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
 *               - address
 *               - city
 *               - state
 *               - capacity
 *             properties:
 *               name:
 *                 type: string
 *               address:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               capacity:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Exam center created
 */
router.post('/centers', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createExamCenterSchema), createExamCenter);

/**
 * @swagger
 * /exam/invigilators/generate:
 *   post:
 *     summary: Generate invigilator credentials
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - examCenterId
 *               - count
 *             properties:
 *               examCenterId:
 *                 type: string
 *               count:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Credentials generated
 */
router.post('/invigilators/generate', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(generateInvigilatorCredentialSchema), generateInvigilatorCredentials);

/**
 * @swagger
 * /exam/slots:
 *   post:
 *     summary: Create exam slot
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - examCenterId
 *               - date
 *               - startTime
 *               - endTime
 *               - capacity
 *             properties:
 *               examCenterId:
 *                 type: string
 *               date:
 *                 type: string
 *                 format: date
 *               startTime:
 *                 type: string
 *                 format: date-time
 *               endTime:
 *                 type: string
 *                 format: date-time
 *               capacity:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Exam slot created
 */
router.post('/slots', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createExamSlotSchema), createExamSlot);

// Student/Public Routes
/**
 * @swagger
 * /exam/slots:
 *   get:
 *     summary: Get available exam slots
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available slots
 */
router.get('/slots', authenticate, getAvailableSlots);

/**
 * @swagger
 * /exam/slots/{studentId}/book:
 *   post:
 *     summary: Book an exam slot
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - slotId
 *             properties:
 *               slotId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Slot booked successfully
 */
router.post('/slots/:studentId/book', authenticate, validateRequest(bookExamSlotSchema), bookExamSlot);

// Invigilator Routes
/**
 * @swagger
 * /exam/invigilators/login:
 *   post:
 *     summary: Invigilator login
 *     tags: [Exam]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *               - password
 *             properties:
 *               code:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 */
router.post('/invigilators/login', validateRequest(invigilatorLoginSchema), loginInvigilator);

/**
 * @swagger
 * /exam/attendance/scan:
 *   post:
 *     summary: Scan attendance (Invigilator)
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - studentId
 *               - slotId
 *             properties:
 *               studentId:
 *                 type: string
 *               slotId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Attendance marked
 */
router.post('/attendance/scan', authenticate, validateRequest(scanAttendanceSchema), scanAttendance);

export default router;
