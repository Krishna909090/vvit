-- BACKFILL SCRIPT FOR RBAC & PAYMENTS
-- Run this AFTER applying the Phase 1 Migration

BEGIN;

-- 1. MIGRATE PAYMENT METHODS
-- Map legacy text values to new Enum
UPDATE "Payment" 
SET "method" = CASE 
    WHEN "method_legacy" ILIKE '%upi%' THEN 'UPI'::"PaymentMethod"
    WHEN "method_legacy" ILIKE '%credit%' THEN 'CREDIT_CARD'::"PaymentMethod"
    WHEN "method_legacy" ILIKE '%debit%' THEN 'DEBIT_CARD'::"PaymentMethod"
    WHEN "method_legacy" ILIKE '%net%' THEN 'NET_BANKING'::"PaymentMethod"
    WHEN "method_legacy" ILIKE '%wallet%' THEN 'WALLET'::"PaymentMethod"
    WHEN "method_legacy" ILIKE '%cash%' THEN 'CASH'::"PaymentMethod"
    WHEN "method_legacy" ILIKE '%cheque%' THEN 'CHEQUE'::"PaymentMethod"
    WHEN "method_legacy" ILIKE '%draft%' THEN 'DEMAND_DRAFT'::"PaymentMethod"
    ELSE 'NET_BANKING'::"PaymentMethod" -- Default fallback or use NULL
END
WHERE "method" IS NULL AND "method_legacy" IS NOT NULL;

-- 2. SETUP DEFAULT RBAC STRUCTURE
-- Create Groups
INSERT INTO "Group" (id, name, type, "updatedAt") VALUES 
(gen_random_uuid(), 'SuperAdminGroup', 'SYSTEM', NOW()),
(gen_random_uuid(), 'StudentGroup', 'SYSTEM', NOW()),
(gen_random_uuid(), 'AdminGroup', 'SYSTEM', NOW()),
(gen_random_uuid(), 'AgentGroup', 'SYSTEM', NOW()),
(gen_random_uuid(), 'StaffGroup', 'SYSTEM', NOW())
ON CONFLICT (name) DO NOTHING;

-- Create Roles
INSERT INTO "Role" (id, name, "updatedAt") VALUES
(gen_random_uuid(), 'SUPER_ADMIN', NOW()),
(gen_random_uuid(), 'STUDENT', NOW()),
(gen_random_uuid(), 'ADMIN', NOW()),
(gen_random_uuid(), 'AGENT', NOW()),
(gen_random_uuid(), 'STAFF', NOW())
ON CONFLICT (name) DO NOTHING;

-- Link Groups -> Roles
-- (Assuming names match for simplicity)
INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id FROM "Group" g, "Role" r WHERE g.name = 'SuperAdminGroup' AND r.name = 'SUPER_ADMIN' ON CONFLICT DO NOTHING;

INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id FROM "Group" g, "Role" r WHERE g.name = 'StudentGroup' AND r.name = 'STUDENT' ON CONFLICT DO NOTHING;

INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id FROM "Group" g, "Role" r WHERE g.name = 'AdminGroup' AND r.name = 'ADMIN' ON CONFLICT DO NOTHING;

INSERT INTO "GroupRole" ("groupId", "roleId")
SELECT g.id, r.id FROM "Group" g, "Role" r WHERE g.name = 'AgentGroup' AND r.name = 'AGENT' ON CONFLICT DO NOTHING;

-- 3. MIGRATE USERS TO GROUPS (Based on Legacy Role)
-- Ensure casting is handled if legacy role is Enum or String
-- We treat it as text for safety.

-- Students
INSERT INTO "UserGroup" ("userId", "groupId")
SELECT u.id, g.id
FROM "User" u, "Group" g
WHERE u.role::text = 'STUDENT' AND g.name = 'StudentGroup'
ON CONFLICT DO NOTHING;

-- Admins
INSERT INTO "UserGroup" ("userId", "groupId")
SELECT u.id, g.id
FROM "User" u, "Group" g
WHERE u.role::text = 'ADMIN' AND g.name = 'AdminGroup'
ON CONFLICT DO NOTHING;

-- Super Admins
INSERT INTO "UserGroup" ("userId", "groupId")
SELECT u.id, g.id
FROM "User" u, "Group" g
WHERE u.role::text = 'SUPER_ADMIN' AND g.name = 'SuperAdminGroup'
ON CONFLICT DO NOTHING;

-- Agents
INSERT INTO "UserGroup" ("userId", "groupId")
SELECT u.id, g.id
FROM "User" u, "Group" g
WHERE u.role::text = 'AGENT' AND g.name = 'AgentGroup'
ON CONFLICT DO NOTHING;

COMMIT;
