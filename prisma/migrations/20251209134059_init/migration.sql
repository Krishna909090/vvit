/*
  Warnings:

  - The values [TEST_ENABLED,DOCUMENTS_VERIFIED,RESULTS_PUBLISHED,APPLICATION_SUBMITTED] on the enum `AdmissionStatus` will be removed. If these variants are still used in the database, this will fail.
  - The `status` column on the `AgentCommission` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `OfflineUploadBatch` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `newBranch` on the `SeatAllocation` table. All the data in the column will be lost.
  - You are about to drop the column `oldBranch` on the `SeatAllocation` table. All the data in the column will be lost.
  - You are about to drop the column `accommodationType` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `allottedBranch` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `casteUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `cmmUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `degreeCertificateUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `diplomaMarksheetUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `documentVerificationStatus` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `entranceScorecardUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `examAttended` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `examScore` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `examSlotId` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `feePaid` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `feeStatus` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `hallTicketUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `hostelId` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `hostelType` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `isQualified` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `marksheetUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `migrationCertificateUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `paidFee` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `provisionalCertificateUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `tcUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `tenthMarksheetUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `testCenter` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `testDate` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `totalFee` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `transportRouteId` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `twelfthMarksheetUrl` on the `Student` table. All the data in the column will be lost.
  - You are about to drop the column `otp` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `otpExpiry` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `Branch` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `BranchChangeLog` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `BranchChangeRequest` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[userId]` on the table `Student` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[email]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `FileUpload` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Payment` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'DETAINED', 'ALUMNI', 'SUSPENDED', 'DROPPED_OUT');

-- CreateEnum
CREATE TYPE "StudentDocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "HostelAllocationStatus" AS ENUM ('ACTIVE', 'VACATED');

-- CreateEnum
CREATE TYPE "TransportAllocationStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentCommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "OfflineUploadBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterEnum
BEGIN;
CREATE TYPE "AdmissionStatus_new" AS ENUM ('REGISTERED', 'TEST_FEE_PAID', 'HALL_TICKET_GENERATED', 'EXAM_ATTENDED', 'DOCUMENTS_UPLOADED', 'SEAT_ALLOTTED', 'ADMISSION_CONFIRMED', 'CANCELLED');
ALTER TABLE "Student" ALTER COLUMN "status" DROP DEFAULT;
-- ALTER TABLE "StudentAdmission" ALTER COLUMN "status" TYPE "AdmissionStatus_new" USING ("status"::text::"AdmissionStatus_new");
ALTER TYPE "AdmissionStatus" RENAME TO "AdmissionStatus_old";
ALTER TYPE "AdmissionStatus_new" RENAME TO "AdmissionStatus";
-- DROP TYPE "AdmissionStatus_old";
COMMIT;

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'STAFF';

-- DropForeignKey
ALTER TABLE "BranchChangeLog" DROP CONSTRAINT "BranchChangeLog_studentId_fkey";

-- DropForeignKey
ALTER TABLE "BranchChangeRequest" DROP CONSTRAINT "BranchChangeRequest_studentId_fkey";

-- DropForeignKey
ALTER TABLE "Student" DROP CONSTRAINT "Student_examSlotId_fkey";

-- DropForeignKey
ALTER TABLE "Student" DROP CONSTRAINT "Student_hostelId_fkey";

-- DropForeignKey
ALTER TABLE "Student" DROP CONSTRAINT "Student_transportRouteId_fkey";

-- AlterTable
ALTER TABLE "AcademicQualification" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "AdminActivityLog" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "AgentCommission" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" "AgentCommissionStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "CancellationRequest" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "DiscountRequest" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "DocumentRequirement" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "ExamCenter" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "ExamDate" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "ExamSlot" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "isBookingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "FileUpload" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "HallTicket" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "Hostel" ADD COLUMN     "blockName" TEXT,
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "roomNumber" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "InvigilatorCredential" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "OfflineUploadBatch" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "updatedBy" TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" "OfflineUploadBatchStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "feeDemandId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "SeatAllocation" DROP COLUMN "newBranch",
DROP COLUMN "oldBranch",
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "newCourse" TEXT,
ADD COLUMN     "oldCourse" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- AlterTable
ALTER TABLE "Student" DROP COLUMN "accommodationType",
DROP COLUMN "allottedBranch",
DROP COLUMN "casteUrl",
DROP COLUMN "cmmUrl",
DROP COLUMN "degreeCertificateUrl",
DROP COLUMN "diplomaMarksheetUrl",
DROP COLUMN "documentVerificationStatus",
DROP COLUMN "entranceScorecardUrl",
DROP COLUMN "examAttended",
DROP COLUMN "examScore",
DROP COLUMN "examSlotId",
DROP COLUMN "feePaid",
DROP COLUMN "feeStatus",
DROP COLUMN "hallTicketUrl",
DROP COLUMN "hostelId",
DROP COLUMN "hostelType",
DROP COLUMN "isQualified",
DROP COLUMN "marksheetUrl",
DROP COLUMN "migrationCertificateUrl",
DROP COLUMN "paidFee",
DROP COLUMN "provisionalCertificateUrl",
DROP COLUMN "status",
DROP COLUMN "tcUrl",
DROP COLUMN "tenthMarksheetUrl",
DROP COLUMN "testCenter",
DROP COLUMN "testDate",
DROP COLUMN "totalFee",
DROP COLUMN "transportRouteId",
DROP COLUMN "twelfthMarksheetUrl",
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "documentFolderPath" TEXT,
ADD COLUMN     "isKycVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedBy" TEXT,
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "TransportRoute" ADD COLUMN     "busNumber" TEXT,
ADD COLUMN     "capacity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "filled" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updatedBy" TEXT,
ADD COLUMN     "vehicleId" TEXT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "otp",
DROP COLUMN "otpExpiry",
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "updatedBy" TEXT;

-- DropTable
DROP TABLE "Branch";

-- DropTable
DROP TABLE "BranchChangeLog";

-- DropTable
DROP TABLE "BranchChangeRequest";

-- CreateTable
CREATE TABLE "UserOtp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Section" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademicYear" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AcademicYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentEnrollment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "rollNumber" TEXT NOT NULL,
    "currentSemester" INTEGER NOT NULL DEFAULT 1,
    "academicYearId" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "StudentEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentExam" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "hallTicketUrl" TEXT,
    "testDate" TIMESTAMP(3),
    "testCenter" TEXT,
    "examAttended" BOOLEAN NOT NULL DEFAULT false,
    "examScore" DOUBLE PRECISION,
    "isQualified" BOOLEAN DEFAULT false,
    "examSlotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentExam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentAdmission" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'REGISTERED',
    "allottedSpecialization" TEXT,
    "totalFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paidFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feeStatus" "FeeStatus" NOT NULL DEFAULT 'PENDING',
    "accommodationType" "AccommodationType" NOT NULL DEFAULT 'NONE',
    "hostelType" "HostelType",
    "hostelId" TEXT,
    "transportRouteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentAdmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentDocument" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "documentKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "StudentDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "StudentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Specialization" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "totalSeats" INTEGER NOT NULL,
    "filledSeats" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Specialization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostelBlock" (
    "id" TEXT NOT NULL,
    "hostelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "HostelBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostelRoom" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "HostelRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostelBed" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "isOccupied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "HostelBed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostelAllocation" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "bedId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "HostelAllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "HostelAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "driverName" TEXT NOT NULL,
    "driverPhone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportStop" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "pickupTime" TIMESTAMP(3) NOT NULL,
    "dropTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TransportStop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransportAllocation" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "TransportAllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "TransportAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeHead" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FeeHead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeStructure" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "feeHeadId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "academicYearId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "FeeStructure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentFeeDemand" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "feeStructureId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "FeeStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "StudentFeeDemand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseChangeLog" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "oldCourse" TEXT NOT NULL,
    "newCourse" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "CourseChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseChangeRequest" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fromCourse" TEXT NOT NULL,
    "toCourse" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "forwardedTo" TEXT,
    "actionedBy" TEXT,
    "actionedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "CourseChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserOtp_userId_type_used_expiresAt_idx" ON "UserOtp"("userId", "type", "used", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Department_code_key" ON "Department"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Course_name_departmentId_key" ON "Course"("name", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicYear_code_key" ON "AcademicYear"("code");

-- CreateIndex
CREATE UNIQUE INDEX "StudentEnrollment_studentId_key" ON "StudentEnrollment"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentEnrollment_rollNumber_key" ON "StudentEnrollment"("rollNumber");

-- CreateIndex
CREATE INDEX "StudentEnrollment_studentId_idx" ON "StudentEnrollment"("studentId");

-- CreateIndex
CREATE INDEX "StudentEnrollment_rollNumber_idx" ON "StudentEnrollment"("rollNumber");

-- CreateIndex
CREATE UNIQUE INDEX "StudentExam_studentId_key" ON "StudentExam"("studentId");

-- CreateIndex
CREATE INDEX "StudentExam_studentId_idx" ON "StudentExam"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentAdmission_studentId_key" ON "StudentAdmission"("studentId");

-- CreateIndex
CREATE INDEX "StudentAdmission_studentId_idx" ON "StudentAdmission"("studentId");

-- CreateIndex
CREATE INDEX "StudentAdmission_status_idx" ON "StudentAdmission"("status");

-- CreateIndex
CREATE INDEX "StudentDocument_studentId_idx" ON "StudentDocument"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentDocument_studentId_documentKey_key" ON "StudentDocument"("studentId", "documentKey");

-- CreateIndex
CREATE UNIQUE INDEX "Specialization_code_key" ON "Specialization"("code");

-- CreateIndex
CREATE UNIQUE INDEX "HostelAllocation_studentId_key" ON "HostelAllocation"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "HostelAllocation_bedId_key" ON "HostelAllocation"("bedId");

-- CreateIndex
CREATE INDEX "HostelAllocation_studentId_idx" ON "HostelAllocation"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_number_key" ON "Vehicle"("number");

-- CreateIndex
CREATE UNIQUE INDEX "TransportAllocation_studentId_key" ON "TransportAllocation"("studentId");

-- CreateIndex
CREATE INDEX "TransportAllocation_studentId_idx" ON "TransportAllocation"("studentId");

-- CreateIndex
CREATE INDEX "FeeStructure_courseId_academicYearId_idx" ON "FeeStructure"("courseId", "academicYearId");

-- CreateIndex
CREATE INDEX "StudentFeeDemand_studentId_status_idx" ON "StudentFeeDemand"("studentId", "status");

-- CreateIndex
CREATE INDEX "CourseChangeLog_studentId_idx" ON "CourseChangeLog"("studentId");

-- CreateIndex
CREATE INDEX "CourseChangeRequest_studentId_status_idx" ON "CourseChangeRequest"("studentId", "status");

-- CreateIndex
CREATE INDEX "AcademicQualification_studentId_idx" ON "AcademicQualification"("studentId");

-- CreateIndex
CREATE INDEX "AgentCommission_agentId_idx" ON "AgentCommission"("agentId");

-- CreateIndex
CREATE INDEX "AgentCommission_studentId_status_idx" ON "AgentCommission"("studentId", "status");

-- CreateIndex
CREATE INDEX "AttendanceRecord_studentId_idx" ON "AttendanceRecord"("studentId");

-- CreateIndex
CREATE INDEX "CancellationRequest_studentId_status_idx" ON "CancellationRequest"("studentId", "status");

-- CreateIndex
CREATE INDEX "DiscountRequest_studentId_status_idx" ON "DiscountRequest"("studentId", "status");

-- CreateIndex
CREATE INDEX "FileUpload_studentId_idx" ON "FileUpload"("studentId");

-- CreateIndex
CREATE INDEX "HallTicket_studentId_idx" ON "HallTicket"("studentId");

-- CreateIndex
CREATE INDEX "Payment_studentId_status_idx" ON "Payment"("studentId", "status");

-- CreateIndex
CREATE INDEX "SeatAllocation_studentId_idx" ON "SeatAllocation"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_userId_key" ON "Student"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- AddForeignKey
ALTER TABLE "UserOtp" ADD CONSTRAINT "UserOtp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "Section"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentEnrollment" ADD CONSTRAINT "StudentEnrollment_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentExam" ADD CONSTRAINT "StudentExam_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentExam" ADD CONSTRAINT "StudentExam_examSlotId_fkey" FOREIGN KEY ("examSlotId") REFERENCES "ExamSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAdmission" ADD CONSTRAINT "StudentAdmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAdmission" ADD CONSTRAINT "StudentAdmission_hostelId_fkey" FOREIGN KEY ("hostelId") REFERENCES "Hostel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentAdmission" ADD CONSTRAINT "StudentAdmission_transportRouteId_fkey" FOREIGN KEY ("transportRouteId") REFERENCES "TransportRoute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentDocument" ADD CONSTRAINT "StudentDocument_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Specialization" ADD CONSTRAINT "Specialization_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostelBlock" ADD CONSTRAINT "HostelBlock_hostelId_fkey" FOREIGN KEY ("hostelId") REFERENCES "Hostel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostelRoom" ADD CONSTRAINT "HostelRoom_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "HostelBlock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostelBed" ADD CONSTRAINT "HostelBed_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "HostelRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostelAllocation" ADD CONSTRAINT "HostelAllocation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HostelAllocation" ADD CONSTRAINT "HostelAllocation_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "HostelBed"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportRoute" ADD CONSTRAINT "TransportRoute_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportStop" ADD CONSTRAINT "TransportStop_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "TransportRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAllocation" ADD CONSTRAINT "TransportAllocation_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAllocation" ADD CONSTRAINT "TransportAllocation_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "TransportRoute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransportAllocation" ADD CONSTRAINT "TransportAllocation_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "TransportStop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeStructure" ADD CONSTRAINT "FeeStructure_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeStructure" ADD CONSTRAINT "FeeStructure_feeHeadId_fkey" FOREIGN KEY ("feeHeadId") REFERENCES "FeeHead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeStructure" ADD CONSTRAINT "FeeStructure_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFeeDemand" ADD CONSTRAINT "StudentFeeDemand_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentFeeDemand" ADD CONSTRAINT "StudentFeeDemand_feeStructureId_fkey" FOREIGN KEY ("feeStructureId") REFERENCES "FeeStructure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_feeDemandId_fkey" FOREIGN KEY ("feeDemandId") REFERENCES "StudentFeeDemand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseChangeLog" ADD CONSTRAINT "CourseChangeLog_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseChangeRequest" ADD CONSTRAINT "CourseChangeRequest_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Drop the old enum type after all dependencies are removed
DROP TYPE "AdmissionStatus_old";
