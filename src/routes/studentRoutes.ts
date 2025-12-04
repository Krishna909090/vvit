import { Router } from 'express';
import {
    registerStudent,
    payTestFee,
    getHallTicket,
    uploadDocumentsAndPreferences,
    payCollegeFee
} from '../controllers/studentController';
import { authenticate, authorize } from '../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import { validateRequest } from '../middlewares/validationMiddleware';
import {
    registerStudentSchema,
    studentIdParamSchema,
    uploadDocumentsAndPreferencesSchema,
    addAcademicDetailsSchema
} from '../validators/studentValidators';

const router = Router();

// Public or Agent/Student accessible
/**
 * @swagger
 * /student/register:
 *   post:
 *     summary: Register a new student application
 *     tags: [Student]
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
 *               - fatherName
 *               - motherName
 *               - gender
 *               - dob
 *               - phone
 *               - email
 *               - aadharNumber
 *               - category
 *               - country
 *               - address
 *               - city
 *               - state
 *               - pincode
 *               - profilePhotoUrl
 *               - courseType
 *             properties:
 *               name:
 *                 type: string
 *               fatherName:
 *                 type: string
 *               motherName:
 *                 type: string
 *               gender:
 *                 type: string
 *               dob:
 *                 type: string
 *                 format: date
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               aadharNumber:
 *                 type: string
 *               category:
 *                 type: string
 *               country:
 *                 type: string
 *               address:
 *                 type: string
 *               address2:
 *                 type: string
 *               city:
 *                 type: string
 *               state:
 *                 type: string
 *               pincode:
 *                 type: string
 *               profilePhotoUrl:
 *                 type: string
 *               courseType:
 *                 type: string
 *               isOffline:
 *                 type: boolean
 *               pref1:
 *                 type: string
 *               pref2:
 *                 type: string
 *               pref3:
 *                 type: string
 *           example:
 *             name: "Rahul Sharma"
 *             fatherName: "Rajesh Sharma"
 *             motherName: "Sunita Sharma"
 *             gender: "Male"
 *             dob: "2005-08-15"
 *             phone: "9876543210"
 *             email: "rahul.sharma@example.com"
 *             aadharNumber: "123456789012"
 *             category: "General"
 *             country: "India"
 *             address: "123, Main Street, Gandhi Nagar"
 *             address2: "Apt 4B"
 *             city: "Hyderabad"
 *             state: "Telangana"
 *             pincode: "500001"
 *             pref1: "CSE"
 *             pref2: "ECE"
 *             pref3: "IT"
 *             courseType: "B.Tech"
 *             profilePhotoUrl: "https://example-bucket.s3.amazonaws.com/photos/rahul.jpg"
 *     responses:
 *       201:
 *         description: Student registered successfully
 */
router.post('/register', authenticate, authorize([Role.AGENT, Role.STUDENT]), validateRequest(registerStudentSchema), registerStudent);

// Student specific
/**
 * @swagger
 * /student/{studentId}/pay-test-fee:
 *   post:
 *     summary: Mark test fee as paid
 *     tags: [Student]
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
 *         description: Test fee paid successfully
 */
router.post('/:studentId/pay-test-fee', authenticate, authorize([Role.STUDENT]), validateRequest(studentIdParamSchema), payTestFee);

/**
 * @swagger
 * /student/{studentId}/hall-ticket:
 *   get:
 *     summary: Get hall ticket URL
 *     tags: [Student]
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
 *         description: Hall ticket URL retrieved
 *       404:
 *         description: Hall ticket not found or not generated
 */
router.get('/:studentId/hall-ticket', authenticate, authorize([Role.STUDENT]), validateRequest(studentIdParamSchema), getHallTicket);

/**
 * @swagger
 * /student/{studentId}/upload-docs:
 *   post:
 *     summary: Upload documents and update preferences
 *     tags: [Student]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pref1:
 *                 type: string
 *               pref2:
 *                 type: string
 *               pref3:
 *                 type: string
 *               marksheetUrl:
 *                 type: string
 *               tenthMarksheetUrl:
 *                 type: string
 *               twelfthMarksheetUrl:
 *                 type: string
 *               diplomaMarksheetUrl:
 *                 type: string
 *               degreeCertificateUrl:
 *                 type: string
 *               cmmUrl:
 *                 type: string
 *               provisionalCertificateUrl:
 *                 type: string
 *               entranceScorecardUrl:
 *                 type: string
 *               migrationCertificateUrl:
 *                 type: string
 *               tcUrl:
 *                 type: string
 *               casteUrl:
 *                 type: string
 *           example:
 *             pref1: "CSE"
 *             pref2: "IT"
 *             pref3: "ECE"
 *             marksheetUrl: "https://example-bucket.s3.amazonaws.com/marks/rahul-marks.pdf"
 *             tcUrl: "https://example-bucket.s3.amazonaws.com/tc/rahul-tc.pdf"
 *             casteUrl: "https://example-bucket.s3.amazonaws.com/caste/rahul-caste.pdf"
 *     responses:
 *       200:
 *         description: Documents uploaded successfully
 */
router.post('/:studentId/upload-docs', authenticate, authorize([Role.STUDENT]), validateRequest(uploadDocumentsAndPreferencesSchema), uploadDocumentsAndPreferences);

/**
 * @swagger
 * /student/{studentId}/pay-college-fee:
 *   post:
 *     summary: Pay college admission fee
 *     tags: [Student]
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
 *         description: College fee paid successfully
 */
router.post('/:studentId/pay-college-fee', authenticate, authorize([Role.STUDENT]), validateRequest(studentIdParamSchema), payCollegeFee);



import { addAcademicDetails } from '../controllers/studentController';

/**
 * @swagger
 * /student/{studentId}/academic-details:
 *   post:
 *     summary: Add academic qualifications (10th, 12th)
 *     tags: [Student]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - details
 *             properties:
 *               details:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - level
 *                     - board
 *                     - yearOfPassing
 *                     - hallTicketNumber
 *                     - gpaOrMarks
 *                   properties:
 *                     level:
 *                       type: string
 *                       example: "10th"
 *                     board:
 *                       type: string
 *                       example: "SSC"
 *                     yearOfPassing:
 *                       type: string
 *                       example: "2021"
 *                     hallTicketNumber:
 *                       type: string
 *                       example: "1234567890"
 *                     gpaOrMarks:
 *                       type: string
 *                       example: "9.8"
 *     responses:
 *       201:
 *         description: Academic details added successfully
 */
router.post('/:studentId/academic-details', authenticate, authorize([Role.STUDENT]), validateRequest(addAcademicDetailsSchema), addAcademicDetails);

import {
    selectExam,
} from '../controllers/studentController';
import { getAvailableSlots } from '../controllers/examController';
import {
    selectExamSchema
} from '../validators/studentActionValidators';

// ... existing routes ...

// Select Exam
/**
 * @swagger
 * /student/{studentId}/select-exam:
 *   post:
 *     summary: Select exam date and center
 *     tags: [Student]
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
 *           example:
 *             slotId: "uuid-slot"
 *     responses:
 *       200:
 *         description: Exam selected and Hall Ticket generated
 */
router.post('/:studentId/select-exam', authenticate, authorize([Role.STUDENT]), validateRequest(selectExamSchema), selectExam);
/**
 * @swagger
 * /student/exam-slots:
 *   get:
 *     summary: Get available exam slots
 *     tags: [Student]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available exam slots
 */
router.get('/exam-slots', authenticate, authorize([Role.STUDENT]), getAvailableSlots);

import { getMyRequirements } from '../controllers/documentController';

// Get Document Requirements
/**
 * @swagger
 * /student/document-requirements:
 *   get:
 *     summary: Get document requirements for the student's course type
 *     tags: [Student]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of required documents
 */
router.get('/document-requirements', authenticate, authorize([Role.STUDENT]), getMyRequirements);

import { deleteStudentDocument } from '../controllers/deleteDocumentController';

// Delete Document
/**
 * @swagger
 * /student/{studentId}/document:
 *   delete:
 *     summary: Delete an uploaded document
 *     tags: [Student]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: studentId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: documentKey
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Document deleted successfully
 */
router.delete('/:studentId/document', authenticate, authorize([Role.STUDENT, Role.ADMIN, Role.SUPER_ADMIN]), deleteStudentDocument);

export default router;
