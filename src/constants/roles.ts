export const Role = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  AGENT: 'AGENT',
  STUDENT: 'STUDENT',
  INVIGILATOR: 'INVIGILATOR',
  STAFF: 'STAFF',
  VERIFICATION_OFFICER: 'VERIFICATION_OFFICER',
  PRO: 'PRO',
} as const;

export type RoleType = keyof typeof Role;
