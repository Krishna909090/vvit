/**
 * ============================================================================
 * ADMISSION STATUS LIFECYCLE - FINAL ENTERPRISE VERSION
 * ============================================================================
 * 
 * CRITICAL CHANGES BASED ON ARCHITECT REVIEW:
 * 1. ✅ APPLICATION_FEE_PAID → ENTRANCE_FEE_PAID (globally applicable)
 * 2. ✅ Removed TOKEN_FEE_PAID (financial event, not lifecycle state)
 * 3. ✅ Added qualificationMode (EXAM vs DIRECT) for clean reporting
 * 4. ✅ Removed GRADUATED (moved to EnrollmentStatus.COMPLETED)
 * 5. ✅ NO ERP access before ADMISSION_CONFIRMED (removed all exceptions)
 * 6. ✅ Document upload stays OUTSIDE ERP (Portal only)
 * 7. ✅ Central state transition validator (mandatory)
 * 
 * ERP ACCESS RULE (MANDATORY):
 * ERP ACCESS = status === 'ADMISSION_CONFIRMED' || status === 'ENROLLED'
 * NO EXCEPTIONS!
 * 
 * ============================================================================
 */

import {
  AdmissionStatus as PrismaAdmissionStatus,
  EnrollmentStatus
} from '@prisma/client';

// Re-export Prisma enums
export {
  AdmissionStatus,
  EnrollmentStatus
} from '@prisma/client';

// Local type — QualificationMode is no longer a stored Prisma enum.
// Kept as a string-union to preserve the helper-function signatures that
// branch on EXAM vs DIRECT logic at runtime (e.g., dashboard breakdowns).
export type QualificationMode = 'EXAM' | 'DIRECT';


/**
 * ============================================================================
 * VALID STATE TRANSITIONS (State Machine)
 * ============================================================================
 * 
 * All status updates MUST go through validateStatusTransition().
 * Direct updates are FORBIDDEN for audit compliance.
 */
export const VALID_STATUS_TRANSITIONS: Record<PrismaAdmissionStatus, PrismaAdmissionStatus[]> = {
  // Phase 1: Application
  REGISTERED: [
    'ENTRANCE_FEE_PAID',
    'REJECTED',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  ENTRANCE_FEE_PAID: [
    'EXAM_SCHEDULED',      // EXAM mode: Management students
    'EXAM_QUALIFIED',      // DIRECT mode: Convenor students (skip exam)
    'REJECTED',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  EXAM_SCHEDULED: [
    'EXAM_ATTENDED',
    'CANCELLED',
    'REJECTED'
  ] as PrismaAdmissionStatus[],
  
  EXAM_ATTENDED: [
    'EXAM_QUALIFIED',
    'EXAM_NOT_QUALIFIED',
    'REJECTED'
  ] as PrismaAdmissionStatus[],
  
  EXAM_QUALIFIED: [
    'DOCUMENTS_PENDING',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  // Phase 2: Document Verification (Portal ONLY - NOT ERP)
  DOCUMENTS_PENDING: [
    'DOCUMENTS_SUBMITTED',
    'CANCELLED',
    'REJECTED'
  ] as PrismaAdmissionStatus[],
  
  DOCUMENTS_SUBMITTED: [
    'DOCUMENTS_VERIFIED',
    'DOCUMENTS_PENDING',   // Admin requests re-upload
    'REJECTED',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  DOCUMENTS_VERIFIED: [
    'SEAT_ALLOTTED',
    'REJECTED',            // No seats available
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  // Phase 3: Admission Confirmation
  SEAT_ALLOTTED: [
    'ADMISSION_CONFIRMED', // Token fee paid, admission confirmed
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  ADMISSION_CONFIRMED: [
    'ENROLLED',            // University assigns roll number
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  // Phase 4: Enrollment (Academic lifecycle begins)
  ENROLLED: [
    'CANCELLED'            // Dropout/withdrawal
  ] as PrismaAdmissionStatus[],
  
  // Terminal States (No transitions allowed)
  EXAM_NOT_QUALIFIED: [] as PrismaAdmissionStatus[],
  REJECTED: [] as PrismaAdmissionStatus[],
  CANCELLED: [] as PrismaAdmissionStatus[]
};

/**
 * ============================================================================
 * MIGRATION MAP: OLD → NEW
 * ============================================================================
 */
export const STATUS_MIGRATION_MAP: Record<string, PrismaAdmissionStatus> = {
  'QUALIFIED': 'EXAM_QUALIFIED',
  'TEST_FEE_PAID': 'ENTRANCE_FEE_PAID',
  'APPLICATION_FEE_PAID': 'ENTRANCE_FEE_PAID',
  'HALL_TICKET_GENERATED': 'EXAM_SCHEDULED',
  'DOCUMENTS_UPLOADED': 'DOCUMENTS_SUBMITTED',
  'TOKEN_FEE_PAID': 'ADMISSION_CONFIRMED', // Financial event merged into confirmation
  'GRADUATED': 'ENROLLED' // Graduation moved to EnrollmentStatus
};

/**
 * ============================================================================
 * CORE HELPER FUNCTIONS
 * ============================================================================
 */

/**
 * ERP ACCESS CONTROL (CRITICAL - NO EXCEPTIONS)
 * 
 * Rule: ERP access ONLY for ADMISSION_CONFIRMED or ENROLLED status.
 * Previous "limited access for convenor" has been REMOVED for security.
 * 
 * @param status Current admission status
 * @returns true if ERP access allowed
 */
export function isErpAccessAllowed(status: PrismaAdmissionStatus): boolean {
  return status === 'ADMISSION_CONFIRMED' || status === 'ENROLLED';
}

/**
 * Document upload permission check
 * Documents uploaded in PORTAL (not ERP), regardless of student type.
 * 
 * @param status Current admission status
 * @returns true if document upload is allowed
 */
export function canUploadDocuments(status: PrismaAdmissionStatus): boolean {
  return status === 'DOCUMENTS_PENDING';
}

/**
 * Seat allocation permission check (Admin only)
 * 
 * @param status Current admission status
 * @returns true if seat allocation is allowed
 */
export function canAllocateSeat(status: PrismaAdmissionStatus): boolean {
  return status === 'DOCUMENTS_VERIFIED';
}

/**
 * Check if status is terminal (no further transitions)
 * 
 * @param status Admission status to check
 * @returns true if terminal state
 */
export function isTerminalStatus(status: PrismaAdmissionStatus): boolean {
  return status === 'REJECTED' || status === 'CANCELLED' || status === 'EXAM_NOT_QUALIFIED';
}

/**
 * Check if status requires exam-related actions
 * Only applicable to EXAM qualification mode students.
 * 
 * @param status Admission status to check
 * @returns true if exam-related status
 */
export function isExamRelatedStatus(status: PrismaAdmissionStatus): boolean {
  const examStatuses: PrismaAdmissionStatus[] = [
    'EXAM_SCHEDULED',
    'EXAM_ATTENDED'
  ];
  return examStatuses.includes(status);
}

/**
 * CENTRAL STATUS TRANSITION VALIDATOR (MANDATORY)
 * 
 * ALL status updates MUST call this function.
 * Direct status updates are FORBIDDEN.
 * 
 * @param currentStatus Current admission status
 * @param newStatus Desired new status
 * @throws Error if transition is invalid
 * @returns true if transition is valid
 */
export function validateStatusTransition(
  currentStatus: PrismaAdmissionStatus,
  newStatus: PrismaAdmissionStatus
): boolean {
  // Cannot transition from terminal states
  if (isTerminalStatus(currentStatus)) {
    throw new Error(
      `Cannot transition from terminal status: ${currentStatus}`
    );
  }
  
  // Get allowed transitions
  const allowedTransitions = VALID_STATUS_TRANSITIONS[currentStatus] || [];
  
  // Validate transition
  if (!allowedTransitions.includes(newStatus)) {
    throw new Error(
      `Invalid status transition: ${currentStatus} → ${newStatus}. ` +
      `Allowed transitions: ${allowedTransitions.join(', ') || 'none'}`
    );
  }
  
  return true;
}

/**
 * Get human-readable status label
 * 
 * @param status Admission status
 * @returns User-friendly label
 */
export function getStatusLabel(status: PrismaAdmissionStatus): string {
  const labels: Record<PrismaAdmissionStatus, string> = {
    REGISTERED: 'Registered',
    ENTRANCE_FEE_PAID: 'Entrance Fee Paid',
    EXAM_SCHEDULED: 'Exam Scheduled',
    EXAM_ATTENDED: 'Exam Attended',
    EXAM_QUALIFIED: 'Qualified for Admission',
    EXAM_NOT_QUALIFIED: 'Not Qualified in Entrance Exam',
    DOCUMENTS_PENDING: 'Documents Pending',
    DOCUMENTS_SUBMITTED: 'Documents Under Review',
    DOCUMENTS_VERIFIED: 'Documents Verified',
    SEAT_ALLOTTED: 'Seat Allotted',
    ADMISSION_CONFIRMED: 'Admission Confirmed',
    ENROLLED: 'Enrolled',
    REJECTED: 'Application Rejected',
    CANCELLED: 'Application Cancelled'
  };
  
  return labels[status] || status;
}

/**
 * Get status category for grouping/filtering
 * 
 * @param status Admission status
 * @returns Category string
 */
export function getStatusCategory(status: PrismaAdmissionStatus): string {
  if (['REGISTERED', 'ENTRANCE_FEE_PAID'].includes(status)) {
    return 'APPLICATION';
  }
  
  if (isExamRelatedStatus(status) || status === 'EXAM_QUALIFIED') {
    return 'EXAMINATION';
  }
  
  if ([
    'DOCUMENTS_PENDING',
    'DOCUMENTS_SUBMITTED',
    'DOCUMENTS_VERIFIED'
  ].includes(status)) {
    return 'VERIFICATION';
  }
  
  if (['SEAT_ALLOTTED', 'ADMISSION_CONFIRMED'].includes(status)) {
    return 'ADMISSION';
  }
  
  if (status === 'ENROLLED') {
    return 'ENROLLMENT';
  }
  
  if (isTerminalStatus(status)) {
    return 'TERMINAL';
  }
  
  return 'UNKNOWN';
}

/**
 * Get next expected status based on qualification mode
 * 
 * @param currentStatus Current status
 * @param qualificationMode EXAM or DIRECT
 * @returns Next expected status or null
 */
export function getNextExpectedStatus(
  currentStatus: PrismaAdmissionStatus,
  qualificationMode: QualificationMode = 'EXAM'
): PrismaAdmissionStatus | null {
  // EXAM mode (Management quota)
  if (qualificationMode === 'EXAM') {
    const examFlow: Partial<Record<PrismaAdmissionStatus, PrismaAdmissionStatus>> = {
      REGISTERED: 'ENTRANCE_FEE_PAID',
      ENTRANCE_FEE_PAID: 'EXAM_SCHEDULED',
      EXAM_SCHEDULED: 'EXAM_ATTENDED',
      EXAM_ATTENDED: 'EXAM_QUALIFIED',
      EXAM_QUALIFIED: 'DOCUMENTS_PENDING',
      DOCUMENTS_PENDING: 'DOCUMENTS_SUBMITTED',
      DOCUMENTS_SUBMITTED: 'DOCUMENTS_VERIFIED',
      DOCUMENTS_VERIFIED: 'SEAT_ALLOTTED',
      SEAT_ALLOTTED: 'ADMISSION_CONFIRMED',
      ADMISSION_CONFIRMED: 'ENROLLED'
    };
    return examFlow[currentStatus] || null;
  }
  
  // DIRECT mode (Convenor quota) - skip exam
  const directFlow: Partial<Record<PrismaAdmissionStatus, PrismaAdmissionStatus>> = {
    REGISTERED: 'ENTRANCE_FEE_PAID',
    ENTRANCE_FEE_PAID: 'EXAM_QUALIFIED', // Auto-qualify, skip exam
    EXAM_QUALIFIED: 'DOCUMENTS_PENDING',
    DOCUMENTS_PENDING: 'DOCUMENTS_SUBMITTED',
    DOCUMENTS_SUBMITTED: 'DOCUMENTS_VERIFIED',
    DOCUMENTS_VERIFIED: 'SEAT_ALLOTTED',
    SEAT_ALLOTTED: 'ADMISSION_CONFIRMED',
    ADMISSION_CONFIRMED: 'ENROLLED'
  };
  return directFlow[currentStatus] || null;
}

/**
 * Check if portal access is allowed
 * Portal access denied only for REJECTED status.
 * 
 * @param status Current admission status
 * @returns true if portal access allowed
 */
export function isPortalAccessAllowed(status: PrismaAdmissionStatus): boolean {
  return status !== 'REJECTED';
}

/**
 * Get required actions for student at current status
 * 
 * @param status Current admission status
 * @param qualificationMode Student's qualification mode
 * @returns Array of action descriptions
 */
export function getRequiredActions(
  status: PrismaAdmissionStatus,
  qualificationMode: QualificationMode = 'EXAM'
): string[] {
  const isExamMode = qualificationMode === 'EXAM';
  
  const actions: Partial<Record<PrismaAdmissionStatus, string[]>> = {
    REGISTERED: [
      'Pay entrance fee to proceed'
    ],
    ENTRANCE_FEE_PAID: isExamMode
      ? ['Book your exam slot', 'Download hall ticket']
      : ['Wait for document upload request'],
    EXAM_SCHEDULED: [
      'Download hall ticket',
      'Attend exam on scheduled date'
    ],
    EXAM_ATTENDED: [
      'Wait for exam results'
    ],
    EXAM_QUALIFIED: [
      'Wait for document upload request'
    ],
    EXAM_NOT_QUALIFIED: [
      'You have not qualified in the entrance exam.',
      'Contact administration for further details.'
    ],
    DOCUMENTS_PENDING: [
      'Upload all required documents in Portal'
    ],
    DOCUMENTS_SUBMITTED: [
      'Wait for admin document verification'
    ],
    DOCUMENTS_VERIFIED: [
      'Wait for seat allocation by admin'
    ],
    SEAT_ALLOTTED: [
      'Pay token fee to confirm your seat'
    ],
    ADMISSION_CONFIRMED: [
      'Access ERP system for further steps',
      'Select hostel and transport options',
      'Complete remaining formalities'
    ],
    ENROLLED: [
      'Check your roll number',
      'Attend classes'
    ],
    REJECTED: [
      'Application has been rejected. Contact admin for details.'
    ],
    CANCELLED: [
      'Application has been cancelled.'
    ]
  };
  
  return actions[status] || [];
}

/**
 * Get qualification mode label
 * 
 * @param mode Qualification mode
 * @returns Human-readable label
 */
export function getQualificationModeLabel(mode: QualificationMode): string {
  return mode === 'EXAM' ? 'Entrance Exam' : 'Direct Admission';
}

/**
 * Get enrollment status label
 * 
 * @param status Enrollment status
 * @returns Human-readable label
 */
export function getEnrollmentStatusLabel(status: EnrollmentStatus): string {
  const labels: Record<EnrollmentStatus, string> = {
    ACTIVE: 'Active',
    SUSPENDED: 'Suspended',
    DROPPED: 'Dropped Out',
    COMPLETED: 'Graduated'
  };
  return labels[status] || status;
}

/**
 * Check if student can access ERP features based on admission status
 * This is the FINAL authority on ERP access.
 * 
 * @param admissionStatus Current admission status
 * @returns Object with access permissions
 */
export function getErpPermissions(admissionStatus: PrismaAdmissionStatus) {
  const hasFullAccess = isErpAccessAllowed(admissionStatus);
  
  return {
    canAccessErp: hasFullAccess,
    canViewDashboard: hasFullAccess,
    canSelectHostel: hasFullAccess,
    canSelectTransport: hasFullAccess,
    canViewFeeDetails: hasFullAccess,
    canViewAcademicInfo: hasFullAccess,
    message: hasFullAccess
      ? 'Full ERP access granted'
      : `ERP access requires ${admissionStatus === 'SEAT_ALLOTTED' ? 'token fee payment' : 'admission confirmation'}`
  };
}
