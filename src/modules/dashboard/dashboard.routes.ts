import { Router } from 'express';
import { DashboardController } from './dashboard.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

const router = Router();

// All dashboard routes require authentication + admin.read.all permission
router.use(authenticate, authorizePermission('admin.read.all'));

// ═══════════════════════════════════════════════════════════
//  APPLICATION & ADMISSION STATISTICS
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /application-stats
 * @desc    Returns aggregated application statistics (total, pending, approved, rejected).
 *          Used to populate the applications overview widget on the dashboard.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - { total, pending, approved, rejected, ... } counts.
 */
router.get('/application-stats', DashboardController.getApplicationStats);

/**
 * @route   GET /admission-stats
 * @desc    Returns admission funnel statistics (applied, admitted, enrolled, etc.).
 *          Provides a breakdown by admission stage for monitoring intake progress.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Admission stage counts and percentages.
 */
router.get('/admission-stats', DashboardController.getAdmissionStats);

/**
 * @route   GET /scholarship-stats
 * @desc    Scholarship counts (applicants, eligible-with-seat, not-eligible).
 *          Supports optional `degreeType` filter plus standard date filters
 *          (`range`, `startDate`, `endDate`).
 * @access  Requires `admin.read.all` permission.
 */
router.get('/scholarship-stats', DashboardController.getScholarshipStats);

// ═══════════════════════════════════════════════════════════
//  FINANCIAL STATISTICS
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /financial-stats
 * @desc    Returns financial overview data (fees collected, outstanding, refunds, etc.).
 *          Aggregates payment records for the admin financial summary.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Financial totals and breakdowns.
 */
router.get('/financial-stats', DashboardController.getFinancialStats);

// ═══════════════════════════════════════════════════════════
//  EXAM & VERIFICATION STATISTICS
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /exam-stats
 * @desc    Returns exam-related statistics (scheduled, completed, pending results).
 *          Summarises the current exam cycle status.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Exam counts grouped by status.
 */
router.get('/exam-stats', DashboardController.getExamStats);

/**
 * @route   GET /verification-stats
 * @desc    Returns document/score verification statistics (verified, pending, flagged).
 *          Helps admins track the verification backlog.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Verification counts grouped by status.
 */
router.get('/verification-stats', DashboardController.getVerificationStats);

// ═══════════════════════════════════════════════════════════
//  SEAT ALLOCATION & COURSE STATISTICS
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /degree-seat-stats
 * @desc    Returns seat allocation counts broken down by degree programme.
 *          Shows how many seats are filled vs. available per degree.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Array of { degree, allocated, total } objects.
 */
router.get('/degree-seat-stats', DashboardController.getDegreeSeatAllocatedStats);

/**
 * @route   GET /gender-seat-stats
 * @desc    Returns seat allocation counts broken down by gender.
 *          Used for diversity and compliance reporting.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Array of { gender, allocated, total } objects.
 */
router.get('/gender-seat-stats', DashboardController.getGenderSeatAllocatedStats);

/**
 * @route   GET /seat-allocation-stats
 * @desc    Returns comprehensive seat allocation statistics across all categories.
 *          Provides a full picture of seat utilisation for the current intake.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Detailed seat allocation breakdown.
 */
router.get('/seat-allocation-stats', DashboardController.getSeatAllocationStats);

/**
 * @route   GET /seat-allocation-counts
 * @desc    Returns simple numeric counts of allocated vs. unallocated seats.
 *          Lightweight endpoint for quick summary widgets.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - { allocated, unallocated, total } counts.
 */
router.get('/seat-allocation-counts', DashboardController.getSeatAllocationCounts);

/**
 * @route   GET /course-codes
 * @desc    Returns a list of all available course codes.
 *          Typically used to populate dropdown/filter options on the dashboard.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Array of course code strings or objects.
 */
router.get('/course-codes', DashboardController.getCourseCodes);

/**
 * @route   GET /course-stats
 * @desc    Returns per-course statistics (enrolment, capacity, fill rate).
 *          Provides a course-level breakdown for the admin dashboard.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Array of course statistic objects.
 */
router.get('/course-stats', DashboardController.getCourseStats);

// ═══════════════════════════════════════════════════════════
//  TRENDS & RECENT ACTIVITY
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /trends
 * @desc    Returns time-series registration trend data (daily/weekly/monthly).
 *          Powers the registration trend chart on the dashboard.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Array of { date, count } data points.
 */
router.get('/trends', DashboardController.getRegistrationTrends);

/**
 * @route   GET /recent-students
 * @desc    Returns the most recently registered or updated student records.
 *          Displays a quick-glance list of recent activity on the dashboard.
 * @access  Requires `admin.read.all` permission.
 * @returns {object} 200 - Array of recent student summary objects.
 */
router.get('/recent-students', DashboardController.getRecentStudents);

export default router;
