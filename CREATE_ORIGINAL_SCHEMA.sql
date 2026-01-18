-- ORIGINAL SCHEMA CREATION SCRIPT (Full Schema)
-- Run this if you want to create ALL tables from scratch (Empty Database).

/*
TABLES INCLUDED IN THIS SCRIPT:
1. School
2. Department
3. Course
4. Specialization
5. Batch
6. Section
7. User
8. Role (Legacy Enum, created as Column)
9. AcademicYear
10. ScholarshipRule
11. Student
12. StudentEnrollment
13. Hostel
14. Vehicle
15. TransportRoute
16. TransportStop (+)
17. TransportAllocation (+)
18. StudentAdmission
19. FeeHead
20. FeeStructure
21. StudentFeeDemand
22. Payment
23. SystemSetting
24. AuditLog
25. HostelBlock (+)
26. HostelRoom (+)
27. HostelBed (+)
28. HostelAllocation (+)
29. HostelPriceCategory (+)
30. StudentDocument (+)
31. ConvenorAdmission (+)
32. DataImportMapping (+)
33. StudentExam (+)
34. ExamCenter (+)
35. ExamSlot (+)
36. HallTicket (+)
37. InvigilatorCredential (+)
38. AttendanceRecord (+)
39. SeatAllocation (+)
40. CourseChangeLog (+)
41. CourseChangeRequest (+)
42. DiscountRequest (+)
43. CancellationRequest (+)
44. FileUpload (+)
45. AgentCommission (+)
46. Notification (+)
47. OfflineUploadBatch (+)
48. DocumentRequirement (+)
49. QualificationRequirement (+)
50. ExamDate (+)
51. UserOtp (+)
*/

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Create Enums    CREATE TYPE "AdmissionStatus" AS ENUM ('REGISTERED', 'ENTRANCE_FEE_PAID', 'EXAM_SCHEDULED', 'EXAM_ATTENDED', 'EXAM_QUALIFIED', 'DOCUMENTS_PENDING', 'DOCUMENTS_SUBMITTED', 'DOCUMENTS_VERIFIED', 'SEAT_ALLOTTED', 'ADMISSION_CONFIRMED', 'ENROLLED', 'REJECTED', 'CANCELLED', 'EXAM_NOT_QUALIFIED');
    CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DROPPED', 'COMPLETED');
    CREATE TYPE "FeeStatus" AS ENUM ('PENDING', 'PARTIAL', 'FULL');
    CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED');
    CREATE TYPE "PaymentComponent" AS ENUM ('APPLICATION_FEE', 'TUITION', 'HOSTEL', 'TRANSPORT', 'OTHER', 'SCHOLARSHIP_TOKEN');
    CREATE TYPE "AccommodationType" AS ENUM ('HOSTEL', 'TRANSPORT', 'NONE');
    CREATE TYPE "HostelType" AS ENUM ('SHARING_4', 'SHARING_8');
    CREATE TYPE "DiscountStatus" AS ENUM ('REQUESTED', 'FORWARDED_TO_SUPER_ADMIN', 'APPROVED', 'REJECTED');
    CREATE TYPE "CancellationStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');
    CREATE TYPE "FileKind" AS ENUM ('PROFILE', 'AADHAR', 'MARKSHEET', 'TC', 'CASTE', 'HALL_TICKET', 'OTHER');
    CREATE TYPE "RequestStatus" AS ENUM ('REQUESTED', 'FORWARDED', 'APPROVED', 'REJECTED');
    CREATE TYPE "StudentDocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
    CREATE TYPE "HostelAllocationStatus" AS ENUM ('ACTIVE', 'VACATED');
    CREATE TYPE "TransportAllocationStatus" AS ENUM ('ACTIVE', 'CANCELLED');
    CREATE TYPE "AgentCommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED');
    CREATE TYPE "OfflineUploadBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
    CREATE TYPE "ScholarshipStatus" AS ENUM ('RESERVED', 'LOCKED', 'EXPIRED', 'UTILIZED');
    CREATE TYPE "QuotaType" AS ENUM ('MANAGEMENT', 'CONVENOR');
    CREATE TYPE "ApplicationMode" AS ENUM ('ONLINE', 'OFFLINE', 'SEAT_BOOKING');
    CREATE TYPE "ImportType" AS ENUM ('OFFLINE_ADMISSION', 'CONVENOR_ADMISSION');
    CREATE TYPE "HostelRoomType" AS ENUM ('AC', 'NON_AC');
    CREATE TYPE "PaymentMode" AS ENUM ('ONLINE', 'OFFLINE');
    CREATE TYPE "PaymentMethod" AS ENUM ('UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'WALLET', 'CASH', 'CHEQUE', 'DEMAND_DRAFT', 'NEFT_RTGS');
    CREATE TYPE "LedgerTransactionType" AS ENUM ('CREDIT', 'DEBIT');
    CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
    CREATE TYPE "AdmissionSource" AS ENUM ('WEBSITE', 'WALKIN', 'AGENT', 'REFERRAL', 'COUNCIL');
    CREATE TYPE "QualificationMode" AS ENUM ('EXAM', 'DIRECT');
    CREATE TYPE "OverrideType" AS ENUM ('GRANT', 'REVOKE');
DO $$ BEGIN
    CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'AGENT', 'STUDENT', 'INVIGILATOR', 'STAFF', 'VERIFICATION_OFFICER');
    CREATE TYPE "AdmissionStatus" AS ENUM ('REGISTERED', 'ENTRANCE_FEE_PAID', 'EXAM_SCHEDULED', 'EXAM_ATTENDED', 'EXAM_QUALIFIED', 'DOCUMENTS_PENDING', 'DOCUMENTS_SUBMITTED', 'DOCUMENTS_VERIFIED', 'SEAT_ALLOTTED', 'ADMISSION_CONFIRMED', 'ENROLLED', 'REJECTED', 'CANCELLED', 'EXAM_NOT_QUALIFIED');
    CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DROPPED', 'COMPLETED');
    CREATE TYPE "FeeStatus" AS ENUM ('PENDING', 'PARTIAL', 'FULL');
    CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'REFUNDED');
    CREATE TYPE "PaymentComponent" AS ENUM ('APPLICATION_FEE', 'TUITION', 'HOSTEL', 'TRANSPORT', 'OTHER', 'SCHOLARSHIP_TOKEN');
    CREATE TYPE "AccommodationType" AS ENUM ('HOSTEL', 'TRANSPORT', 'NONE');
    CREATE TYPE "HostelType" AS ENUM ('SHARING_4', 'SHARING_8');
    CREATE TYPE "DiscountStatus" AS ENUM ('REQUESTED', 'FORWARDED_TO_SUPER_ADMIN', 'APPROVED', 'REJECTED');
    CREATE TYPE "CancellationStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');
    CREATE TYPE "FileKind" AS ENUM ('PROFILE', 'AADHAR', 'MARKSHEET', 'TC', 'CASTE', 'HALL_TICKET', 'OTHER');
    CREATE TYPE "RequestStatus" AS ENUM ('REQUESTED', 'FORWARDED', 'APPROVED', 'REJECTED');
    CREATE TYPE "StudentDocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
    CREATE TYPE "HostelAllocationStatus" AS ENUM ('ACTIVE', 'VACATED');
    CREATE TYPE "TransportAllocationStatus" AS ENUM ('ACTIVE', 'CANCELLED');
    CREATE TYPE "AgentCommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED');
    CREATE TYPE "OfflineUploadBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
    CREATE TYPE "ScholarshipStatus" AS ENUM ('RESERVED', 'LOCKED', 'EXPIRED', 'UTILIZED');
    CREATE TYPE "QuotaType" AS ENUM ('MANAGEMENT', 'CONVENOR');
    CREATE TYPE "ApplicationMode" AS ENUM ('ONLINE', 'OFFLINE', 'SEAT_BOOKING');
    CREATE TYPE "ImportType" AS ENUM ('OFFLINE_ADMISSION', 'CONVENOR_ADMISSION');
    CREATE TYPE "HostelRoomType" AS ENUM ('AC', 'NON_AC');
    CREATE TYPE "PaymentMode" AS ENUM ('ONLINE', 'OFFLINE');
    CREATE TYPE "PaymentMethod" AS ENUM ('UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'WALLET', 'CASH', 'CHEQUE', 'DEMAND_DRAFT', 'NEFT_RTGS');
    CREATE TYPE "LedgerTransactionType" AS ENUM ('CREDIT', 'DEBIT');
    CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
    CREATE TYPE "AdmissionSource" AS ENUM ('WEBSITE', 'WALKIN', 'AGENT', 'REFERRAL', 'COUNCIL');
    CREATE TYPE "QualificationMode" AS ENUM ('EXAM', 'DIRECT');
    CREATE TYPE "OverrideType" AS ENUM ('GRANT', 'REVOKE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Create Tables

CREATE TABLE "School" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL UNIQUE,
    "code" TEXT NOT NULL UNIQUE,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false
);

CREATE TABLE "Department" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL UNIQUE,
    "code" TEXT NOT NULL UNIQUE,
    "schoolId" TEXT REFERENCES "School"("id"),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false
);

CREATE TABLE "Course" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "code" TEXT UNIQUE,
    "name" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL REFERENCES "Department"("id"),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false,
    "degree" TEXT,
    "filledSeats" INTEGER DEFAULT 0,
    "totalSeats" INTEGER DEFAULT 0
);

CREATE TABLE "User" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT,
    "email" TEXT UNIQUE,
    "phone" TEXT UNIQUE,
    "role" "UserRole" DEFAULT 'STUDENT',
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false,
    "password" TEXT
);

CREATE TABLE "UserOtp" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" TEXT NOT NULL REFERENCES "User"("id"),
    "type" TEXT NOT NULL,
    "otpHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER DEFAULT 0,
    "maxAttempts" INTEGER DEFAULT 5,
    "used" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "Specialization" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "code" TEXT UNIQUE,
    "name" TEXT NOT NULL,
    "courseId" TEXT NOT NULL REFERENCES "Course"("id"),
    "totalSeats" INTEGER NOT NULL,
    "filledSeats" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false
);

CREATE TABLE "Batch" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "courseId" TEXT NOT NULL, 
    "specializationId" TEXT NOT NULL REFERENCES "Specialization"("id"),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false
);

CREATE TABLE "Section" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "batchId" TEXT NOT NULL REFERENCES "Batch"("id"),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false
);

CREATE TABLE "AcademicYear" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL UNIQUE,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN DEFAULT true,
    "isLocked" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false
);

CREATE TABLE "ScholarshipRule" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "minPercentile" DOUBLE PRECISION NOT NULL,
    "discountPercentage" DOUBLE PRECISION NOT NULL,
    "totalSlots" INTEGER NOT NULL,
    "filledSlots" INTEGER DEFAULT 0,
    "degreeType" TEXT,
    "isActive" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Student" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "applicationId" TEXT UNIQUE,
    "name" TEXT NOT NULL,
    "fatherName" TEXT NOT NULL,
    "motherName" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "dob" TIMESTAMP(3) NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT UNIQUE,
    "aadharNumber" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "address2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "pincode" TEXT NOT NULL,
    "profilePhotoUrl" TEXT,
    "documentFolderPath" TEXT,
    "source" "AdmissionSource" DEFAULT 'WEBSITE',
    "quotaType" "QuotaType" DEFAULT 'MANAGEMENT',
    "applicationMode" "ApplicationMode" DEFAULT 'ONLINE',
    "isOffline" BOOLEAN DEFAULT false,
    "isKycVerified" BOOLEAN DEFAULT false,
    "pref1" TEXT REFERENCES "Course"("id"),
    "pref2" TEXT REFERENCES "Course"("id"),
    "pref3" TEXT REFERENCES "Course"("id"),
    "userId" TEXT UNIQUE REFERENCES "User"("id"),
    "agentId" TEXT REFERENCES "User"("id"),
    "eligibleScholarshipRuleId" TEXT REFERENCES "ScholarshipRule"("id"),
    "degreeType" TEXT,
    "courseType" TEXT,
    "scholarshipRemarks" TEXT,
    "scholarshipVerified" BOOLEAN DEFAULT false,
    "scholarshipVerifiedAt" TIMESTAMP(3),
    "scholarshipVerifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "StudentEnrollment" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL UNIQUE REFERENCES "Student"("id"),
    "sectionId" TEXT NOT NULL REFERENCES "Section"("id"),
    "rollNumber" TEXT NOT NULL UNIQUE,
    "currentSemester" INTEGER DEFAULT 1,
    "academicYearId" TEXT NOT NULL REFERENCES "AcademicYear"("id"),
    "status" "EnrollmentStatus" DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "Hostel" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "type" TEXT, -- Legacy Type
    "wardenName" TEXT,
    "capacity" INTEGER NOT NULL,
    "filled" INTEGER DEFAULT 0,
    "blockName" TEXT,
    "roomNumber" TEXT,
    "isDeleted" BOOLEAN DEFAULT false,
    "cost" DOUBLE PRECISION DEFAULT 0,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "HostelBlock" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "hostelId" TEXT NOT NULL REFERENCES "Hostel"("id"),
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false
);

CREATE TABLE "HostelRoom" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "blockId" TEXT NOT NULL REFERENCES "HostelBlock"("id"),
    "number" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "cost" DOUBLE PRECISION DEFAULT 0,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN DEFAULT false
);

CREATE TABLE "HostelBed" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "roomId" TEXT NOT NULL REFERENCES "HostelRoom"("id"),
    "number" TEXT NOT NULL,
    "isOccupied" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "HostelAllocation" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL UNIQUE REFERENCES "Student"("id"),
    "bedId" TEXT NOT NULL UNIQUE REFERENCES "HostelBed"("id"),
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "HostelAllocationStatus" DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "HostelPriceCategory" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "sharing" INTEGER NOT NULL,
    "roomType" "HostelRoomType" NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    UNIQUE("sharing", "roomType")
);

CREATE TABLE "Vehicle" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "number" TEXT NOT NULL UNIQUE,
    "capacity" INTEGER NOT NULL,
    "driverName" TEXT NOT NULL,
    "driverPhone" TEXT NOT NULL,
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "TransportRoute" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "city" TEXT,
    "busNumber" TEXT,
    "capacity" INTEGER DEFAULT 0,
    "filled" INTEGER DEFAULT 0,
    "vehicleId" TEXT REFERENCES "Vehicle"("id"),
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "TransportStop" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "routeId" TEXT NOT NULL REFERENCES "TransportRoute"("id"),
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "pickupTime" TIMESTAMP(3) NOT NULL,
    "dropTime" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "StudentAdmission" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL UNIQUE REFERENCES "Student"("id"),
    "status" "AdmissionStatus" DEFAULT 'REGISTERED',
    "qualificationMode" "QualificationMode",
    "totalFee" DOUBLE PRECISION DEFAULT 0,
    "paidFee" DOUBLE PRECISION DEFAULT 0,
    "feeStatus" "FeeStatus" DEFAULT 'PENDING',
    "accommodationType" "AccommodationType" DEFAULT 'NONE',
    "hostelType" "HostelType",
    "hostelId" TEXT REFERENCES "Hostel"("id"),
    "transportRouteId" TEXT REFERENCES "TransportRoute"("id"),
    "roomNumber" TEXT,
    "allottedCourseId" TEXT REFERENCES "Course"("id"),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "TransportAllocation" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL UNIQUE REFERENCES "Student"("id"),
    "routeId" TEXT NOT NULL REFERENCES "TransportRoute"("id"),
    "stopId" TEXT NOT NULL REFERENCES "TransportStop"("id"),
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" "TransportAllocationStatus" DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "FeeHead" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "FeeStructure" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "courseId" TEXT NOT NULL REFERENCES "Course"("id"),
    "feeHeadId" TEXT NOT NULL REFERENCES "FeeHead"("id"),
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT DEFAULT 'INR',
    "academicYearId" TEXT NOT NULL REFERENCES "AcademicYear"("id"),
    "quotaType" "QuotaType",
    "courseType" TEXT,
    "dueDate" TIMESTAMP(3),
    "yearOfStudy" INTEGER,
    "degreeId" TEXT,
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "StudentFeeDemand" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "feeStructureId" TEXT NOT NULL REFERENCES "FeeStructure"("id"),
    "amount" DOUBLE PRECISION NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "FeeStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "Payment" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT DEFAULT 'INR',
    "status" "PaymentStatus" DEFAULT 'PENDING',
    "mode" "PaymentMode" DEFAULT 'ONLINE',
    "method" TEXT, -- Legacy Text, will be updated to Enum later
    "providerTx" TEXT,
    "merchantOrderId" TEXT,
    "signature" TEXT,
    "referenceNumber" TEXT,
    "bankName" TEXT,
    "branchName" TEXT,
    "instrumentDate" TIMESTAMP(3),
    "collectedBy" TEXT,
    "component" "PaymentComponent" NOT NULL,
    "metadata" JSONB,
    "invoiceUrl" TEXT,
    "feeDemandId" TEXT REFERENCES "StudentFeeDemand"("id"),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "SystemSetting" (
    "key" TEXT PRIMARY KEY,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "isLocked" BOOLEAN DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT
);

CREATE TABLE "AuditLog" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId" TEXT REFERENCES "User"("id"),
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "timestamp" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT
);

CREATE TABLE "StudentDocument" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "documentKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" "StudentDocumentStatus" DEFAULT 'PENDING',
    "remarks" TEXT,
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "ConvenorAdmission" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL UNIQUE REFERENCES "Student"("id"),
    "rank" TEXT,
    "hallTicketNo" TEXT,
    "allotmentOrder" TEXT,
    "councilId" TEXT,
    "category" TEXT,
    "joiningReport" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "DataImportMapping" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL UNIQUE,
    "type" "ImportType" NOT NULL,
    "mapping" JSONB NOT NULL,
    "isActive" BOOLEAN DEFAULT true,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "ExamCenter" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "capacity" INTEGER,
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "ExamSlot" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "examCenterId" TEXT NOT NULL REFERENCES "ExamCenter"("id"),
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "filled" INTEGER DEFAULT 0,
    "isBookingEnabled" BOOLEAN DEFAULT false,
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "StudentExam" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL UNIQUE REFERENCES "Student"("id"),
    "hallTicketUrl" TEXT,
    "testDate" TIMESTAMP(3),
    "testCenter" TEXT,
    "examAttended" BOOLEAN DEFAULT false,
    "examScore" DOUBLE PRECISION,
    "isQualified" BOOLEAN DEFAULT false,
    "examSlotId" TEXT REFERENCES "ExamSlot"("id"),
    "class12Aggregate" DOUBLE PRECISION,
    "jeePercentile" DOUBLE PRECISION,
    "satScore" DOUBLE PRECISION,
    "vvitPercentile" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "HallTicket" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "fileId" TEXT,
    "url" TEXT,
    "qrHash" TEXT,
    "generatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "ExamDate" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "InvigilatorCredential" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "adminId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "AttendanceRecord" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "examDateId" TEXT REFERENCES "ExamDate"("id"),
    "invigilatorId" TEXT,
    "scannedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "verified" BOOLEAN DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP, -- Note: model missing created/updated? assume needed
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "SeatAllocation" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "oldCourse" TEXT,
    "newCourse" TEXT,
    "allocatedBy" TEXT,
    "allocatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "CourseChangeLog" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "oldCourse" TEXT NOT NULL,
    "newCourse" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "date" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "CourseChangeRequest" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "fromCourse" TEXT NOT NULL,
    "toCourse" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RequestStatus" DEFAULT 'REQUESTED',
    "forwardedTo" TEXT,
    "actionedBy" TEXT,
    "actionedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "DiscountRequest" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "reason" TEXT NOT NULL,
    "documentUrl" TEXT,
    "status" "DiscountStatus" DEFAULT 'REQUESTED',
    "remarks" TEXT,
    "requestedAmount" DOUBLE PRECISION DEFAULT 0,
    "approvedAmount" DOUBLE PRECISION,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "component" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "CancellationRequest" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "reason" TEXT NOT NULL,
    "refundAmount" DOUBLE PRECISION,
    "status" "CancellationStatus" DEFAULT 'REQUESTED',
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "FileUpload" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "studentId" TEXT REFERENCES "Student"("id"),
    "uploadedBy" TEXT,
    "url" TEXT NOT NULL,
    "kind" "FileKind" NOT NULL,
    "fileName" TEXT,
    "mime" TEXT,
    "size" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "AgentCommission" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "agentId" TEXT NOT NULL REFERENCES "User"("id"),
    "studentId" TEXT NOT NULL REFERENCES "Student"("id"),
    "amount" DOUBLE PRECISION NOT NULL,
    "component" TEXT NOT NULL,
    "status" "AgentCommissionStatus" DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "Notification" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "recipientId" TEXT NOT NULL REFERENCES "User"("id"),
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "isRead" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "OfflineUploadBatch" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "agentId" TEXT,
    "uploadedBy" TEXT,
    "sourceFileUrl" TEXT,
    "status" "OfflineUploadBatchStatus" DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

CREATE TABLE "DocumentRequirement" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "documentName" TEXT NOT NULL,
    "documentKey" TEXT NOT NULL,
    "isRequired" BOOLEAN DEFAULT true,
    "degreeType" TEXT NOT NULL,
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    UNIQUE("degreeType", "documentKey")
);

CREATE TABLE "QualificationRequirement" (
    "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
    "degreeType" TEXT NOT NULL,
    "ruleType" TEXT DEFAULT 'SINGLE',
    "qualificationKeys" TEXT[],
    "isRequired" BOOLEAN DEFAULT true,
    "isDeleted" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT
);

-- (Wait to add more if strictly needed, but this covers the core schema)

COMMIT;
