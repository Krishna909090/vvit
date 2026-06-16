

import {
  AdmissionStatus as PrismaAdmissionStatus,
  EnrollmentStatus
} from '@prisma/client';

export {
  AdmissionStatus,
  EnrollmentStatus
} from '@prisma/client';

export type QualificationMode = 'EXAM' | 'DIRECT';

export const VALID_STATUS_TRANSITIONS: Record<PrismaAdmissionStatus, PrismaAdmissionStatus[]> = {

  CONVENOR_REPORTED: [
    'DOCUMENTS_PENDING',
    'SEAT_ALLOTTED',
    'REJECTED',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],

  REGISTERED: [
    'ENTRANCE_FEE_PAID',
    'REJECTED',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  ENTRANCE_FEE_PAID: [
    'EXAM_SCHEDULED',
    'EXAM_QUALIFIED',
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

  DOCUMENTS_PENDING: [
    'DOCUMENTS_SUBMITTED',
    'CANCELLED',
    'REJECTED'
  ] as PrismaAdmissionStatus[],
  
  DOCUMENTS_SUBMITTED: [
    'DOCUMENTS_VERIFIED',
    'DOCUMENTS_PENDING',
    'REJECTED',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  DOCUMENTS_VERIFIED: [
    'SEAT_ALLOTTED',
    'REJECTED',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],

  SEAT_ALLOTTED: [
    'ADMISSION_CONFIRMED',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],
  
  ADMISSION_CONFIRMED: [
    'ENROLLED',
    'CANCELLED'
  ] as PrismaAdmissionStatus[],

  ENROLLED: [
    'CANCELLED'
  ] as PrismaAdmissionStatus[],

  EXAM_NOT_QUALIFIED: [] as PrismaAdmissionStatus[],
  REJECTED: [] as PrismaAdmissionStatus[],
  CANCELLED: [] as PrismaAdmissionStatus[]
};

export const STATUS_MIGRATION_MAP: Record<string, PrismaAdmissionStatus> = {
  'QUALIFIED': 'EXAM_QUALIFIED',
  'TEST_FEE_PAID': 'ENTRANCE_FEE_PAID',
  'APPLICATION_FEE_PAID': 'ENTRANCE_FEE_PAID',
  'HALL_TICKET_GENERATED': 'EXAM_SCHEDULED',
  'DOCUMENTS_UPLOADED': 'DOCUMENTS_SUBMITTED',
  'TOKEN_FEE_PAID': 'ADMISSION_CONFIRMED',
  'GRADUATED': 'ENROLLED'
};

export function isErpAccessAllowed(status: PrismaAdmissionStatus): boolean {
  return status === 'ADMISSION_CONFIRMED' || status === 'ENROLLED';
}

export function canUploadDocuments(status: PrismaAdmissionStatus): boolean {
  return status === 'DOCUMENTS_PENDING';
}

export function canAllocateSeat(status: PrismaAdmissionStatus): boolean {
  return status === 'DOCUMENTS_VERIFIED';
}

export function isTerminalStatus(status: PrismaAdmissionStatus): boolean {
  return status === 'REJECTED' || status === 'CANCELLED' || status === 'EXAM_NOT_QUALIFIED';
}

export function isExamRelatedStatus(status: PrismaAdmissionStatus): boolean {
  const examStatuses: PrismaAdmissionStatus[] = [
    'EXAM_SCHEDULED',
    'EXAM_ATTENDED'
  ];
  return examStatuses.includes(status);
}

export function validateStatusTransition(
  currentStatus: PrismaAdmissionStatus,
  newStatus: PrismaAdmissionStatus
): boolean {

  if (isTerminalStatus(currentStatus)) {
    throw new Error(
      `Cannot transition from terminal status: ${currentStatus}`
    );
  }

  const allowedTransitions = VALID_STATUS_TRANSITIONS[currentStatus] || [];

  if (!allowedTransitions.includes(newStatus)) {
    throw new Error(
      `Invalid status transition: ${currentStatus} → ${newStatus}. ` +
      `Allowed transitions: ${allowedTransitions.join(', ') || 'none'}`
    );
  }
  
  return true;
}

export function getStatusLabel(status: PrismaAdmissionStatus): string {
  const labels: Record<PrismaAdmissionStatus, string> = {
    CONVENOR_REPORTED: 'Convenor Reported',
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

export function getNextExpectedStatus(
  currentStatus: PrismaAdmissionStatus,
  qualificationMode: QualificationMode = 'EXAM'
): PrismaAdmissionStatus | null {

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

  const directFlow: Partial<Record<PrismaAdmissionStatus, PrismaAdmissionStatus>> = {
    REGISTERED: 'ENTRANCE_FEE_PAID',
    ENTRANCE_FEE_PAID: 'EXAM_QUALIFIED',
    EXAM_QUALIFIED: 'DOCUMENTS_PENDING',
    DOCUMENTS_PENDING: 'DOCUMENTS_SUBMITTED',
    DOCUMENTS_SUBMITTED: 'DOCUMENTS_VERIFIED',
    DOCUMENTS_VERIFIED: 'SEAT_ALLOTTED',
    SEAT_ALLOTTED: 'ADMISSION_CONFIRMED',
    ADMISSION_CONFIRMED: 'ENROLLED'
  };
  return directFlow[currentStatus] || null;
}

export function isPortalAccessAllowed(status: PrismaAdmissionStatus): boolean {
  return status !== 'REJECTED';
}

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

export function getQualificationModeLabel(mode: QualificationMode): string {
  return mode === 'EXAM' ? 'Entrance Exam' : 'Direct Admission';
}

export function getEnrollmentStatusLabel(status: EnrollmentStatus): string {
  const labels: Record<EnrollmentStatus, string> = {
    ACTIVE: 'Active',
    SUSPENDED: 'Suspended',
    DETAINED: 'Detained',
    DROPPED: 'Dropped Out',
    COMPLETED: 'Graduated'
  };
  return labels[status] || status;
}

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
