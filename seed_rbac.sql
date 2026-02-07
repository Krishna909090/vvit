-- 1. Insert Modules
INSERT INTO "Module" ("id", "name", "code", "updatedAt")
SELECT gen_random_uuid(), 'Authentication', 'AUTH', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Module" WHERE code = 'AUTH');

INSERT INTO "Module" ("id", "name", "code", "updatedAt")
SELECT gen_random_uuid(), 'Student Management', 'STUDENT', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Module" WHERE code = 'STUDENT');

INSERT INTO "Module" ("id", "name", "code", "updatedAt")
SELECT gen_random_uuid(), 'Admin Dashboard', 'ADMIN', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Module" WHERE code = 'ADMIN');

INSERT INTO "Module" ("id", "name", "code", "updatedAt")
SELECT gen_random_uuid(), 'Finance', 'FINANCE', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Module" WHERE code = 'FINANCE');

INSERT INTO "Module" ("id", "name", "code", "updatedAt")
SELECT gen_random_uuid(), 'Examination', 'EXAM', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Module" WHERE code = 'EXAM');

INSERT INTO "Module" ("id", "name", "code", "updatedAt")
SELECT gen_random_uuid(), 'Agent Management', 'AGENT', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Module" WHERE code = 'AGENT');

INSERT INTO "Module" ("id", "name", "code", "updatedAt")
SELECT gen_random_uuid(), 'Document Verification', 'VERIFICATION', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Module" WHERE code = 'VERIFICATION');

INSERT INTO "Module" ("id", "name", "code", "updatedAt")
SELECT gen_random_uuid(), 'Staff Portal', 'STAFF', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Module" WHERE code = 'STAFF');


-- 2. Insert Permissions (With 'code' column as per Prod schema)
INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'auth.login', 'auth.login', 'Can login', m.id, NOW()
FROM "Module" m WHERE m.code = 'AUTH'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'auth.login');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'auth.otp', 'auth.otp', 'Can request OTP', m.id, NOW()
FROM "Module" m WHERE m.code = 'AUTH'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'auth.otp');

-- Student
INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'student.view', 'student.view', 'View student profile', m.id, NOW()
FROM "Module" m WHERE m.code = 'STUDENT'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'student.view');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'student.edit', 'student.edit', 'Edit student profile', m.id, NOW()
FROM "Module" m WHERE m.code = 'STUDENT'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'student.edit');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'student.upload', 'student.upload', 'Upload documents', m.id, NOW()
FROM "Module" m WHERE m.code = 'STUDENT'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'student.upload');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'student.apply_scholarship', 'student.apply_scholarship', 'Apply for scholarship', m.id, NOW()
FROM "Module" m WHERE m.code = 'STUDENT'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'student.apply_scholarship');

-- Admin
INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'admin.view_dashboard', 'admin.view_dashboard', 'View admin dashboard', m.id, NOW()
FROM "Module" m WHERE m.code = 'ADMIN'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'admin.view_dashboard');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'admin.manage_users', 'admin.manage_users', 'Manage users', m.id, NOW()
FROM "Module" m WHERE m.code = 'ADMIN'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'admin.manage_users');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'admin.manage_settings', 'admin.manage_settings', 'Manage system settings', m.id, NOW()
FROM "Module" m WHERE m.code = 'ADMIN'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'admin.manage_settings');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'admin.manage_roles', 'admin.manage_roles', 'Manage roles and permissions', m.id, NOW()
FROM "Module" m WHERE m.code = 'ADMIN'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'admin.manage_roles');

-- Finance
INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'finance.view', 'finance.view', 'View financial data', m.id, NOW()
FROM "Module" m WHERE m.code = 'FINANCE'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'finance.view');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'finance.collect_fee', 'finance.collect_fee', 'Collect fees', m.id, NOW()
FROM "Module" m WHERE m.code = 'FINANCE'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'finance.collect_fee');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'finance.manage_discounts', 'finance.manage_discounts', 'Approve/Reject discounts', m.id, NOW()
FROM "Module" m WHERE m.code = 'FINANCE'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'finance.manage_discounts');

-- Exam
INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'exam.view', 'exam.view', 'View exam schedule', m.id, NOW()
FROM "Module" m WHERE m.code = 'EXAM'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'exam.view');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'exam.invigilate', 'exam.invigilate', 'Invigilation duties', m.id, NOW()
FROM "Module" m WHERE m.code = 'EXAM'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'exam.invigilate');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'exam.mark_attendance', 'exam.mark_attendance', 'Mark exam attendance', m.id, NOW()
FROM "Module" m WHERE m.code = 'EXAM'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'exam.mark_attendance');

-- Agent
INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'agent.register_student', 'agent.register_student', 'Register new student', m.id, NOW()
FROM "Module" m WHERE m.code = 'AGENT'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'agent.register_student');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'agent.view_commission', 'agent.view_commission', 'View commission status', m.id, NOW()
FROM "Module" m WHERE m.code = 'AGENT'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'agent.view_commission');

-- Verification
INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'verification.view_documents', 'verification.view_documents', 'View uploaded documents', m.id, NOW()
FROM "Module" m WHERE m.code = 'VERIFICATION'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'verification.view_documents');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'verification.approve_documents', 'verification.approve_documents', 'Approve documents', m.id, NOW()
FROM "Module" m WHERE m.code = 'VERIFICATION'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'verification.approve_documents');

INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'verification.reject_documents', 'verification.reject_documents', 'Reject documents', m.id, NOW()
FROM "Module" m WHERE m.code = 'VERIFICATION'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'verification.reject_documents');

-- Staff
INSERT INTO "Permission" ("id", "key", "code", "description", "moduleId", "updatedAt")
SELECT gen_random_uuid(), 'staff.view_roster', 'staff.view_roster', 'View student roster', m.id, NOW()
FROM "Module" m WHERE m.code = 'STAFF'
AND NOT EXISTS (SELECT 1 FROM "Permission" WHERE key = 'staff.view_roster');


-- 3. Insert Roles
INSERT INTO "Role" ("id", "name", "description", "updatedAt")
SELECT gen_random_uuid(), 'SUPER_ADMIN', 'Super Administrator with full access to all modules', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE name = 'SUPER_ADMIN');

INSERT INTO "Role" ("id", "name", "description", "updatedAt")
SELECT gen_random_uuid(), 'ADMIN', 'Administrator with management access', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE name = 'ADMIN');

INSERT INTO "Role" ("id", "name", "description", "updatedAt")
SELECT gen_random_uuid(), 'STUDENT', 'Standard Student Role', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE name = 'STUDENT');

INSERT INTO "Role" ("id", "name", "description", "updatedAt")
SELECT gen_random_uuid(), 'STAFF', 'Staff Member', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE name = 'STAFF');

INSERT INTO "Role" ("id", "name", "description", "updatedAt")
SELECT gen_random_uuid(), 'AGENT', 'External Admission Agent', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE name = 'AGENT');

INSERT INTO "Role" ("id", "name", "description", "updatedAt")
SELECT gen_random_uuid(), 'INVIGILATOR', 'Exam Invigilator', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE name = 'INVIGILATOR');

INSERT INTO "Role" ("id", "name", "description", "updatedAt")
SELECT gen_random_uuid(), 'VERIFICATION_OFFICER', 'Document Verification Officer', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Role" WHERE name = 'VERIFICATION_OFFICER');


-- 4. Assign Permissions to Roles

-- SUPER_ADMIN gets ALL permissions
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'SUPER_ADMIN'
AND NOT EXISTS (SELECT 1 FROM "RolePermission" rp WHERE rp."roleId" = r.id AND rp."permissionId" = p.id);

-- ADMIN
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'ADMIN'
  AND (p.key LIKE 'admin.%' OR p.key LIKE 'finance.%' OR p.key LIKE 'student.%')
  AND NOT EXISTS (SELECT 1 FROM "RolePermission" rp WHERE rp."roleId" = r.id AND rp."permissionId" = p.id);

-- STUDENT
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'STUDENT'
  AND p.key IN ('student.view', 'student.edit', 'student.upload', 'student.apply_scholarship', 'auth.login', 'auth.otp', 'exam.view')
  AND NOT EXISTS (SELECT 1 FROM "RolePermission" rp WHERE rp."roleId" = r.id AND rp."permissionId" = p.id);

-- AGENT
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'AGENT'
  AND p.key IN ('agent.register_student', 'agent.view_commission', 'auth.login', 'auth.otp')
  AND NOT EXISTS (SELECT 1 FROM "RolePermission" rp WHERE rp."roleId" = r.id AND rp."permissionId" = p.id);

-- VERIFICATION_OFFICER
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'VERIFICATION_OFFICER'
  AND p.key IN ('verification.view_documents', 'verification.approve_documents', 'verification.reject_documents', 'auth.login', 'auth.otp')
  AND NOT EXISTS (SELECT 1 FROM "RolePermission" rp WHERE rp."roleId" = r.id AND rp."permissionId" = p.id);

-- INVIGILATOR
INSERT INTO "RolePermission" ("roleId", "permissionId")
SELECT r.id, p.id
FROM "Role" r, "Permission" p
WHERE r.name = 'INVIGILATOR'
  AND p.key IN ('exam.invigilate', 'exam.mark_attendance', 'auth.login', 'auth.otp')
  AND NOT EXISTS (SELECT 1 FROM "RolePermission" rp WHERE rp."roleId" = r.id AND rp."permissionId" = p.id);


-- 5. Insert Groups
INSERT INTO "Group" ("id", "name", "type", "updatedAt")
SELECT gen_random_uuid(), 'SuperAdminGroup', 'SYSTEM', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Group" WHERE name = 'SuperAdminGroup');

INSERT INTO "Group" ("id", "name", "type", "updatedAt")
SELECT gen_random_uuid(), 'AdminGroup', 'SYSTEM', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Group" WHERE name = 'AdminGroup');

INSERT INTO "Group" ("id", "name", "type", "updatedAt")
SELECT gen_random_uuid(), 'StudentGroup', 'SYSTEM', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Group" WHERE name = 'StudentGroup');

INSERT INTO "Group" ("id", "name", "type", "updatedAt")
SELECT gen_random_uuid(), 'StaffGroup', 'SYSTEM', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Group" WHERE name = 'StaffGroup');

INSERT INTO "Group" ("id", "name", "type", "updatedAt")
SELECT gen_random_uuid(), 'AgentGroup', 'SYSTEM', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Group" WHERE name = 'AgentGroup');

INSERT INTO "Group" ("id", "name", "type", "updatedAt")
SELECT gen_random_uuid(), 'InvigilatorGroup', 'SYSTEM', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Group" WHERE name = 'InvigilatorGroup');

INSERT INTO "Group" ("id", "name", "type", "updatedAt")
SELECT gen_random_uuid(), 'VerificationOfficerGroup', 'SYSTEM', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Group" WHERE name = 'VerificationOfficerGroup');


-- 6. Assign Roles to Groups
INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id
FROM "Group" g, "Role" r
WHERE g.name = 'SuperAdminGroup' AND r.name = 'SUPER_ADMIN'
AND NOT EXISTS (SELECT 1 FROM "GroupRole" gr WHERE gr."groupId" = g.id AND gr."roleId" = r.id);

INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id
FROM "Group" g, "Role" r
WHERE g.name = 'AdminGroup' AND r.name = 'ADMIN'
AND NOT EXISTS (SELECT 1 FROM "GroupRole" gr WHERE gr."groupId" = g.id AND gr."roleId" = r.id);

INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id
FROM "Group" g, "Role" r
WHERE g.name = 'StudentGroup' AND r.name = 'STUDENT'
AND NOT EXISTS (SELECT 1 FROM "GroupRole" gr WHERE gr."groupId" = g.id AND gr."roleId" = r.id);

INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id
FROM "Group" g, "Role" r
WHERE g.name = 'StaffGroup' AND r.name = 'STAFF'
AND NOT EXISTS (SELECT 1 FROM "GroupRole" gr WHERE gr."groupId" = g.id AND gr."roleId" = r.id);

INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id
FROM "Group" g, "Role" r
WHERE g.name = 'AgentGroup' AND r.name = 'AGENT'
AND NOT EXISTS (SELECT 1 FROM "GroupRole" gr WHERE gr."groupId" = g.id AND gr."roleId" = r.id);

INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id
FROM "Group" g, "Role" r
WHERE g.name = 'InvigilatorGroup' AND r.name = 'INVIGILATOR'
AND NOT EXISTS (SELECT 1 FROM "GroupRole" gr WHERE gr."groupId" = g.id AND gr."roleId" = r.id);

INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id
FROM "Group" g, "Role" r
WHERE g.name = 'VerificationOfficerGroup' AND r.name = 'VERIFICATION_OFFICER'
AND NOT EXISTS (SELECT 1 FROM "GroupRole" gr WHERE gr."groupId" = g.id AND gr."roleId" = r.id);


-- 7. Backfill: Assign Existing Students to StudentGroup
INSERT INTO "UserGroup" ("userId", "groupId")
SELECT u.id, g.id
FROM "User" u, "Group" g
WHERE u.role = 'STUDENT'
  AND g.name = 'StudentGroup'
  AND NOT EXISTS (
      SELECT 1 FROM "UserGroup" ug 
      WHERE ug."userId" = u.id AND ug."groupId" = g.id
  );

-- 8. Backfill: Assign Existing Admins to AdminGroup
INSERT INTO "UserGroup" ("userId", "groupId")
SELECT u.id, g.id
FROM "User" u, "Group" g
WHERE u.role = 'ADMIN'
  AND g.name = 'AdminGroup'
  AND NOT EXISTS (
      SELECT 1 FROM "UserGroup" ug 
      WHERE ug."userId" = u.id AND ug."groupId" = g.id
  );

-- 9. Backfill: Assign Super Admins
INSERT INTO "UserGroup" ("userId", "groupId")
SELECT u.id, g.id
FROM "User" u, "Group" g
WHERE u.role = 'SUPER_ADMIN'
  AND g.name = 'SuperAdminGroup'
  AND NOT EXISTS (
      SELECT 1 FROM "UserGroup" ug 
      WHERE ug."userId" = u.id AND ug."groupId" = g.id
  );

-- 10. Ensure Default Super Admin User Exists
-- Credentials: Phone: 9999999999, Password: Admin@123
INSERT INTO "User" ("id", "name", "email", "phone", "role", "password", "updatedAt")
SELECT gen_random_uuid(), 'Super Admin', 'superadmin@college.com', '9999999999', 'SUPER_ADMIN', '$2b$10$P7ydPnpi0JzV871P3DST8.T4Gn/6Z13.fqL/foOW6TTdENpkxKZLW', NOW()
WHERE NOT EXISTS (SELECT 1 FROM "User" WHERE phone = '9999999999');

-- 11. Ensure Default Super Admin is in SuperAdminGroup
INSERT INTO "UserGroup" ("userId", "groupId")
SELECT u.id, g.id
FROM "User" u, "Group" g
WHERE u.phone = '9999999999'
  AND g.name = 'SuperAdminGroup'
  AND NOT EXISTS (
      SELECT 1 FROM "UserGroup" ug 
      WHERE ug."userId" = u.id AND ug."groupId" = g.id
  );
