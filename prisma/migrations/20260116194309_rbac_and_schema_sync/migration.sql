/*
  Warnings:

  - The values [TEST_FEE_PAID,HALL_TICKET_GENERATED,DOCUMENTS_UPLOADED] on the enum `AdmissionStatus` will be removed. If these variants are still used in the database, this will fail.
  - The values [DETAINED,ALUMNI,DROPPED_OUT] on the enum `EnrollmentStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `courseType` on the `DocumentRequirement` table. All the data in the column will be lost.
  - You are about to drop the column `providerTx` on the `Payment` table. All the data in the column will be lost.
  - The `method` column on the `Payment` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `allottedSpecialization` on the `StudentAdmission` table. All the data in the column will be lost.
  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[code]` on the table `Course` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[degreeType,documentKey]` on the table `DocumentRequirement` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `specializationId` to the `Batch` table without a default value. This is not possible if the table is not empty.
  - Added the required column `code` to the `Course` table without a default value. This is not possible if the table is not empty.
  - Added the required column `degreeType` to the `DocumentRequirement` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `type` on the `Hostel` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `city` to the `TransportRoute` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'AGENT', 'STUDENT', 'INVIGILATOR', 'STAFF', 'VERIFICATION_OFFICER');

-- CreateEnum
CREATE TYPE "OverrideType" AS ENUM ('GRANT', 'REVOKE');

-- CreateEnum
CREATE TYPE "QualificationMode" AS ENUM ('EXAM', 'DIRECT');

-- CreateEnum
CREATE TYPE "AdmissionSource" AS ENUM ('WEBSITE', 'WALKIN', 'AGENT', 'REFERRAL', 'COUNCIL');

-- CreateEnum
CREATE TYPE "ScholarshipStatus" AS ENUM ('RESERVED', 'LOCKED', 'EXPIRED', 'UTILIZED');

-- CreateEnum
CREATE TYPE "QuotaType" AS ENUM ('MANAGEMENT', 'CONVENOR');

-- CreateEnum
CREATE TYPE "ApplicationMode" AS ENUM ('ONLINE', 'OFFLINE', 'SEAT_BOOKING');

-- CreateEnum
CREATE TYPE "ImportType" AS ENUM ('OFFLINE_ADMISSION', 'CONVENOR_ADMISSION');

-- CreateEnum
CREATE TYPE "HostelRoomType" AS ENUM ('AC', 'NON_AC');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('ONLINE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'WALLET', 'CASH', 'CHEQUE', 'DEMAND_DRAFT', 'NEFT_RTGS');

-- CreateEnum
CREATE TYPE "LedgerTransactionType" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterEnum
BEGIN;
CREATE TYPE "AdmissionStatus_new" AS ENUM ('REGISTERED', 'ENTRANCE_FEE_PAID', 'EXAM_SCHEDULED', 'EXAM_ATTENDED', 'EXAM_QUALIFIED', 'DOCUMENTS_PENDING', 'DOCUMENTS_SUBMITTED', 'DOCUMENTS_VERIFIED', 'SEAT_ALLOTTED', 'ADMISSION_CONFIRMED', 'ENROLLED', 'REJECTED', 'CANCELLED', 'EXAM_NOT_QUALIFIED');
ALTER TABLE "StudentAdmission" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "StudentAdmission" ALTER COLUMN "status" TYPE "AdmissionStatus_new" USING ("status"::text::"AdmissionStatus_new");
ALTER TYPE "AdmissionStatus" RENAME TO "AdmissionStatus_old";
ALTER TYPE "AdmissionStatus_new" RENAME TO "AdmissionStatus";
DROP TYPE "AdmissionStatus_old";
ALTER TABLE "StudentAdmission" ALTER COLUMN "status" SET DEFAULT 'REGISTERED';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "EnrollmentStatus_new" AS ENUM ('ACTIVE', 'SUSPENDED', 'DROPPED', 'COMPLETED');
ALTER TABLE "StudentEnrollment" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "StudentEnrollment" ALTER COLUMN "status" TYPE "EnrollmentStatus_new" USING ("status"::text::"EnrollmentStatus_new");
ALTER TYPE "EnrollmentStatus" RENAME TO "EnrollmentStatus_old";
ALTER TYPE "EnrollmentStatus_new" RENAME TO "EnrollmentStatus";
DROP TYPE "EnrollmentStatus_old";
ALTER TABLE "StudentEnrollment" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
COMMIT;

-- AlterEnum
ALTER TYPE "PaymentComponent" ADD VALUE 'SCHOLARSHIP_TOKEN';

-- DropForeignKey
ALTER TABLE "Batch" DROP CONSTRAINT "Batch_courseId_fkey";

-- DropIndex
DROP INDEX "DocumentRequirement_courseType_documentKey_key";

-- AlterTable
ALTER TABLE "AcademicYear" ADD COLUMN     "isLocked" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "specializationId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "degree" TEXT,
ADD COLUMN     "filledSeats" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalSeats" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "schoolId" TEXT;

-- AlterTable
ALTER TABLE "DiscountRequest" ADD COLUMN     "approvedAmount" DOUBLE PRECISION,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "component" TEXT,
ADD COLUMN     "requestedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DocumentRequirement" DROP COLUMN "courseType",
ADD COLUMN     "degreeType" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "FeeStructure" ADD COLUMN     "courseType" TEXT,
ADD COLUMN     "degreeId" TEXT,
ADD COLUMN     "dueDate" TIMESTAMP(3),
ADD COLUMN     "quotaType" "QuotaType",
ADD COLUMN     "yearOfStudy" INTEGER;

-- AlterTable
ALTER TABLE "Hostel" ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "wardenName" TEXT,
DROP COLUMN "type",
ADD COLUMN     "type" TEXT NOT NULL,
ALTER COLUMN "cost" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "HostelRoom" ADD COLUMN     "cost" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "providerTx",
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "branchName" TEXT,
ADD COLUMN     "collectedBy" TEXT,
ADD COLUMN     "instrumentDate" TIMESTAMP(3),
ADD COLUMN     "invoiceUrl" TEXT,
ADD COLUMN     "merchantOrderId" TEXT,
ADD COLUMN     "mode" "PaymentMode" NOT NULL DEFAULT 'ONLINE',
ADD COLUMN     "providerTxId" TEXT,
ADD COLUMN     "referenceNumber" TEXT,
ADD COLUMN     "signature" TEXT,
DROP COLUMN "method",
ADD COLUMN     "method" "PaymentMethod";

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "applicationMode" "ApplicationMode" NOT NULL DEFAULT 'ONLINE',
ADD COLUMN     "degreeType" TEXT,
ADD COLUMN     "eligibleScholarshipRuleId" TEXT,
ADD COLUMN     "quotaType" "QuotaType" NOT NULL DEFAULT 'MANAGEMENT',
ADD COLUMN     "scholarshipRemarks" TEXT,
ADD COLUMN     "scholarshipVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scholarshipVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "scholarshipVerifiedBy" TEXT,
ADD COLUMN     "source" "AdmissionSource" NOT NULL DEFAULT 'WEBSITE',
ALTER COLUMN "profilePhotoUrl" DROP NOT NULL;

-- AlterTable
ALTER TABLE "StudentAdmission" DROP COLUMN "allottedSpecialization",
ADD COLUMN     "allottedCourseId" TEXT,
ADD COLUMN     "qualificationMode" "QualificationMode",
ADD COLUMN     "roomNumber" TEXT;

-- AlterTable
ALTER TABLE "StudentExam" ADD COLUMN     "class12Aggregate" DOUBLE PRECISION,
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "jeePercentile" DOUBLE PRECISION,
ADD COLUMN     "satScore" DOUBLE PRECISION,
ADD COLUMN     "updatedBy" TEXT,
ADD COLUMN     "vvitPercentile" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "TransportRoute" ADD COLUMN     "city" TEXT NOT NULL,
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "password" TEXT,
DROP COLUMN "role",
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'STUDENT';

-- AlterTable
ALTER TABLE "UserOtp" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- DropEnum
DROP TYPE "Role";

-- CreateTable
CREATE TABLE "School" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "School_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConvenorAdmission" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "rank" TEXT,
    "hallTicketNo" TEXT,
    "allotmentOrder" TEXT,
    "councilId" TEXT,
    "category" TEXT,
    "joiningReport" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ConvenorAdmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataImportMapping" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ImportType" NOT NULL,
    "mapping" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "DataImportMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostelPriceCategory" (
    "id" TEXT NOT NULL,
    "sharing" INTEGER NOT NULL,
    "roomType" "HostelRoomType" NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "HostelPriceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentLedger" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "type" "LedgerTransactionType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referenceId" TEXT,
    "referenceType" TEXT,
    "runningBalance" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "StudentLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Configuration" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "Configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScholarshipRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minPercentile" DOUBLE PRECISION NOT NULL,
    "discountPercentage" DOUBLE PRECISION NOT NULL,
    "totalSlots" INTEGER NOT NULL,
    "filledSlots" INTEGER NOT NULL DEFAULT 0,
    "degreeType" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScholarshipRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScholarshipAllocation" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "status" "ScholarshipStatus" NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScholarshipAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualificationRequirement" (
    "id" TEXT NOT NULL,
    "degreeType" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL DEFAULT 'SINGLE',
    "qualificationKeys" TEXT[],
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "QualificationRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "moduleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Module" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserGroup" (
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserGroup_pkey" PRIMARY KEY ("userId","groupId")
);

-- CreateTable
CREATE TABLE "GroupRole" (
    "groupId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupRole_pkey" PRIMARY KEY ("groupId","roleId")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "UserPermissionOverride" (
    "userId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "type" "OverrideType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPermissionOverride_pkey" PRIMARY KEY ("userId","permissionId")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "invoiceData" JSONB,
    "templateType" TEXT NOT NULL,
    "messageId" TEXT,
    "errorResponse" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "School_name_key" ON "School"("name");

-- CreateIndex
CREATE UNIQUE INDEX "School_code_key" ON "School"("code");

-- CreateIndex
CREATE INDEX "School_isDeleted_idx" ON "School"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "ConvenorAdmission_studentId_key" ON "ConvenorAdmission"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "DataImportMapping_name_key" ON "DataImportMapping"("name");

-- CreateIndex
CREATE UNIQUE INDEX "HostelPriceCategory_sharing_roomType_key" ON "HostelPriceCategory"("sharing", "roomType");

-- CreateIndex
CREATE UNIQUE INDEX "Configuration_key_key" ON "Configuration"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ScholarshipAllocation_studentId_key" ON "ScholarshipAllocation"("studentId");

-- CreateIndex
CREATE INDEX "ScholarshipAllocation_status_idx" ON "ScholarshipAllocation"("status");

-- CreateIndex
CREATE INDEX "ScholarshipAllocation_expiresAt_idx" ON "ScholarshipAllocation"("expiresAt");

-- CreateIndex
CREATE INDEX "QualificationRequirement_degreeType_idx" ON "QualificationRequirement"("degreeType");

-- CreateIndex
CREATE INDEX "QualificationRequirement_isDeleted_idx" ON "QualificationRequirement"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "Group_name_key" ON "Group"("name");

-- CreateIndex
CREATE INDEX "Group_type_idx" ON "Group"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "Permission_moduleId_idx" ON "Permission"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "Module_code_key" ON "Module"("code");

-- CreateIndex
CREATE INDEX "UserGroup_groupId_idx" ON "UserGroup"("groupId");

-- CreateIndex
CREATE INDEX "GroupRole_roleId_idx" ON "GroupRole"("roleId");

-- CreateIndex
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

-- CreateIndex
CREATE INDEX "UserPermissionOverride_permissionId_idx" ON "UserPermissionOverride"("permissionId");

-- CreateIndex
CREATE INDEX "EmailLog_status_idx" ON "EmailLog"("status");

-- CreateIndex
CREATE INDEX "EmailLog_recipientEmail_idx" ON "EmailLog"("recipientEmail");

-- CreateIndex
CREATE INDEX "EmailLog_createdAt_idx" ON "EmailLog"("createdAt");

-- CreateIndex
CREATE INDEX "AcademicYear_isActive_idx" ON "AcademicYear"("isActive");

-- CreateIndex
CREATE INDEX "AcademicYear_isDeleted_idx" ON "AcademicYear"("isDeleted");

-- CreateIndex
CREATE INDEX "AdminActivityLog_adminId_idx" ON "AdminActivityLog"("adminId");

-- CreateIndex
CREATE INDEX "AdminActivityLog_action_idx" ON "AdminActivityLog"("action");

-- CreateIndex
CREATE INDEX "AdminActivityLog_resourceType_resourceId_idx" ON "AdminActivityLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AdminActivityLog_createdAt_idx" ON "AdminActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "AttendanceRecord_examDateId_idx" ON "AttendanceRecord"("examDateId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_invigilatorId_idx" ON "AttendanceRecord"("invigilatorId");

-- CreateIndex
CREATE INDEX "AttendanceRecord_scannedAt_idx" ON "AttendanceRecord"("scannedAt");

-- CreateIndex
CREATE INDEX "AttendanceRecord_verified_idx" ON "AttendanceRecord"("verified");

-- CreateIndex
CREATE INDEX "Batch_courseId_idx" ON "Batch"("courseId");

-- CreateIndex
CREATE INDEX "Batch_specializationId_idx" ON "Batch"("specializationId");

-- CreateIndex
CREATE INDEX "Batch_isDeleted_idx" ON "Batch"("isDeleted");

-- CreateIndex
CREATE INDEX "Batch_startDate_endDate_idx" ON "Batch"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "Course_code_key" ON "Course"("code");

-- CreateIndex
CREATE INDEX "Course_departmentId_idx" ON "Course"("departmentId");

-- CreateIndex
CREATE INDEX "Course_isDeleted_idx" ON "Course"("isDeleted");

-- CreateIndex
CREATE INDEX "Department_isDeleted_idx" ON "Department"("isDeleted");

-- CreateIndex
CREATE INDEX "DocumentRequirement_degreeType_idx" ON "DocumentRequirement"("degreeType");

-- CreateIndex
CREATE INDEX "DocumentRequirement_isDeleted_idx" ON "DocumentRequirement"("isDeleted");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRequirement_degreeType_documentKey_key" ON "DocumentRequirement"("degreeType", "documentKey");

-- CreateIndex
CREATE INDEX "ExamCenter_city_idx" ON "ExamCenter"("city");

-- CreateIndex
CREATE INDEX "ExamCenter_isDeleted_idx" ON "ExamCenter"("isDeleted");

-- CreateIndex
CREATE INDEX "ExamDate_date_idx" ON "ExamDate"("date");

-- CreateIndex
CREATE INDEX "ExamSlot_examCenterId_idx" ON "ExamSlot"("examCenterId");

-- CreateIndex
CREATE INDEX "ExamSlot_date_idx" ON "ExamSlot"("date");

-- CreateIndex
CREATE INDEX "ExamSlot_isBookingEnabled_idx" ON "ExamSlot"("isBookingEnabled");

-- CreateIndex
CREATE INDEX "ExamSlot_isDeleted_idx" ON "ExamSlot"("isDeleted");

-- CreateIndex
CREATE INDEX "ExamSlot_date_examCenterId_idx" ON "ExamSlot"("date", "examCenterId");

-- CreateIndex
CREATE INDEX "FeeHead_isDeleted_idx" ON "FeeHead"("isDeleted");

-- CreateIndex
CREATE INDEX "FeeStructure_quotaType_idx" ON "FeeStructure"("quotaType");

-- CreateIndex
CREATE INDEX "FeeStructure_yearOfStudy_idx" ON "FeeStructure"("yearOfStudy");

-- CreateIndex
CREATE INDEX "Hostel_type_idx" ON "Hostel"("type");

-- CreateIndex
CREATE INDEX "Hostel_isDeleted_idx" ON "Hostel"("isDeleted");

-- CreateIndex
CREATE INDEX "HostelAllocation_bedId_idx" ON "HostelAllocation"("bedId");

-- CreateIndex
CREATE INDEX "HostelAllocation_status_idx" ON "HostelAllocation"("status");

-- CreateIndex
CREATE INDEX "HostelAllocation_startDate_endDate_idx" ON "HostelAllocation"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "HostelBed_roomId_idx" ON "HostelBed"("roomId");

-- CreateIndex
CREATE INDEX "HostelBed_isOccupied_idx" ON "HostelBed"("isOccupied");

-- CreateIndex
CREATE INDEX "HostelBlock_hostelId_idx" ON "HostelBlock"("hostelId");

-- CreateIndex
CREATE INDEX "HostelBlock_isDeleted_idx" ON "HostelBlock"("isDeleted");

-- CreateIndex
CREATE INDEX "HostelRoom_blockId_idx" ON "HostelRoom"("blockId");

-- CreateIndex
CREATE INDEX "HostelRoom_isDeleted_idx" ON "HostelRoom"("isDeleted");

-- CreateIndex
CREATE INDEX "InvigilatorCredential_adminId_idx" ON "InvigilatorCredential"("adminId");

-- CreateIndex
CREATE INDEX "InvigilatorCredential_token_idx" ON "InvigilatorCredential"("token");

-- CreateIndex
CREATE INDEX "InvigilatorCredential_validFrom_validUntil_idx" ON "InvigilatorCredential"("validFrom", "validUntil");

-- CreateIndex
CREATE INDEX "Notification_recipientId_idx" ON "Notification"("recipientId");

-- CreateIndex
CREATE INDEX "Notification_isRead_idx" ON "Notification"("isRead");

-- CreateIndex
CREATE INDEX "Notification_type_idx" ON "Notification"("type");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_recipientId_isRead_idx" ON "Notification"("recipientId", "isRead");

-- CreateIndex
CREATE INDEX "OfflineUploadBatch_agentId_idx" ON "OfflineUploadBatch"("agentId");

-- CreateIndex
CREATE INDEX "OfflineUploadBatch_status_idx" ON "OfflineUploadBatch"("status");

-- CreateIndex
CREATE INDEX "OfflineUploadBatch_createdAt_idx" ON "OfflineUploadBatch"("createdAt");

-- CreateIndex
CREATE INDEX "Payment_providerTxId_idx" ON "Payment"("providerTxId");

-- CreateIndex
CREATE INDEX "Payment_referenceNumber_idx" ON "Payment"("referenceNumber");

-- CreateIndex
CREATE INDEX "Payment_mode_idx" ON "Payment"("mode");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- CreateIndex
CREATE INDEX "Section_batchId_idx" ON "Section"("batchId");

-- CreateIndex
CREATE INDEX "Section_isDeleted_idx" ON "Section"("isDeleted");

-- CreateIndex
CREATE INDEX "Specialization_courseId_idx" ON "Specialization"("courseId");

-- CreateIndex
CREATE INDEX "Specialization_isDeleted_idx" ON "Specialization"("isDeleted");

-- CreateIndex
CREATE INDEX "Student_userId_idx" ON "Student"("userId");

-- CreateIndex
CREATE INDEX "Student_agentId_idx" ON "Student"("agentId");

-- CreateIndex
CREATE INDEX "Student_phone_idx" ON "Student"("phone");

-- CreateIndex
CREATE INDEX "Student_aadharNumber_idx" ON "Student"("aadharNumber");

-- CreateIndex
CREATE INDEX "Student_degreeType_idx" ON "Student"("degreeType");

-- CreateIndex
CREATE INDEX "Student_quotaType_idx" ON "Student"("quotaType");

-- CreateIndex
CREATE INDEX "Student_applicationMode_idx" ON "Student"("applicationMode");

-- CreateIndex
CREATE INDEX "Student_isKycVerified_idx" ON "Student"("isKycVerified");

-- CreateIndex
CREATE INDEX "Student_createdAt_idx" ON "Student"("createdAt");

-- CreateIndex
CREATE INDEX "Student_category_idx" ON "Student"("category");

-- CreateIndex
CREATE INDEX "Student_city_state_idx" ON "Student"("city", "state");

-- CreateIndex
CREATE INDEX "StudentAdmission_feeStatus_idx" ON "StudentAdmission"("feeStatus");

-- CreateIndex
CREATE INDEX "StudentAdmission_accommodationType_idx" ON "StudentAdmission"("accommodationType");

-- CreateIndex
CREATE INDEX "StudentAdmission_hostelId_idx" ON "StudentAdmission"("hostelId");

-- CreateIndex
CREATE INDEX "StudentAdmission_transportRouteId_idx" ON "StudentAdmission"("transportRouteId");

-- CreateIndex
CREATE INDEX "StudentAdmission_allottedCourseId_idx" ON "StudentAdmission"("allottedCourseId");

-- CreateIndex
CREATE INDEX "StudentEnrollment_sectionId_idx" ON "StudentEnrollment"("sectionId");

-- CreateIndex
CREATE INDEX "StudentEnrollment_academicYearId_idx" ON "StudentEnrollment"("academicYearId");

-- CreateIndex
CREATE INDEX "StudentEnrollment_status_idx" ON "StudentEnrollment"("status");

-- CreateIndex
CREATE INDEX "StudentEnrollment_currentSemester_idx" ON "StudentEnrollment"("currentSemester");

-- CreateIndex
CREATE INDEX "StudentExam_examSlotId_idx" ON "StudentExam"("examSlotId");

-- CreateIndex
CREATE INDEX "StudentExam_examAttended_idx" ON "StudentExam"("examAttended");

-- CreateIndex
CREATE INDEX "StudentExam_isQualified_idx" ON "StudentExam"("isQualified");

-- CreateIndex
CREATE INDEX "StudentExam_testDate_idx" ON "StudentExam"("testDate");

-- CreateIndex
CREATE INDEX "TransportAllocation_routeId_idx" ON "TransportAllocation"("routeId");

-- CreateIndex
CREATE INDEX "TransportAllocation_stopId_idx" ON "TransportAllocation"("stopId");

-- CreateIndex
CREATE INDEX "TransportAllocation_status_idx" ON "TransportAllocation"("status");

-- CreateIndex
CREATE INDEX "TransportAllocation_startDate_endDate_idx" ON "TransportAllocation"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "TransportRoute_vehicleId_idx" ON "TransportRoute"("vehicleId");

-- CreateIndex
CREATE INDEX "TransportRoute_city_idx" ON "TransportRoute"("city");

-- CreateIndex
CREATE INDEX "TransportRoute_isDeleted_idx" ON "TransportRoute"("isDeleted");

-- CreateIndex
CREATE INDEX "TransportStop_routeId_idx" ON "TransportStop"("routeId");

-- CreateIndex
CREATE INDEX "TransportStop_isDeleted_idx" ON "TransportStop"("isDeleted");

-- CreateIndex
CREATE INDEX "TransportStop_sequence_idx" ON "TransportStop"("sequence");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "User_isDeleted_idx" ON "User"("isDeleted");

-- CreateIndex
CREATE INDEX "Vehicle_isDeleted_idx" ON "Vehicle"("isDeleted");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_specializationId_fkey" FOREIGN KEY ("specializationId") REFERENCES "Specialization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_eligibleScholarshipRuleId_fkey" FOREIGN KEY ("eligibleScholarshipRuleId") REFERENCES "ScholarshipRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_pref1_fkey" FOREIGN KEY ("pref1") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_pref2_fkey" FOREIGN KEY ("pref2") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_pref3_fkey" FOREIGN KEY ("pref3") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConvenorAdmission" ADD CONSTRAINT "ConvenorAdmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAdmission" ADD CONSTRAINT "StudentAdmission_allottedCourseId_fkey" FOREIGN KEY ("allottedCourseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentLedger" ADD CONSTRAINT "StudentLedger_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScholarshipAllocation" ADD CONSTRAINT "ScholarshipAllocation_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ScholarshipRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScholarshipAllocation" ADD CONSTRAINT "ScholarshipAllocation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Permission" ADD CONSTRAINT "Permission_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserGroup" ADD CONSTRAINT "UserGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserGroup" ADD CONSTRAINT "UserGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupRole" ADD CONSTRAINT "GroupRole_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupRole" ADD CONSTRAINT "GroupRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionOverride" ADD CONSTRAINT "UserPermissionOverride_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
