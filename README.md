# End-to-End API Documentation

This document provides a comprehensive overview of all API routes, the data they handle, and the database tables they interact with.

## 1. Auth Routes
**File:** `src/routes/authRoutes.ts`

| Method | Endpoint | Description | Data Stored/Updated | Tables Involved |
| :--- | :--- | :--- | :--- | :--- |
| POST | `/auth/send-otp` | Sends an OTP to the provided phone number. Creates a user if one doesn't exist. | `phone`, `role`, `otp`, `otpExpiry` | `User` |
| POST | `/auth/verify-otp` | Verifies the OTP and logs the user in. | Clears `otp` and `otpExpiry` upon success. | `User` |

## 2. Student Routes
**File:** `src/routes/studentRoutes.ts`

| Method | Endpoint | Description | Data Stored/Updated | Tables Involved |
| :--- | :--- | :--- | :--- | :--- |
| POST | `/student/register` | Registers a new student application. | `name`, `email`, `phone`, `dob`, `address`, `courseType`, `preferences`, etc. | `Student`, `StudentAdmission`, `StudentExam` |
| POST | `/student/:studentId/pay-test-fee` | Marks the test fee as paid for a student. | `status` (StudentAdmission), Payment record | `StudentAdmission`, `Payment`, `AgentCommission` |
| GET | `/student/:studentId/hall-ticket` | Retrieves the generated hall ticket URL. | None (Read-only) | `StudentExam` (reads `hallTicketUrl`) |
| POST | `/student/:studentId/upload-docs` | Uploads documents and updates branch preferences. | `documentKey`, `url`, `status` (StudentDocument), `pref1` (Student) | `Student`, `StudentDocument`, `StudentAdmission` |
| POST | `/student/:studentId/pay-college-fee` | Processes the college admission fee payment. | `status`, `feeStatus` (StudentAdmission), Payment record | `StudentAdmission`, `Payment`, `AgentCommission` |
| POST | `/student/:studentId/academic-details` | Adds academic qualification details (10th, 12th, etc.). | `level`, `board`, `yearOfPassing`, `hallTicketNumber`, `gpaOrMarks` | `AcademicQualification` |
| POST | `/student/:studentId/select-exam` | Selects an exam slot and generates a hall ticket. | `examSlotId` (StudentExam), `filled` (ExamSlot), `url`, `qrHash` (HallTicket) | `StudentExam`, `ExamSlot`, `HallTicket`, `StudentAdmission` |
| GET | `/student/exam-slots` | Lists available exam slots. | None (Read-only) | `ExamSlot` |
| GET | `/student/document-requirements` | Lists document requirements for the student's course. | None (Read-only) | `DocumentRequirement` |
| DELETE | `/student/:studentId/document` | Deletes a specific uploaded document. | Sets specific document URL field to null. | `StudentDocument` |

## 3. Admin Routes
**File:** `src/routes/adminRoutes.ts`

| Method | Endpoint | Description | Data Stored/Updated | Tables Involved |
| :--- | :--- | :--- | :--- | :--- |
| POST | `/admin/add-admin` | Adds a new admin user. | `name`, `email`, `phone`, `role`, `password` | `User` |
| GET | `/admin/commissions` | Retrieves agent commissions. | None (Read-only) | `AgentCommission` |
| POST | `/admin/upload-results` | Bulk uploads exam results via CSV. | `examScore`, `isQualified` | `StudentExam` |
| POST | `/admin/hostels` | Creates a new hostel. | `name`, `type`, `capacity`, `fee` | `Hostel` |
| GET | `/admin/hostels` | Lists all hostels. | None (Read-only) | `Hostel` |
| PUT | `/admin/hostels/:hostelId` | Updates hostel details. | `name`, `capacity`, `fee` | `Hostel` |
| GET | `/admin/dashboard-stats` | Retrieves dashboard statistics. | None (Read-only) | `Student`, `StudentAdmission` (aggregates) |
| GET | `/admin/applications` | Lists all student applications with pagination and search. | None (Read-only) | `Student`, `StudentAdmission` |
| POST | `/admin/upload-applications` | Bulk uploads student applications via CSV. | Creates multiple Student records. | `Student`, `StudentAdmission`, `StudentExam` |
| GET | `/admin/certificates/:studentId` | Retrieves URLs of student certificates. | None (Read-only) | `StudentDocument` |
| POST | `/admin/mark-attendance` | Marks student attendance for an exam. | `examAttended` (StudentExam), `status` (StudentAdmission) | `StudentExam`, `StudentAdmission` |
| POST | `/admin/verify-allot` | Verifies documents and allots a branch seat. | `status`, `allottedBranch` (StudentAdmission), `filledSeats` (Branch) | `StudentAdmission`, `Branch`, `SeatAllocation` |
| POST | `/admin/change-branch` | Requests a branch change for a student. | `fromBranch`, `toBranch`, `reason`, `status` | `BranchChangeRequest` |
| POST | `/admin/approve-branch-change` | Approves a branch change request. | `status` (Request), `allottedBranch` (StudentAdmission), `filledSeats` (Branch), Log entry | `BranchChangeRequest`, `StudentAdmission`, `Branch`, `BranchChangeLog` |
| POST | `/admin/create-discount` | Creates a fee discount request. | `reason`, `documentUrl`, `status` | `DiscountRequest` |
| POST | `/admin/review-discount` | Reviews (forwards/rejects) a discount request. | `status`, `remarks` | `DiscountRequest` |
| POST | `/admin/approve-discount` | Approves or rejects a discount request. | `status` | `DiscountRequest` |
| POST | `/admin/request-cancellation` | Requests admission cancellation. | `reason`, `refundAmount`, `status` | `CancellationRequest` |
| POST | `/admin/approve-cancellation` | Approves cancellation. | `status` (Request), `status` (StudentAdmission), `filledSeats` (Branch) | `CancellationRequest`, `StudentAdmission`, `Branch` |
| POST | `/admin/update-exam-score` | Updates a student's exam score manually. | `examScore`, `isQualified` | `StudentExam` |
| GET | `/admin/download-documents/:studentId` | Downloads all student documents as a ZIP. | None (Read-only) | `StudentDocument` |
| POST | `/admin/transport-route` | Creates a new transport route. | `name`, `cost`, `busNumber`, `capacity` | `TransportRoute` |
| GET | `/admin/transport-route` | Lists all transport routes. | None (Read-only) | `TransportRoute` |
| POST | `/admin/update-admission` | Updates admission details (accommodation, fees). | `accommodationType`, `hostelId`, `transportRouteId`, `totalFee`, `feeStatus` | `StudentAdmission`, `Hostel`, `TransportRoute` |
| GET | `/admin/fee-stats` | Retrieves fee collection statistics. | None (Read-only) | `StudentAdmission` (aggregates) |
| POST | `/admin/generate-invigilator-credentials` | Generates bulk credentials for invigilators. | `token`, `validFrom`, `validUntil`, `adminId` | `InvigilatorCredential` |
| POST | `/admin/branch` | Creates a new academic branch. | `code`, `name`, `totalSeats` | `Branch` |
| POST | `/admin/department` | Creates a new department. | `name`, `code` | `Department` |
| POST | `/admin/program` | Creates a new program under a department. | `name`, `departmentId` | `Program` |
| POST | `/admin/batch` | Creates a new batch for a program. | `name`, `programId`, `startDate`, `endDate` | `Batch` |
| POST | `/admin/section` | Creates a new section for a batch. | `name`, `batchId` | `Section` |
| POST | `/admin/hostel-block` | Creates a new block in a hostel. | `name`, `type`, `hostelId` | `HostelBlock` |
| POST | `/admin/hostel-room` | Creates a new room in a hostel block and auto-generates beds. | `number`, `capacity`, `type`, `blockId` | `HostelRoom`, `HostelBed` |
| POST | `/admin/vehicle` | Creates a new transport vehicle. | `number`, `capacity`, `driverName` | `Vehicle` |
| POST | `/admin/transport-stop` | Creates a new stop for a transport route. | `name`, `sequence`, `time`, `routeId` | `TransportStop` |
| POST | `/admin/fee-head` | Creates a new fee head (category). | `name`, `description` | `FeeHead` |
| POST | `/admin/fee-structure` | Creates a fee structure for a program. | `amount`, `academicYearId`, `programId`, `feeHeadId` | `FeeStructure` |
| POST | `/admin/document-requirements` | Adds a required document configuration. | `courseType`, `documentName`, `documentKey`, `isRequired` | `DocumentRequirement` |
| GET | `/admin/document-requirements` | Lists all document requirements. | None (Read-only) | `DocumentRequirement` |
| PUT | `/admin/document-requirements/:id` | Updates a document requirement. | `name`, `isRequired` | `DocumentRequirement` |
| DELETE | `/admin/document-requirements/:id` | Removes a document requirement. | Deletes record. | `DocumentRequirement` |
| POST | `/admin/verify-document/:studentId` | Updates verification status of a specific document. | `status` (StudentDocument) | `StudentDocument` |

## 4. Exam Routes
**File:** `src/routes/examRoutes.ts`

| Method | Endpoint | Description | Data Stored/Updated | Tables Involved |
| :--- | :--- | :--- | :--- | :--- |
| POST | `/exam/dates` | Creates a new exam date. | `date` | `ExamDate` |
| POST | `/exam/centers` | Creates a new exam center. | `name`, `address`, `city`, `capacity` | `ExamCenter` |
| POST | `/exam/invigilators/generate` | Generates invigilator credentials (same as Admin route). | `token`, `validFrom`, `validUntil` | `InvigilatorCredential` |
| POST | `/exam/slots` | Creates an exam slot. | `date`, `startTime`, `endTime`, `capacity`, `examCenterId` | `ExamSlot` |
| GET | `/exam/slots` | Lists available exam slots. | None (Read-only) | `ExamSlot` |
| POST | `/exam/slots/:studentId/book` | Books an exam slot for a student. | `examSlotId` (StudentExam), `filled` (ExamSlot) | `StudentExam`, `ExamSlot`, `HallTicket`, `StudentAdmission` |
| POST | `/exam/invigilators/login` | Logs in an invigilator. | None (Read-only check) | `InvigilatorCredential` |
| POST | `/exam/attendance/scan` | Marks attendance via QR scan. | `examAttended` (StudentExam), `scannedAt` (AttendanceRecord) | `StudentExam`, `AttendanceRecord`, `StudentAdmission` |

## 5. Invigilator Routes
**File:** `src/routes/invigilatorRoutes.ts`

| Method | Endpoint | Description | Data Stored/Updated | Tables Involved |
| :--- | :--- | :--- | :--- | :--- |
| POST | `/invigilator/login` | Logs in an invigilator using a token. | None (Read-only check) | `InvigilatorCredential` |
| POST | `/invigilator/scan-qr` | Scans a student's QR code to mark attendance. | `examAttended` (StudentExam), `scannedAt` (AttendanceRecord) | `StudentExam`, `AttendanceRecord`, `StudentAdmission` |

## 6. Upload Routes
**File:** `src/routes/uploadRoutes.ts`

| Method | Endpoint | Description | Data Stored/Updated | Tables Involved |
| :--- | :--- | :--- | :--- | :--- |
| POST | `/api/upload/single` | Uploads a single file to S3. | None (Returns S3 URL) | None (Direct S3 interaction) |
| POST | `/api/upload/multiple` | Uploads multiple files to S3. | None (Returns S3 URLs) | None (Direct S3 interaction) |

## Database Schema Summary
**File:** `prisma/schema.prisma`

### Key Tables
- **User**: Stores authentication details for Admins, Agents, and Students.
- **Student**: Core table storing personal profile and preferences.
- **StudentExam**: Stores exam-related details (hall ticket, score, attendance).
- **StudentAdmission**: Stores admission status, fee details, and accommodation allocation.
- **StudentDocument**: Stores uploaded documents and their verification status.
- **Branch**: Stores academic branches and seat capacity.
- **ExamSlot**: Manages exam scheduling and capacity.
- **HallTicket**: Stores generated hall tickets and QR hashes.
- **AttendanceRecord**: Logs exam attendance.
- **Hostel / TransportRoute**: Manages accommodation and transport resources.
- **Payment**: Records all fee payments.
- **DocumentRequirement**: Configures which documents are needed for which course.
- **BranchChangeRequest / DiscountRequest / CancellationRequest**: Manages student requests and approval workflows.

### Key Relations
- **Student -> User**: Optional relation for Agents (`agentId`).
- **Student -> StudentExam**: 1:1 relation for exam details.
- **Student -> StudentAdmission**: 1:1 relation for admission details.
- **Student -> StudentDocument**: 1:N relation for documents.
- **StudentExam -> ExamSlot**: Links a student to their booked exam time.
- **StudentAdmission -> Hostel/TransportRoute**: Links a student to their accommodation.
- **Program -> Department**: Hierarchy of academic programs.
- **Batch -> Program**: Specific batches within a program.
- **Section -> Batch**: Sections within a batch.
