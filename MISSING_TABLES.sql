-- MISSING TABLES RESTORATION
-- Run this to create tables that were missing from the original schema script.

BEGIN;

-- 1. Create EmailStatus Enum if not exists
DO $$ BEGIN
    CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Create EmailLog Table
CREATE TABLE IF NOT EXISTS "EmailLog" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT,
    "status" "EmailStatus" DEFAULT 'PENDING',
    "error" TEXT,
    "messageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Create AcademicQualification Table
CREATE TABLE IF NOT EXISTS "AcademicQualification" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "level" TEXT NOT NULL, -- e.g. "10th", "12th", "UG"
    "board" TEXT,
    "institution" TEXT,
    "yearOfPassing" INTEGER,
    "percentage" DOUBLE PRECISION,
    "docUrl" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMIT;
