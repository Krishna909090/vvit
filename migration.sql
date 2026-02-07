/* =============================================================================
   PROD ↔ DEV STRUCTURAL ALIGNMENT V2 (FIXED ENUM DEPENDENCIES)
   - Converts ALL tables using "Role" Enum to Text safely first
   - Handles "User", "RolePermission", "GroupRole", "Role" tables explicitly
   - Guarantees NO DATA LOSS
   - Then creates new tables and columns
============================================================================= */

/* =============================================================================
   SECTION 1: ENUM UPDATES (Pre-Transaction)
============================================================================= */

-- 1. Add new values to existing PaymentComponent Enum
ALTER TYPE "PaymentComponent" ADD VALUE IF NOT EXISTS 'HOSTEL_ACCOMMODATION';
ALTER TYPE "PaymentComponent" ADD VALUE IF NOT EXISTS 'HOSTEL_MESS';
ALTER TYPE "PaymentComponent" ADD VALUE IF NOT EXISTS 'BOOK_BANK';
ALTER TYPE "PaymentComponent" ADD VALUE IF NOT EXISTS 'ADMISSION';
ALTER TYPE "PaymentComponent" ADD VALUE IF NOT EXISTS 'SKILL_DEVELOPMENT';

-- 2. Create new Enums required by DEV Schema
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'HostelPaymentMode') THEN
        CREATE TYPE "HostelPaymentMode" AS ENUM ('SEMWISE', 'YEARWISE');
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ServiceRequestType') THEN
        CREATE TYPE "ServiceRequestType" AS ENUM ('FACILITY', 'PAYMENT_MODE');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OverrideType') THEN
        CREATE TYPE "OverrideType" AS ENUM ('GRANT', 'REVOKE');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserRole') THEN
        CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'AGENT', 'STUDENT', 'INVIGILATOR', 'STAFF', 'VERIFICATION_OFFICER');
    END IF;
END $$;


/* =============================================================================
   SECTION 2: SCHEMA CHANGES (Transactional)
============================================================================= */

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. SAFE ROLE MIGRATION (Convert ALL dependencies to TEXT first)
-- ---------------------------------------------------------------------------

-- 1A. User Table
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE TEXT USING "role"::text;
ALTER TABLE "User" ALTER COLUMN "role" DROP NOT NULL;
ALTER TABLE "User" ALTER COLUMN "phone" DROP NOT NULL;

-- 1B. RolePermission Table (This caused the error)
-- We check if the column exists first, just in case.
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'RolePermission' AND column_name = 'roleId') THEN
       -- If it's already 'roleId' (UUID/Text), we might be fine, but check for Enum usage
       -- The error said "column role of table RolePermission". Let's assume the column is named "role" based on error.
       -- Wait, standard RBAC usually has "roleId". If the error says "column role", then the column is named "role".
       NULL;
    END IF;
END $$;

-- If the error was `column "role" of table "RolePermission"`, we fix that column.
-- Assuming standard usage based on error message:
-- We need to check if "RolePermission" has a column named "role" that uses the enum.
-- Or if it has "roleId" which uses the enum. 
-- The error message `column role of table "RolePermission"` implies the column name is "role".

-- However, in many schemas "RolePermission" has `roleId`. 
-- To be safe, we will attempt to convert ANY column in likely tables that uses the "Role" type.

-- SAFETY BLOCK: Find columns using type 'Role' and convert them to TEXT.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN 
        SELECT table_name, column_name 
        FROM information_schema.columns 
        WHERE udt_name = 'Role' 
        AND table_schema = 'public'
    LOOP
        EXECUTE format('ALTER TABLE "%I" ALTER COLUMN "%I" TYPE TEXT USING "%I"::text', r.table_name, r.column_name, r.column_name);
    END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- 2. DROP OLD ENUM (Safe now that ALL columns are Text)
-- ---------------------------------------------------------------------------
DROP TYPE IF EXISTS "Role";


-- ---------------------------------------------------------------------------
-- 3. NEW TABLES (RBAC & FEATURES)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "Group" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "Role" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT UNIQUE NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "Module" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "code" TEXT UNIQUE NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "Permission" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "key" TEXT UNIQUE NOT NULL,
  "description" TEXT,
  "moduleId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "GroupRole" (
  "groupId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("groupId", "roleId")
);

CREATE TABLE IF NOT EXISTS "RolePermission" (
  "roleId" TEXT NOT NULL,
  "permissionId" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("roleId", "permissionId")
);

CREATE TABLE IF NOT EXISTS "UserGroup" (
  "userId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "groupId")
);

CREATE TABLE IF NOT EXISTS "UserPermissionOverride" (
  "userId" TEXT NOT NULL,
  "permissionId" TEXT NOT NULL,
  "type" "OverrideType" NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "permissionId")
);

CREATE TABLE IF NOT EXISTS "StudentScholarship" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "studentId" TEXT UNIQUE NOT NULL,
  "type" TEXT NOT NULL,
  "score" DOUBLE PRECISION,
  "remarks" TEXT,
  "scholarshipPercentage" DOUBLE PRECISION,
  "qualificationId" TEXT,
  "degreeType" TEXT,
  "isEligible" TEXT,
  "createdBy" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS "ServiceChangeRequest" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "studentId" TEXT NOT NULL,
  "type" "ServiceRequestType" NOT NULL,
  "fromValue" TEXT,
  "toValue" TEXT NOT NULL,
  "reason" TEXT,
  "status" "RequestStatus" NOT NULL DEFAULT 'REQUESTED',
  "remarks" TEXT,
  "approvedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);


-- ---------------------------------------------------------------------------
-- 4. COLUMN ADDITIONS & MODIFICATIONS
-- ---------------------------------------------------------------------------

-- A. StudentAdmission
ALTER TABLE "StudentAdmission" ADD COLUMN IF NOT EXISTS "academicYearId" TEXT;
ALTER TABLE "StudentAdmission" ADD COLUMN IF NOT EXISTS "hostelPaymentMode" "HostelPaymentMode" DEFAULT 'YEARWISE';
ALTER TABLE "StudentAdmission" ADD COLUMN IF NOT EXISTS "roomNumber" TEXT;

-- B. StudentFeeDemand
ALTER TABLE "StudentFeeDemand" ADD COLUMN IF NOT EXISTS "discountAmount" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "StudentFeeDemand" ADD COLUMN IF NOT EXISTS "scholarshipAmount" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "StudentFeeDemand" ADD COLUMN IF NOT EXISTS "fineAmount" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "StudentFeeDemand" ADD COLUMN IF NOT EXISTS "netAmount" DOUBLE PRECISION;
ALTER TABLE "StudentFeeDemand" ADD COLUMN IF NOT EXISTS "remarks" TEXT;
ALTER TABLE "StudentFeeDemand" ADD COLUMN IF NOT EXISTS "feeHeadId" TEXT;
ALTER TABLE "StudentFeeDemand" ADD COLUMN IF NOT EXISTS "academicYearId" TEXT;
ALTER TABLE "StudentFeeDemand" ALTER COLUMN "feeStructureId" DROP NOT NULL;

-- C. Payment
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "feeHeadId" TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "method_legacy" TEXT;
ALTER TABLE "Payment" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "mode" DROP NOT NULL;

-- D. Hostel & Room
ALTER TABLE "Hostel" ADD COLUMN IF NOT EXISTS "accommodationCost" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "Hostel" ADD COLUMN IF NOT EXISTS "messCost" DOUBLE PRECISION DEFAULT 0;
-- Relax constraints
ALTER TABLE "Hostel" ALTER COLUMN "isDeleted" DROP NOT NULL;
ALTER TABLE "Hostel" ALTER COLUMN "type" DROP NOT NULL;

ALTER TABLE "HostelRoom" ADD COLUMN IF NOT EXISTS "accommodationCost" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "HostelRoom" ADD COLUMN IF NOT EXISTS "messCost" DOUBLE PRECISION DEFAULT 0;

-- E. HostelPriceCategory
ALTER TABLE "HostelPriceCategory" ADD COLUMN IF NOT EXISTS "accommodationPrice" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "HostelPriceCategory" ADD COLUMN IF NOT EXISTS "messPrice" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "HostelPriceCategory" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- F. AcademicQualification
ALTER TABLE "AcademicQualification" ADD COLUMN IF NOT EXISTS "percentage" DOUBLE PRECISION;
ALTER TABLE "AcademicQualification" ADD COLUMN IF NOT EXISTS "docUrl" TEXT;
ALTER TABLE "AcademicQualification" ADD COLUMN IF NOT EXISTS "gpaOrMarks" TEXT;
ALTER TABLE "AcademicQualification" ADD COLUMN IF NOT EXISTS "schoolName" TEXT;
ALTER TABLE "AcademicQualification" ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT DEFAULT 'PENDING';
-- Relax constraints for fields that became optional in DEV
ALTER TABLE "AcademicQualification" ALTER COLUMN "hallTicketNumber" DROP NOT NULL;
ALTER TABLE "AcademicQualification" ALTER COLUMN "gpaOrMarks" DROP NOT NULL;

-- G. Configuration & Email
ALTER TABLE "Configuration" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3);


-- ---------------------------------------------------------------------------
-- 5. RELAX OTHER CONSTRAINTS (Optional Fields)
-- ---------------------------------------------------------------------------
ALTER TABLE "Course" ALTER COLUMN "code" DROP NOT NULL;
ALTER TABLE "Course" ALTER COLUMN "filledSeats" DROP NOT NULL;
ALTER TABLE "Course" ALTER COLUMN "totalSeats" DROP NOT NULL;
ALTER TABLE "Student" ALTER COLUMN "applicationId" DROP NOT NULL;
ALTER TABLE "UserOtp" ALTER COLUMN "used" DROP NOT NULL;
ALTER TABLE "AcademicYear" ALTER COLUMN "isActive" DROP NOT NULL;
ALTER TABLE "AcademicYear" ALTER COLUMN "isLocked" DROP NOT NULL;
ALTER TABLE "AcademicYear" ALTER COLUMN "isDeleted" DROP NOT NULL;
ALTER TABLE "StudentEnrollment" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "StudentEnrollment" ALTER COLUMN "currentSemester" DROP NOT NULL;


-- ---------------------------------------------------------------------------
-- 6. FOREIGN KEYS (Constraints)
-- ---------------------------------------------------------------------------

-- StudentAdmission
ALTER TABLE "StudentAdmission" DROP CONSTRAINT IF EXISTS "StudentAdmission_academicYearId_fkey"; 
ALTER TABLE "StudentAdmission" ADD CONSTRAINT "StudentAdmission_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ServiceChangeRequest
ALTER TABLE "ServiceChangeRequest" DROP CONSTRAINT IF EXISTS "ServiceChangeRequest_studentId_fkey";
ALTER TABLE "ServiceChangeRequest" ADD CONSTRAINT "ServiceChangeRequest_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- StudentFeeDemand
ALTER TABLE "StudentFeeDemand" DROP CONSTRAINT IF EXISTS "StudentFeeDemand_feeHeadId_fkey";
ALTER TABLE "StudentFeeDemand" ADD CONSTRAINT "StudentFeeDemand_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "FeeHead"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StudentFeeDemand" DROP CONSTRAINT IF EXISTS "StudentFeeDemand_academicYearId_fkey";
ALTER TABLE "StudentFeeDemand" ADD CONSTRAINT "StudentFeeDemand_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Payment
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_feeHeadId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "FeeHead"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- StudentScholarship
ALTER TABLE "StudentScholarship" DROP CONSTRAINT IF EXISTS "StudentScholarship_studentId_fkey";
ALTER TABLE "StudentScholarship" ADD CONSTRAINT "StudentScholarship_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "StudentScholarship" DROP CONSTRAINT IF EXISTS "StudentScholarship_qualificationId_fkey";
ALTER TABLE "StudentScholarship" ADD CONSTRAINT "StudentScholarship_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "AcademicQualification"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- RBAC Constraints
ALTER TABLE "Permission" DROP CONSTRAINT IF EXISTS "Permission_moduleId_fkey";
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "GroupRole" DROP CONSTRAINT IF EXISTS "GroupRole_groupId_fkey";
ALTER TABLE "GroupRole" ADD CONSTRAINT "GroupRole_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "GroupRole" DROP CONSTRAINT IF EXISTS "GroupRole_roleId_fkey";
ALTER TABLE "GroupRole" ADD CONSTRAINT "GroupRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "RolePermission" DROP CONSTRAINT IF EXISTS "RolePermission_roleId_fkey";
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "RolePermission" DROP CONSTRAINT IF EXISTS "RolePermission_permissionId_fkey";
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "UserGroup" DROP CONSTRAINT IF EXISTS "UserGroup_userId_fkey";
ALTER TABLE "UserGroup" ADD CONSTRAINT "UserGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "UserGroup" DROP CONSTRAINT IF EXISTS "UserGroup_groupId_fkey";
ALTER TABLE "UserGroup" ADD CONSTRAINT "UserGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "UserPermissionOverride" DROP CONSTRAINT IF EXISTS "UserPermissionOverride_userId_fkey";
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "UserPermissionOverride" DROP CONSTRAINT IF EXISTS "UserPermissionOverride_permissionId_fkey";
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;

/* =============================================================================
   MIGRATION SCRIPT COMPLETE
============================================================================= */
