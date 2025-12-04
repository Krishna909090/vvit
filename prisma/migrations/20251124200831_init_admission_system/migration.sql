-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'AGENT', 'STUDENT');

-- CreateEnum
CREATE TYPE "AdmissionStatus" AS ENUM ('REGISTERED', 'TEST_FEE_PAID', 'TEST_ENABLED', 'HALL_TICKET_GENERATED', 'EXAM_ATTENDED', 'DOCUMENTS_UPLOADED', 'SEAT_ALLOTTED', 'ADMISSION_CONFIRMED');

-- CreateEnum
CREATE TYPE "DiscountStatus" AS ENUM ('REQUESTED', 'FORWARDED_TO_SUPER_ADMIN', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dob" TIMESTAMP(3) NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "idProofUrl" TEXT,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'REGISTERED',
    "hallTicketUrl" TEXT,
    "testDate" TIMESTAMP(3),
    "testCenter" TEXT,
    "examAttended" BOOLEAN NOT NULL DEFAULT false,
    "pref1" TEXT,
    "pref2" TEXT,
    "pref3" TEXT,
    "marksheetUrl" TEXT,
    "tcUrl" TEXT,
    "casteUrl" TEXT,
    "allottedBranch" TEXT,
    "feePaid" BOOLEAN NOT NULL DEFAULT false,
    "agentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchChangeLog" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "oldBranch" TEXT NOT NULL,
    "newBranch" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BranchChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscountRequest" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "documentUrl" TEXT,
    "status" "DiscountStatus" NOT NULL DEFAULT 'REQUESTED',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscountRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Student_applicationId_key" ON "Student"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_email_key" ON "Student"("email");

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchChangeLog" ADD CONSTRAINT "BranchChangeLog_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscountRequest" ADD CONSTRAINT "DiscountRequest_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
