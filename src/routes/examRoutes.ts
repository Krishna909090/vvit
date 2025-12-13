import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../middlewares/validationMiddleware';
import {
    createExamCenter,
    getExamCenters,
    updateExamCenter,
    deleteExamCenter,
    scanAttendance,
    createExamSlot,
    getExamSlots,
    getExamSlot,
    updateExamSlot,
    deleteExamSlot,
    getAvailableSlots,
    bookExamSlot,
    toggleSlotBooking,
    getExamSlotsByCenter
} from '../controllers/examController';
import {
    createExamCenterSchema,
    scanAttendanceSchema,
    createExamSlotSchema,
    bookExamSlotSchema
} from '../validators/examValidators';

const router = Router();

// Admin Routes
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

/**
 * @swagger
 * /exam/slots/{slotId}/toggle-booking:
 *   put:
 *     summary: Enable or disable slot booking
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: slotId
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
 *               - isBookingEnabled
 *             properties:
 *               isBookingEnabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Slot booking status updated
 */
router.put('/slots/:slotId/toggle-booking', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), toggleSlotBooking);


/**
 * @swagger
 * /exam/centers:
 *   get:
 *     summary: Get all exam centers
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of exam centers
 */
router.get('/centers', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getExamCenters);

/**
 * @swagger
 * /exam/centers/{id}:
 *   put:
 *     summary: Update exam center
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Exam center updated
 */
router.put('/centers/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateExamCenter);

/**
 * @swagger
 * /exam/centers/{id}:
 *   delete:
 *     summary: Delete exam center
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Exam center deleted
 */
router.delete('/centers/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteExamCenter);

// Exam Slots Admin CRUD

/**
 * @swagger
 * /exam/all-slots:
 *   get:
 *     summary: Get all exam slots (Admin)
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all exam slots
 */
router.get('/all-slots', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getExamSlots);

/**
 * @swagger
 * /exam/centers/{centerId}/slots:
 *   get:
 *     summary: Get all exam slots for a specific center
 *     tags: [Exam]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: centerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of exam slots for the center
 */
router.get('/centers/:centerId/slots', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getExamSlotsByCenter);

router.get('/slots/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), getExamSlot);
router.put('/slots/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateExamSlot);
router.delete('/slots/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteExamSlot);


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
