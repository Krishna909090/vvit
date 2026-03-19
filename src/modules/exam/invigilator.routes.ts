
import { Router } from 'express';
import { scanAttendance, verifyAttendance, manualScan } from './exam.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';
import { validateRequest } from '../../middlewares/validationMiddleware';
import { scanAttendanceSchema } from '../../validators/examValidators';
import { qrScanRateLimiter } from '../../middlewares/rateLimitMiddleware';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  INVIGILATOR ATTENDANCE ROUTES
// ═══════════════════════════════════════════════════════════

/**
 * POST /attendance/scan
 * Scans a student's QR code to look up their identity and mark a pending attendance record.
 * Rate-limited to prevent brute-force or rapid-fire scan abuse.
 * Side effects: Creates a pending attendance record; writes audit log on success or failure.
 * Body: { qrHash: string } (validated by scanAttendanceSchema)
 * Response: { status, data: { student, examDetails, attendanceRecordId } }
 */
router.post('/scan', qrScanRateLimiter, authenticate, authorizePermission('exam.update.all'), validateRequest(scanAttendanceSchema), scanAttendance);

/**
 * POST /attendance/manual-scan
 * Looks up a student by application ID and marks a pending attendance record.
 * Used as a fallback when QR scanning is unavailable or fails.
 * Side effects: Creates a pending attendance record; writes audit log on success or failure.
 * Body: { applicationId: string }
 * Response: { status, data: { student, examDetails, attendanceRecordId } }
 */
router.post('/manual-scan', authenticate, authorizePermission('exam.update.all'), manualScan);

/**
 * POST /attendance/verify
 * Confirms a previously scanned attendance record, finalising the student's presence.
 * Called after the invigilator visually validates the student against their details.
 * Side effects: Marks the attendance record as verified; writes audit log entry.
 * Body: { attendanceRecordId: string }
 * Response: { status, data: { studentId, studentName, applicationId, examCenter, verifiedAt } }
 */
router.post('/verify', authenticate, authorizePermission('exam.update.all'), verifyAttendance);

export default router;
