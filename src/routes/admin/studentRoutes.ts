import { Router } from 'express';
import { authorize, authenticate } from '../../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../../middlewares/validationMiddleware';
import {
    getAllApplications, uploadBulkApplications, requestCancellation, approveCancellation,
    verifyAndAllotSeat, verifyStudentDocument, requestCourseChange, approveCourseChange,
    updateAdmissionDetails, getStudentCertificates, downloadStudentDocuments
} from '../../controllers/admin/studentManagementController';
import {
    getAllApplicationsSchema, requestCancellationSchema, approveCancellationSchema,
    verifyAndAllotSeatSchema, changeCourseSchema, approveCourseChangeSchema,
    updateAdmissionDetailsSchema, studentIdParamSchema
} from '../../validators/adminValidators';
import upload from '../../config/multer';
import {
    addRequirement,
    listRequirements,
    updateRequirement,
    removeRequirement
} from '../../controllers/documentController';

const router = Router();

// Applications
/**
 * @swagger
 * /admin/applications:
 *   get:
 *     summary: Get all student applications
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         example: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         example: 10
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         example: "Rahul"
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         example: "REGISTERED"
 *     responses:
 *       200:
 *         description: List of applications
 */
// Applications
/**
 * @swagger
 * /admin/applications:
 *   get:
 *     summary: Get all student applications
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         example: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         example: 10
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         example: "Rahul"
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         example: "REGISTERED"
 *     responses:
 *       200:
 *         description: List of applications
 */
router.get('/applications', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(getAllApplicationsSchema), getAllApplications);

/**
 * @swagger
 * /admin/upload-applications:
 *   post:
 *     summary: Bulk upload student applications via CSV
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Applications uploaded successfully
 */
router.post('/upload-applications', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), upload.single('file'), uploadBulkApplications);

// Cancellation
/**
 * @swagger
 * /admin/request-cancellation:
 *   post:
 *     summary: Request admission cancellation
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
 *               - studentId
 *               - reason
 *             properties:
 *               studentId:
 *                 type: string
 *               reason:
 *                 type: string
 *               refundAmount:
 *                 type: number
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             reason: "Joined another college"
 *             refundAmount: 50000
 *     responses:
 *       201:
 *         description: Cancellation requested
 */
router.post('/request-cancellation', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(requestCancellationSchema), requestCancellation);

/**
 * @swagger
 * /admin/approve-cancellation:
 *   post:
 *     summary: Approve cancellation request (Super Admin)
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
 *               - requestId
 *               - action
 *             properties:
 *               requestId:
 *                 type: string
 *               action:
 *                 type: string
 *                 enum: [APPROVE, REJECT]
 *           example:
 *             requestId: "cancel-req-456"
 *             action: "APPROVE"
 *     responses:
 *       200:
 *         description: Cancellation request processed
 */
router.post('/approve-cancellation', authenticate, authorize([Role.SUPER_ADMIN]), validateRequest(approveCancellationSchema), approveCancellation);

// Seat & Course Change
/**
 * @swagger
 * /admin/verify-allot:
 *   post:
 *     summary: Verify documents and allot seat
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
 *               - studentId
 *               - allottedCourse
 *             properties:
 *               studentId:
 *                 type: string
 *               allottedCourse:
 *                 type: string
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             allottedCourse: "CSE"
 *     responses:
 *       200:
 *         description: Seat allotted successfully
 */
router.post('/verify-allot', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(verifyAndAllotSeatSchema), verifyAndAllotSeat);

/**
 * @swagger
 * /admin/change-course:
 *   post:
 *     summary: Request change allotted course
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
 *               - studentId
 *               - newCourse
 *               - reason
 *             properties:
 *               studentId:
 *                 type: string
 *               newCourse:
 *                 type: string
 *               reason:
 *                 type: string
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             newCourse: "ECE"
 *             reason: "Better career prospects"
 *     responses:
 *       200:
 *         description: Course change requested
 */
router.post('/change-course', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(changeCourseSchema), requestCourseChange);

/**
 * @swagger
 * /admin/approve-course-change:
 *   post:
 *     summary: Approve course change request (Super Admin)
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
 *               - requestId
 *               - approved
 *             properties:
 *               requestId:
 *                 type: string
 *               approved:
 *                 type: boolean
 *           example:
 *             requestId: "req-123"
 *             approved: true
 *     responses:
 *       200:
 *         description: Course change processed
 */
router.post('/approve-course-change', authenticate, authorize([Role.SUPER_ADMIN]), validateRequest(approveCourseChangeSchema), approveCourseChange);

// Admission Details
/**
 * @swagger
 * /admin/update-admission:
 *   post:
 *     summary: Update admission details (Accommodation & Fees)
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
 *               - studentId
 *               - accommodationType
 *             properties:
 *               studentId:
 *                 type: string
 *               accommodationType:
 *                 type: string
 *                 enum: [HOSTEL, TRANSPORT, NONE]
 *               hostelType:
 *                 type: string
 *                 enum: [SHARING_4, SHARING_8]
 *               transportRouteId:
 *                 type: string
 *               paidAmount:
 *                 type: number
 *               hostelId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Admission details updated
 */
router.post('/update-admission', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateAdmissionDetailsSchema), updateAdmissionDetails);

// Documents
/**
 * @swagger
 * /admin/certificates/{studentId}:
 *   get:
 *     summary: Get student certificates
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Student certificates retrieved
 */
router.get('/certificates/:studentId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(studentIdParamSchema), getStudentCertificates);

/**
 * @swagger
 * /admin/download-documents/{studentId}:
 *   get:
 *     summary: Download all student documents as ZIP
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: ZIP file downloaded
 */
router.get('/download-documents/:studentId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(studentIdParamSchema), downloadStudentDocuments);

/**
 * @swagger
 * /admin/verify-document/{studentId}:
 *   post:
 *     summary: Verify a student's uploaded document
 *     tags: [Admin]
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
 *               - documentKey
 *               - status
 *             properties:
 *               documentKey:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [APPROVED, REJECTED]
 *               remarks:
 *                 type: string
 *     responses:
 *       200:
 *         description: Document verification status updated
 */
router.post('/verify-document/:studentId', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), verifyStudentDocument);

// Document Requirements Management (from documentController)
/**
 * @swagger
 * /admin/document-requirements:
 *   post:
 *     summary: Add a new document requirement
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
 *               - key
 *               - courseType
 *             properties:
 *               name:
 *                 type: string
 *               key:
 *                 type: string
 *               courseType:
 *                 type: string
 *               isRequired:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Document requirement added
 *   get:
 *     summary: List all document requirements
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of document requirements
 */
router.post('/document-requirements', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), addRequirement);
router.get('/document-requirements', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), listRequirements);

/**
 * @swagger
 * /admin/document-requirements/{id}:
 *   put:
 *     summary: Update a document requirement
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               isRequired:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Document requirement updated
 *   delete:
 *     summary: Remove a document requirement
 *     tags: [Admin]
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
 *         description: Document requirement removed
 */
router.put('/document-requirements/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateRequirement);
router.delete('/document-requirements/:id', authenticate, authorize([Role.ADMIN, Role.SUPER_ADMIN]), removeRequirement);

export default router;
