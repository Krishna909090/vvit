
import { Router } from 'express';
import {
    markAttendance,
    verifyAndAllotSeat,
    requestBranchChange,
    approveBranchChange,
    reviewDiscountRequest,
    createDiscountRequest,
    approveDiscount,
    getDashboardStats,
    getAllApplications,
    uploadBulkApplications,
    requestCancellation,
    approveCancellation,
    getStudentCertificates,
    downloadStudentDocuments,
    createTransportRoute,
    getTransportRoutes,
    updateAdmissionDetails,
    getFeeStatistics,
    updateExamScore,
    addAdmin,
    getAgentCommissions,
    uploadBulkResults,
    createHostel,
    getHostels,
    updateHostel,
    generateInvigilatorCredentials,
    createBranch,
    createDepartment,
    createProgram,
    createBatch,
    createSection,
    createHostelBlock,
    createHostelRoom,
    createVehicle,
    createTransportStop,
    createFeeHead,
    createFeeStructure,
    createAcademicYear,
    getDepartments, updateDepartment, deleteDepartment,
    getPrograms, updateProgram, deleteProgram,
    getBranches, updateBranch, deleteBranch,
    getFeeHeads, updateFeeHead, deleteFeeHead,
    getFeeStructures, updateFeeStructure, deleteFeeStructure,
    getAcademicYears, updateAcademicYear, deleteAcademicYear,
    getBatches, updateBatch, deleteBatch,
    getSections, updateSection, deleteSection,
    getHostelBlocks, updateHostelBlock, deleteHostelBlock,
    getHostelRooms, updateHostelRoom, deleteHostelRoom,
    getVehicles, updateVehicle, deleteVehicle,
    getTransportStops, updateTransportStop, deleteTransportStop,
    getUserDetails
} from '../controllers/adminController';
import { authenticate, authorize } from '../middlewares/authMiddleware';
import { Role } from '@prisma/client';
import upload from '../config/multer';
import { validateRequest } from '../middlewares/validationMiddleware';
import {
    markAttendanceSchema,
    verifyAndAllotSeatSchema,
    changeBranchSchema,
    approveBranchChangeSchema,
    createDiscountRequestSchema,
    reviewDiscountRequestSchema,
    approveDiscountSchema,
    requestCancellationSchema,
    approveCancellationSchema,
    updateExamScoreSchema,
    createTransportRouteSchema,
    updateAdmissionDetailsSchema,
    getAllApplicationsSchema,
    studentIdParamSchema,
    addAdminSchema,
    getAgentCommissionsSchema,
    createBranchSchema,
    createDepartmentSchema,
    createProgramSchema,
    createBatchSchema,
    createSectionSchema,
    createHostelBlockSchema,
    createHostelRoomSchema,
    createVehicleSchema,
    createTransportStopSchema,
    createFeeHeadSchema,
    createFeeStructureSchema,
    createAcademicYearSchema
} from '../validators/adminValidators';
import { createHostelSchema, updateHostelSchema } from '../validators/hostelValidators';
import {
    addRequirement,
    listRequirements,
    updateRequirement,
    removeRequirement
} from '../controllers/documentController';
import { verifyStudentDocument } from '../controllers/verifyDocumentController';

const router = Router();

router.use(authenticate);

// Add Admin
/**
 * @swagger
 * /admin/add-admin:
 *   post:
 *     summary: Add a new admin (Super Admin only)
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
 *               - email
 *               - password
 *               - phone
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               phone:
 *                 type: string
 *     responses:
 *       201:
 *         description: Admin created successfully
 */
router.post('/add-admin', authorize([Role.SUPER_ADMIN]), validateRequest(addAdminSchema), addAdmin);

// Agent Commissions
/**
 * @swagger
 * /admin/commissions:
 *   get:
 *     summary: Get agent commissions
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: agentId
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of commissions
 */
router.get('/commissions', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(getAgentCommissionsSchema), getAgentCommissions);

// Upload Bulk Results
/**
 * @swagger
 * /admin/upload-results:
 *   post:
 *     summary: Upload bulk exam results via CSV
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
 *         description: Results uploaded successfully
 */
router.post('/upload-results', authorize([Role.ADMIN, Role.SUPER_ADMIN]), upload.single('file'), uploadBulkResults);

// Hostel Management
/**
 * @swagger
 * /admin/hostels:
 *   post:
 *     summary: Create a new hostel
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
 *               - type
 *               - capacity
 *               - fee
 *             properties:
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [SHARING_4, SHARING_8]
 *               capacity:
 *                 type: integer
 *               fee:
 *                 type: number
 *               blockName:
 *                 type: string
 *               roomNumber:
 *                 type: string
 *     responses:
 *       201:
 *         description: Hostel created successfully
 *   get:
 *     summary: Get all hostels
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of hostels
 */
router.post('/hostels', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createHostelSchema), createHostel);
router.get('/hostels', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getHostels);

/**
 * @swagger
 * /admin/hostels/{hostelId}:
 *   put:
 *     summary: Update hostel details
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: hostelId
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
 *               capacity:
 *                 type: integer
 *               fee:
 *                 type: number
 *     responses:
 *       200:
 *         description: Hostel updated successfully
 */
router.put('/hostels/:hostelId', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateHostelSchema), updateHostel);


// Admin Operations
/**
 * @swagger
 * /admin/dashboard-stats:
 *   get:
 *     summary: Get dashboard statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard stats retrieved
 */
router.get('/dashboard-stats', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getDashboardStats);

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
router.get('/applications', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(getAllApplicationsSchema), getAllApplications);

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
router.post('/upload-applications', authorize([Role.ADMIN, Role.SUPER_ADMIN]), upload.single('file'), uploadBulkApplications);

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
router.get('/certificates/:studentId', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(studentIdParamSchema), getStudentCertificates);



/**
 * @swagger
 * /admin/mark-attendance:
 *   post:
 *     summary: Mark student attendance for exam
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
 *               - attended
 *             properties:
 *               studentId:
 *                 type: string
 *               attended:
 *                 type: boolean
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             attended: true
 *     responses:
 *       200:
 *         description: Attendance marked
 */
router.post('/mark-attendance', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(markAttendanceSchema), markAttendance);

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
 *               - allottedBranch
 *             properties:
 *               studentId:
 *                 type: string
 *               allottedBranch:
 *                 type: string
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             allottedBranch: "CSE"
 *     responses:
 *       200:
 *         description: Seat allotted successfully
 */
router.post('/verify-allot', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(verifyAndAllotSeatSchema), verifyAndAllotSeat);

/**
 * @swagger
 * /admin/change-branch:
 *   post:
 *     summary: Request change allotted branch
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
 *               - newBranch
 *               - reason
 *             properties:
 *               studentId:
 *                 type: string
 *               newBranch:
 *                 type: string
 *               reason:
 *                 type: string
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             newBranch: "ECE"
 *             reason: "Better career prospects"
 *     responses:
 *       200:
 *         description: Branch change requested
 */
router.post('/change-branch', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(changeBranchSchema), requestBranchChange);

/**
 * @swagger
 * /admin/approve-branch-change:
 *   post:
 *     summary: Approve branch change request (Super Admin)
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
 *         description: Branch change processed
 */
router.post('/approve-branch-change', authorize([Role.SUPER_ADMIN]), validateRequest(approveBranchChangeSchema), approveBranchChange);

/**
 * @swagger
 * /admin/create-discount:
 *   post:
 *     summary: Create a discount request (Admin)
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
 *               documentUrl:
 *                 type: string
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             reason: "Sports Quota"
 *             documentUrl: "https://example-bucket.s3.amazonaws.com/sports/cert.pdf"
 *     responses:
 *       201:
 *         description: Discount request created
 */
router.post('/create-discount', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createDiscountRequestSchema), createDiscountRequest);

/**
 * @swagger
 * /admin/review-discount:
 *   post:
 *     summary: Review discount request (Forward/Reject)
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
 *                 enum: [FORWARD, REJECT]
 *               remarks:
 *                 type: string
 *           example:
 *             requestId: "disc-req-123"
 *             action: "FORWARD"
 *             remarks: "Valid documents, forwarding to Super Admin"
 *     responses:
 *       200:
 *         description: Discount request reviewed
 */
router.post('/review-discount', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(reviewDiscountRequestSchema), reviewDiscountRequest);

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
router.post('/request-cancellation', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(requestCancellationSchema), requestCancellation);

// Super Admin Operations
/**
 * @swagger
 * /admin/approve-discount:
 *   post:
 *     summary: Approve discount request (Super Admin)
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
 *             requestId: "disc-req-123"
 *             action: "APPROVE"
 *     responses:
 *       200:
 *         description: Discount request processed
 */
router.post('/approve-discount', authorize([Role.SUPER_ADMIN]), validateRequest(approveDiscountSchema), approveDiscount);

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
router.post('/approve-cancellation', authorize([Role.SUPER_ADMIN]), validateRequest(approveCancellationSchema), approveCancellation);



/**
 * @swagger
 * /admin/update-exam-score:
 *   post:
 *     summary: Update student exam score and qualification status
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
 *               - score
 *               - cutoff
 *             properties:
 *               studentId:
 *                 type: string
 *               score:
 *                 type: number
 *               cutoff:
 *                 type: number
 *           example:
 *             studentId: "550e8400-e29b-41d4-a716-446655440000"
 *             score: 85
 *             cutoff: 50
 *     responses:
 *       200:
 *         description: Exam score updated
 */
router.post('/update-exam-score', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateExamScoreSchema), updateExamScore);

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
router.get('/download-documents/:studentId', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(studentIdParamSchema), downloadStudentDocuments);

/**
 * @swagger
 * /admin/transport-route:
 *   post:
 *     summary: Create a transport route
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
 *               - cost
 *             properties:
 *               name:
 *                 type: string
 *               cost:
 *                 type: number
 *               busNumber:
 *                 type: string
 *               capacity:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Transport route created
 *   get:
 *     summary: Get all transport routes
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of transport routes
 */
router.post('/transport-route', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createTransportRouteSchema), createTransportRoute);
router.get('/transport-route', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getTransportRoutes);

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
router.post('/update-admission', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(updateAdmissionDetailsSchema), updateAdmissionDetails);

/**
 * @swagger
 * /admin/fee-stats:
 *   get:
 *     summary: Get fee statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Fee statistics retrieved
 */
router.get('/fee-stats', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getFeeStatistics);

// Generate Invigilator Credentials
/**
 * @swagger
 * /admin/generate-invigilator-credentials:
 *   post:
 *     summary: Generate bulk invigilator credentials
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
 *               - count
 *               - validFrom
 *               - validUntil
 *             properties:
 *               count:
 *                 type: integer
 *               validFrom:
 *                 type: string
 *                 format: date-time
 *               validUntil:
 *                 type: string
 *                 format: date-time
 *           example:
 *             count: 5
 *             validFrom: "2025-05-10T08:00:00.000Z"
 *             validUntil: "2025-05-10T18:00:00.000Z"
 *     responses:
 *       200:
 *         description: Credentials generated
 */
router.post('/generate-invigilator-credentials', authorize([Role.ADMIN, Role.SUPER_ADMIN]), generateInvigilatorCredentials);

/**
 * @swagger
 * /admin/branch:
 *   post:
 *     summary: Create a new branch
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
 *         description: Branch created successfully
 */
router.post('/branch', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createBranchSchema), createBranch);

// ERP Routes
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
router.post('/academic-year', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createAcademicYearSchema), createAcademicYear);

// Academics
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
router.post('/department', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createDepartmentSchema), createDepartment);

/**
 * @swagger
 * /admin/program:
 *   post:
 *     summary: Create a new program
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
 *               - departmentId
 *             properties:
 *               name:
 *                 type: string
 *               departmentId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Program created
 */
router.post('/program', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createProgramSchema), createProgram);

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
 *               - programId
 *               - startDate
 *               - endDate
 *             properties:
 *               name:
 *                 type: string
 *               programId:
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
router.post('/batch', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createBatchSchema), createBatch);

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
router.post('/section', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createSectionSchema), createSection);

// Hostel
/**
 * @swagger
 * /admin/hostel-block:
 *   post:
 *     summary: Create a new hostel block
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
 *               - hostelId
 *               - name
 *               - type
 *             properties:
 *               hostelId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *     responses:
 *       200:
 *         description: Hostel block created
 */
router.post('/hostel-block', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createHostelBlockSchema), createHostelBlock);

/**
 * @swagger
 * /admin/hostel-room:
 *   post:
 *     summary: Create a new hostel room
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
 *               - blockId
 *               - number
 *               - capacity
 *               - type
 *             properties:
 *               blockId:
 *                 type: string
 *                 format: uuid
 *               number:
 *                 type: string
 *               capacity:
 *                 type: integer
 *               type:
 *                 type: string
 *     responses:
 *       200:
 *         description: Hostel room created
 */
router.post('/hostel-room', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createHostelRoomSchema), createHostelRoom);

// Transport
/**
 * @swagger
 * /admin/vehicle:
 *   post:
 *     summary: Create a new vehicle
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
 *               - number
 *               - capacity
 *               - driverName
 *               - driverPhone
 *             properties:
 *               number:
 *                 type: string
 *               capacity:
 *                 type: integer
 *               driverName:
 *                 type: string
 *               driverPhone:
 *                 type: string
 *     responses:
 *       200:
 *         description: Vehicle created
 */
router.post('/vehicle', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createVehicleSchema), createVehicle);

/**
 * @swagger
 * /admin/transport-stop:
 *   post:
 *     summary: Create a new transport stop
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
 *               - routeId
 *               - name
 *               - sequence
 *               - pickupTime
 *               - dropTime
 *             properties:
 *               routeId:
 *                 type: string
 *                 format: uuid
 *               name:
 *                 type: string
 *               sequence:
 *                 type: integer
 *               pickupTime:
 *                 type: string
 *                 format: date-time
 *               dropTime:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Transport stop created
 */
router.post('/transport-stop', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createTransportStopSchema), createTransportStop);

// Finance
/**
 * @swagger
 * /admin/fee-head:
 *   post:
 *     summary: Create a new fee head
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
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fee head created
 */
router.post('/fee-head', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createFeeHeadSchema), createFeeHead);

/**
 * @swagger
 * /admin/fee-structure:
 *   post:
 *     summary: Create a new fee structure
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
 *               - programId
 *               - feeHeadId
 *               - amount
 *               - academicYear
 *             properties:
 *               programId:
 *                 type: string
 *                 format: uuid
 *               feeHeadId:
 *                 type: string
 *                 format: uuid
 *               amount:
 *                 type: number
 *               academicYear:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fee structure created
 */
router.post('/fee-structure', authorize([Role.ADMIN, Role.SUPER_ADMIN]), validateRequest(createFeeStructureSchema), createFeeStructure);
router.get('/fee-structure', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getFeeStructures);
router.put('/fee-structure/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateFeeStructure);
router.delete('/fee-structure/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteFeeStructure);

// Department
router.get('/department', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getDepartments);
router.put('/department/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateDepartment);
router.delete('/department/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteDepartment);

// Program
router.get('/program', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getPrograms);
router.put('/program/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateProgram);
router.delete('/program/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteProgram);

// Branch
router.get('/branch', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getBranches);
router.put('/branch/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateBranch);
router.delete('/branch/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteBranch);

// Fee Head
router.get('/fee-head', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getFeeHeads);
router.put('/fee-head/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateFeeHead);
router.delete('/fee-head/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteFeeHead);



// Document Requirements Management
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
router.post('/document-requirements', authorize([Role.ADMIN, Role.SUPER_ADMIN]), addRequirement);
router.get('/document-requirements', authorize([Role.ADMIN, Role.SUPER_ADMIN]), listRequirements);

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
router.put('/document-requirements/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateRequirement);
router.delete('/document-requirements/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), removeRequirement);



// Verify Student Document
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
router.post('/verify-document/:studentId', authorize([Role.ADMIN, Role.SUPER_ADMIN]), verifyStudentDocument);

// Academic Year
router.get('/academic-year', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getAcademicYears);
router.put('/academic-year/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateAcademicYear);
router.delete('/academic-year/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteAcademicYear);

// Batch
router.get('/batch', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getBatches);
router.put('/batch/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateBatch);
router.delete('/batch/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteBatch);

// Section
router.get('/section', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getSections);
router.put('/section/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateSection);
router.delete('/section/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteSection);

// Hostel Block
router.get('/hostel-block', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getHostelBlocks);
router.put('/hostel-block/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateHostelBlock);
router.delete('/hostel-block/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteHostelBlock);

// Hostel Room
router.get('/hostel-room', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getHostelRooms);
router.put('/hostel-room/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateHostelRoom);
router.delete('/hostel-room/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteHostelRoom);

// Vehicle
router.get('/vehicle', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getVehicles);
router.put('/vehicle/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateVehicle);
router.delete('/vehicle/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteVehicle);

// Transport Stop
router.get('/transport-stop', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getTransportStops);
router.put('/transport-stop/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), updateTransportStop);
router.delete('/transport-stop/:id', authorize([Role.ADMIN, Role.SUPER_ADMIN]), deleteTransportStop);

/**
 * @swagger
 * /admin/user-details:
 *   get:
 *     summary: Get user details by phone or email
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: phone
 *         schema:
 *           type: string
 *       - in: query
 *         name: email
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User details retrieved
 */
router.get('/user-details', authorize([Role.ADMIN, Role.SUPER_ADMIN]), getUserDetails);

export default router;
