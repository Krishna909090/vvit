-- AddMissingPerformanceIndexes
-- Strategic composite indexes for common query patterns

-- Student lookups by application ID and status (common in admin searches)
CREATE INDEX IF NOT EXISTS "Student_applicationId_idx" ON "Student"("applicationId");

-- StudentAdmission filtering by status and dates (common in reporting)
CREATE INDEX IF NOT EXISTS "StudentAdmission_status_createdAt_idx" ON "StudentAdmission"("status", "createdAt");

-- AttendanceRecord lookups by date and verification status (attendance reports)
CREATE INDEX IF NOT EXISTS "AttendanceRecord_scannedAt_verified_idx" ON "AttendanceRecord"("scannedAt", "verified");
CREATE INDEX IF NOT EXISTS "AttendanceRecord_invigilatorId_verified_idx" ON "AttendanceRecord"("invigilatorId", "verified");

-- Payment lookups by status and date (financial reports)
CREATE INDEX IF NOT EXISTS "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Payment_studentId_status_idx" ON "Payment"("studentId", "status");

-- ExamSlot lookups by date and center (exam scheduling)
CREATE INDEX IF NOT EXISTS "ExamSlot_date_examCenterId_idx" ON "ExamSlot"("date", "examCenterId");
CREATE INDEX IF NOT EXISTS "ExamSlot_date_bookingEnabled_idx" ON "ExamSlot"("date", "bookingEnabled");

-- StudentDocument status filtering (document verification)
CREATE INDEX IF NOT EXISTS "StudentDocument_status_createdAt_idx" ON "StudentDocument"("status", "createdAt");

-- HallTicket lookups by student (quick retrieval)
CREATE INDEX IF NOT EXISTS "HallTicket_studentId_createdAt_idx" ON "HallTicket"("studentId", "createdAt");

-- Agent commission tracking
CREATE INDEX IF NOT EXISTS "AgentCommission_agentId_status_idx" ON "AgentCommission"("agentId", "status");

-- Discount requests filtering
CREATE INDEX IF NOT EXISTS "DiscountRequest_status_createdAt_idx" ON "DiscountRequest"("status", "createdAt");

-- Cancellation requests filtering  
CREATE INDEX IF NOT EXISTS "CancellationRequest_status_createdAt_idx" ON "CancellationRequest"("status", "createdAt");

-- DocumentRequirement lookups by courseType (already has unique constraint, but add index for reads)
CREATE INDEX IF NOT EXISTS "DocumentRequirement_courseType_isDeleted_idx" ON "DocumentRequirement"("courseType", "isDeleted");

-- Enrollment filtering by status and academic year
CREATE INDEX IF NOT EXISTS "Enrollment_status_academicYearId_idx" ON "Enrollment"("status", "academicYearId");
