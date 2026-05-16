import express from 'express';
import multer from 'multer';
import { authenticate, authorizePermission } from '../../../middleware/rbac.middleware';
import * as bulkImportController from './bulkImport.controller';

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.use(authenticate);
router.use(authorizePermission('admin.create.all'));

// ═══════════════════════════════════════════════════════════
//  BULK IMPORT - OFFLINE & SEAT-BOOKING STUDENT REGISTRATION
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /offline-students
 * @desc    Bulk-import offline-registered students from an uploaded Excel file.
 *          Parses the spreadsheet, validates rows, and creates student + enrollment records.
 * @side    Creates student accounts and enrollment records in the database for each valid row.
 * @body    multipart/form-data with field "file" (Excel .xlsx/.xls).
 * @returns 200 - { status: 'success', data: { created: number, errors: object[] } }
 */
router.post(
    '/offline-students',
    upload.single('file'),
    bulkImportController.importOfflineStudents
);

/**
 * @route   POST /seat-booking-students
 * @desc    Bulk-import seat-booking students from an uploaded Excel file.
 *          Processes students who have completed seat booking and creates their registration records.
 * @side    Creates student accounts and seat-booking records in the database for each valid row.
 * @body    multipart/form-data with field "file" (Excel .xlsx/.xls).
 * @returns 200 - { status: 'success', data: { created: number, errors: object[] } }
 */
router.post(
    '/seat-booking-students',
    upload.single('file'),
    bulkImportController.importSeatBookingStudents
);

// ═══════════════════════════════════════════════════════════
//  BULK IMPORT - PAYMENT VERIFICATION
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /verify-payment
 * @desc    Verify and record an offline payment for a specific student.
 *          Marks the payment as verified and updates the student's financial ledger.
 * @side    Updates payment status and financial records for the student.
 * @body    { studentId: string, amount: number, type: string }
 * @returns 200 - { status: 'success', data: PaymentVerificationResult }
 */
router.post(
    '/verify-payment',
    bulkImportController.verifyPayment
);

// ═══════════════════════════════════════════════════════════
//  BULK IMPORT - OFFLINE APPLICATION VALIDATION & IMPORT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /offline-applications/validate
 * @desc    Dry-run validation of an array of offline applications without persisting anything.
 *          Returns per-row validation results so the admin can fix errors before final import.
 * @side    None (read-only validation; no records are created or modified).
 * @body    Array of application objects: [ { name, phone, email, courseId, ... }, ... ]
 * @returns 200 - { status: 'success', message: string, data: { total: number, valid: number, invalid: number, results: object[] } }
 */
router.post(
    '/offline-applications/validate',
    bulkImportController.validateOfflineApplications
);

/**
 * @route   POST /offline-applications
 * @desc    Bulk-import offline applications after validation. Creates application records
 *          for each entry and triggers downstream enrollment workflows.
 * @side    Inserts application records into the database; may trigger notifications.
 * @body    Array of application objects: [ { name, phone, email, courseId, ... }, ... ]
 * @returns 200 - { status: 'success', data: { created: number, errors: object[] } }
 */
router.post(
    '/offline-applications',
    bulkImportController.importOfflineApplications
);

// ═══════════════════════════════════════════════════════════
//  BULK MANUAL ENTRY (lateral / transfer / back-dated cohort)
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /manual-entry/validate
 * @desc    Dry-run validation of an array of manual-entry admission records.
 *          Returns per-row validation results so the admin can fix errors before final import.
 * @side    None (read-only).
 * @body    Array<manualEntryAdmissionSchema.body>  (max 500 rows)
 * @returns 200 - { status: 'success', data: { total, valid, invalid, validRecords, invalidRecords } }
 */
router.post(
    '/manual-entry/validate',
    authorizePermission(['student.create.lateral']),
    bulkImportController.validateBulkManualEntry
);

/**
 * @route   POST /manual-entry
 * @desc    Bulk-import manual-entry admissions. Each row creates a Student + Admission +
 *          Enrollment + fee demands via AdminStudentService.manualEntryAdmission. Used for
 *          lateral entry, transfer, and back-dated cohort imports.
 * @side    Creates students, admissions, enrollments, and seeds fee demands.
 * @body    Array<manualEntryAdmissionSchema.body>  (max 500 rows)
 * @returns 200 - { status: 'success', data: { total, success, failed, created, errors } }
 */
router.post(
    '/manual-entry',
    authorizePermission(['student.create.lateral']),
    bulkImportController.importBulkManualEntry
);

/**
 * @route   GET /manual-entry/template
 * @desc    Download a CSV template for bulk manual-entry imports. The template includes
 *          all columns and one example row demonstrating a lateral-entry admission.
 * @returns 200 - text/csv attachment "manual-entry-template.csv"
 */
router.get(
    '/manual-entry/template',
    bulkImportController.downloadManualEntryTemplate
);

export default router;
