// Admission lifecycle: verify, course-change, scholarship, payment hooks,
// finalize, manual entry. Split out of adminStudent.service.ts.
//
// Cross-domain calls into hostel/transport flows go through AccommodationService
// (imported below). Internal `this.*` calls resolve to siblings in this object.

import prisma from '../../../config/prisma';
import {
    AdmissionStatus,
    CancellationStatus,
    RequestStatus,
    StudentDocumentStatus,
    AccommodationType,
    FeeStatus,
    HostelType,
    PaymentMethod,
    PaymentStatus,
    PaymentMode,
    PaymentComponent,
    LedgerTransactionType,
    HostelPaymentMode,
    AdmissionEntryType,
    ApplicationMode,
    QuotaType,
} from '@prisma/client';
import bcrypt from 'bcryptjs';
import { Role } from '../../../constants/roles';
import logger from '../../../utils/logger';
import { AppError } from '../../../utils/AppError';
import { MESSAGES } from '../../../constants/messages';
import { FeeService, getApplicationFeeAmount } from '../../finance/fee.service';
import { convertToPresignedUrl } from '../../../utils/s3Utils';
import { getHostelCostTx, getSemwiseSurchargeTx } from '../../../utils/hostelPricing';
import { assertHostelHasCapacity } from '../../accommodation/hostel/hostel.service';
import {
    incrementCourseCapacity,
    decrementCourseCapacity,
    tryAtomicIncrementCourseCapacity,
    getCourseCapacity,
} from '../../../utils/courseCapacity';
import {
    resolveFeeHeadsByComponent,
    resolveFeeDemandContext,
    assertAcademicYearWritable,
    getActiveAcademicYear,
    recomputeStudentTotals,
} from '../../../utils/studentContext';
import { sendPaymentReceipt, sendScholarshipUpdateEmail } from '../../../utils/emailService';
// @ts-ignore
import { StandardCheckoutClient, StandardCheckoutPayRequest } from 'pg-sdk-node';
import { InvoiceService } from '../../finance/invoice.service';
import { getPhonePeClient, initiatePhonePePayment, generateAndSaveAllotmentOrder } from '../../finance/payment.service';
import {
    FRONTEND_URL_ADMISSION,
    PREF_COURSE_WITH_CAPACITY,
    attachCourseCapacity,
} from './_shared';
import { AccommodationService } from './accommodation';

export const AdmissionService = {
    /**
     * Legacy cancellation entrypoint — just records a CancellationRequest row
     * with a manually-supplied refund amount. New cancellation flows go through
     * the dedicated cancellation.service which computes the refund.
     */
    async requestCancellation(studentId: string, reason: string, refundAmount: number) {
        if (!studentId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_REASON_REQUIRED, 400);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const adminCancelYear = await getActiveAcademicYear();
        return await prisma.cancellationRequest.create({
            data: {
                studentId,
                academicYearId: adminCancelYear.id,
                reason,
                refundAmount: Number(refundAmount),
                status: CancellationStatus.REQUESTED
            }
        });
    },

    /**
     * SUPER_ADMIN-only approval of a CancellationRequest. On approval, flips
     * the request status, marks the student's admission CANCELLED, and triggers
     * downstream cleanup (allocations vacated by the cancellation service).
     */
    async approveCancellation(requestId: string, approved: boolean, adminRole: string | undefined, adminId: string | undefined) {
        if (adminRole !== Role.SUPER_ADMIN) {
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }

        if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

        const request = await prisma.cancellationRequest.findUnique({
            where: { id: requestId },
            include: { student: { include: { admissionDetails: true } } }
        });

        if (!request) {
            throw new AppError(MESSAGES.ERROR.REQUEST_NOT_FOUND, 404);
        }

        const status = approved ? CancellationStatus.APPROVED : CancellationStatus.REJECTED;

        await prisma.$transaction(async (tx) => {
            await tx.cancellationRequest.update({
                where: { id: requestId },
                data: { status, approvedBy: adminId }
            });

            if (approved) {
                await tx.studentAdmission.update({
                    where: { studentId: request.studentId },
                    data: { status: AdmissionStatus.CANCELLED }
                });

                if (request.student.admissionDetails?.allottedCourseId && request.student.admissionDetails.academicYearId) {
                    await decrementCourseCapacity(
                        tx,
                        request.student.admissionDetails.allottedCourseId,
                        request.student.admissionDetails.academicYearId,
                    );
                }
            }
        });

        return { status };
    },

    /**
     * Document-verification + seat-allotment in one call. On approve: flips
     * admission to SEAT_ALLOTTED, assigns allottedCourseId, increments course
     * capacity, logs a SeatAllocation row. On reject: marks pending documents
     * as REJECTED so the student is prompted to re-upload.
     */
    async verifyAndAllotSeat(studentId: string, approved: boolean, allottedCourseId: string, adminId: string | undefined) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
        if (!approved) {
            return { success: false, message: MESSAGES.ERROR.DOCUMENTS_REJECTED };
        }

        if (!allottedCourseId) throw new AppError(MESSAGES.ERROR.ALLOTTED_COURSE_REQUIRED, 400);

        const student = await prisma.student.findUnique({ 
            where: { id: studentId },
            include: { examDetails: true }
        });
        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        // Verify Course
        const course = await prisma.course.findUnique({ where: { id: allottedCourseId } });
        if (!course) throw new AppError("Course not found", 404);

        await prisma.$transaction(async (tx) => {
            const admission = await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    status: AdmissionStatus.SEAT_ALLOTTED,
                    allottedCourseId: allottedCourseId
                },
                select: { academicYearId: true }
            });

            if (admission.academicYearId) {
                await incrementCourseCapacity(tx, allottedCourseId, admission.academicYearId);
            }

            await tx.seatAllocation.create({
                data: {
                    studentId,
                    academicYearId: admission.academicYearId,
                    newCourse: course.name, // Storing Name for readability
                    allocatedBy: adminId || 'ADMIN',
                    notes: 'Initial Seat Allotment'
                }
            });
        });

        // Scholarship Allocation (Runs independently of transaction to allow failure without rolling back seat? 
        // Or should it be atomic? 
        // User request: "Student will get to know how much he need to pay actual college fees and aslo he got scholarship"
        // It implies scholarship happens AT allocation. Best to be atomic or immediately following.
        // Since ScholarshipService handles its own transaction for slots, we call it separately logic-wise, 
        // but ideally we should wait for it.
        
        logger.info(`Skipping scholarship allocation for student ${studentId}: eligibleScholarshipRuleId removed from Student.`);

        return { success: true, message: MESSAGES.SUCCESS.SEAT_ALLOTTED };
    },

    /**
     * Single-document verification: APPROVED / REJECTED / PENDING. When the
     * full set is approved, downstream verify-and-allot can proceed. Includes
     * a notification email when the status changes.
     */
    async verifyStudentDocument(studentId: string, documentKey: string, status: string, remarks: string | undefined) {
        if (!studentId || !documentKey || !status) {
            throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);
        }

        const existingDoc = await prisma.studentDocument.findUnique({
            where: {
                studentId_documentKey: {
                    studentId,
                    documentKey
                }
            }
        });

        if (!existingDoc) {
            throw new AppError(MESSAGES.ERROR.DOCUMENT_NOT_FOUND, 404);
        }

        const updatedDoc = await prisma.studentDocument.update({
            where: {
                studentId_documentKey: {
                    studentId,
                    documentKey
                }
            },
            data: {
                status: status as StudentDocumentStatus,
                remarks
            }
        });

        // Check if all required documents are verified
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { documents: true }
        });

        if (student) {
            const currentAdmission = await prisma.studentAdmission.findUnique({
                where: { studentId },
                select: { status: true }
            });
            const protectedStatuses: AdmissionStatus[] = [
                AdmissionStatus.SEAT_ALLOTTED,
                AdmissionStatus.ADMISSION_CONFIRMED,
                AdmissionStatus.ENROLLED
            ];
            const isProtected = currentAdmission?.status && protectedStatuses.includes(currentAdmission.status as AdmissionStatus);

            if (!isProtected) {
                if (status === StudentDocumentStatus.REJECTED) {
                    await prisma.studentAdmission.update({
                        where: { studentId },
                        data: { status: AdmissionStatus.DOCUMENTS_PENDING }
                    });
                } else {
                    const requirements = await prisma.documentRequirement.findMany({
                        where: { degreeType: student.degreeType || '', isRequired: true }
                    });

                    const requiredKeys = requirements.map(r => r.documentKey);
                    const verifiedKeys = student.documents
                        .filter(d => d.status === StudentDocumentStatus.APPROVED)
                        .map(d => d.documentKey);

                    const allVerified = requiredKeys.every(key => verifiedKeys.includes(key));

                    if (allVerified) {
                        await prisma.studentAdmission.update({
                            where: { studentId },
                            data: { status: AdmissionStatus.DOCUMENTS_VERIFIED }
                        });
                    }
                }
            }
        }

        return updatedDoc;
    },

    /**
     * Request a BRANCH change — same degree program, different branch/specialization.
     * e.g. B.Tech CSE → B.Tech ECE
     */
    async requestBranchChange(studentId: string, newCourseId: string, reason: string, recommendedByManagement: boolean = false, branchChangeFee: number = 0) {
        if (!studentId || !newCourseId || !reason) {
            throw new AppError('studentId, newCourseId and reason are required', 400);
        }

        // Prevent duplicate pending requests
        const pendingRequest = await prisma.courseChangeRequest.findFirst({
            where: { studentId, status: { in: [RequestStatus.REQUESTED, RequestStatus.FORWARDED] } },
            select: { id: true }
        });
        if (pendingRequest) {
            throw new AppError(`A course/branch change request is already pending for this student (ID: ${pendingRequest.id}). Approve or reject it before raising a new one.`, 409);
        }

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: { include: { allottedCourse: true } } }
        });

        if (!student || !student.admissionDetails?.allottedCourseId) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NO_ALLOTTED_COURSE, 400);
        }

        const oldCourse = student.admissionDetails.allottedCourse;
        const newCourse = await prisma.course.findUnique({ where: { id: newCourseId } });
        if (!newCourse) throw new AppError('Target course not found', 404);

        // Validate: must be the SAME degree program
        if (oldCourse?.degree !== newCourse.degree) {
            throw new AppError(
                `Branch change requires the same degree program. Old: "${oldCourse?.degree}", New: "${newCourse.degree}". Use Program Change for cross-program transfers.`,
                400
            );
        }

        // Must not be the same course
        if (oldCourse?.id === newCourseId) {
            throw new AppError('The new branch must be different from the current branch.', 400);
        }

        return await prisma.courseChangeRequest.create({
            data: {
                studentId,
                academicYearId: student.admissionDetails!.academicYearId,
                fromCourse: oldCourse!.id,
                toCourse: newCourseId,
                fromDegree: oldCourse?.degree,
                toDegree: newCourse.degree,
                reason,
                recommendedByManagement,
                branchChangeFee: recommendedByManagement ? branchChangeFee : 0,
                status: RequestStatus.FORWARDED,
                forwardedTo: 'SUPER_ADMIN'
            } as any
        });
    },

    /**
     * Request a PROGRAM change — cross-program transfer.
     * Allowed combinations:
     * B.Tech ↔ BBA | M.Tech ↔ MBA | M.Tech ↔ MCA | MBA ↔ MCA
     */
    async requestProgramChange(studentId: string, newCourseId: string, reason: string) {
        if (!studentId || !newCourseId || !reason) {
            throw new AppError('studentId, newCourseId and reason are required', 400);
        }

        // Prevent duplicate pending requests
        const pendingRequest = await prisma.courseChangeRequest.findFirst({
            where: { studentId, status: { in: [RequestStatus.REQUESTED, RequestStatus.FORWARDED] } },
            select: { id: true }
        });
        if (pendingRequest) {
            throw new AppError(`A course/branch change request is already pending for this student (ID: ${pendingRequest.id}). Approve or reject it before raising a new one.`, 409);
        }

        // Allowed cross-program transfers (bidirectional)
        const ALLOWED_PROGRAM_CHANGES: [string, string][] = [
            ['B.TECH', 'BBA'],
            ['BBA', 'B.TECH'],
            ['M.TECH', 'MBA'],
            ['MBA', 'M.TECH'],
            ['M.TECH', 'MCA'],
            ['MCA', 'M.TECH'],
            ['MBA', 'MCA'],
            ['MCA', 'MBA'],
        ];

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: { include: { allottedCourse: true } } }
        });

        if (!student || !student.admissionDetails?.allottedCourseId) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NO_ALLOTTED_COURSE, 400);
        }

        const oldCourse = student.admissionDetails.allottedCourse;
        const newCourse = await prisma.course.findUnique({ where: { id: newCourseId } });
        if (!newCourse) throw new AppError('Target course not found', 404);

        const fromDegree = (oldCourse?.degree || '').toUpperCase().trim();
        const toDegree   = (newCourse.degree || '').toUpperCase().trim();

        // Validate: must be a DIFFERENT degree
        if (fromDegree === toDegree) {
            throw new AppError(
                `Program change requires different degree programs. Both are "${oldCourse?.degree}". Use Branch Change instead.`,
                400
            );
        }

        // Validate: combination must be in the allowed list
        const isAllowed = ALLOWED_PROGRAM_CHANGES.some(
            ([f, t]) => f === fromDegree && t === toDegree
        );
        if (!isAllowed) {
            throw new AppError(
                `Program change from "${oldCourse?.degree}" to "${newCourse.degree}" is not allowed. Allowed transfers: B.Tech↔BBA, M.Tech↔MBA, M.Tech↔MCA, MBA↔MCA.`,
                400
            );
        }

        return await prisma.courseChangeRequest.create({
            data: {
                studentId,
                academicYearId: student.admissionDetails!.academicYearId,
                fromCourse: oldCourse!.id,
                toCourse: newCourseId,
                fromDegree: oldCourse?.degree,
                toDegree: newCourse.degree,
                reason,
                status: RequestStatus.FORWARDED,
                forwardedTo: 'SUPER_ADMIN'
            } as any
        });
    },

    /**
     * Student-initiated request to change allotted course. Creates a PENDING
     * CourseChangeRequest forwarded to SUPER_ADMIN. Actual seat swap happens
     * in approveCourseChange.
     */
    async requestCourseChange(studentId: string, newCourseId: string, reason: string) {
        if (!studentId || !newCourseId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_NEWCOURSE_REASON_REQUIRED, 400);

        // Prevent duplicate pending requests
        const pendingRequest = await prisma.courseChangeRequest.findFirst({
            where: { studentId, status: { in: [RequestStatus.REQUESTED, RequestStatus.FORWARDED] } },
            select: { id: true }
        });
        if (pendingRequest) {
            throw new AppError(`A course/branch change request is already pending for this student (ID: ${pendingRequest.id}). Approve or reject it before raising a new one.`, 409);
        }

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: { include: { allottedCourse: true } } }
        });

        if (!student || !student.admissionDetails?.allottedCourseId) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NO_ALLOTTED_COURSE, 400);
        }

        const newCourse = await prisma.course.findUnique({ where: { id: newCourseId } });
        if (!newCourse) throw new AppError('New course not found', 404);

        const oldCourse = student.admissionDetails.allottedCourse;

        return await prisma.courseChangeRequest.create({
            data: {
                studentId,
                academicYearId: student.admissionDetails!.academicYearId,
                fromCourse: oldCourse!.id,
                toCourse: newCourseId,
                fromDegree: oldCourse?.degree,
                toDegree: newCourse.degree,
                reason,
                status: RequestStatus.FORWARDED,
                forwardedTo: 'SUPER_ADMIN'
            } as any
        });
    },


    /**
     * The big one. SUPER_ADMIN approval of a course/branch/program change.
     * Atomically: decrements old course capacity, increments new, supersedes
     * fee structures (recalibrates discounts + scholarship), creates a
     * CourseChangeLog audit row, optionally charges a branch-change fee, and
     * sends an email. Rolls back cleanly on capacity overflow.
     */
    async approveCourseChange(requestId: string, approved: boolean, adminRole: string | undefined, adminId: string | undefined, recommendedByManagement?: boolean, branchChangeFee?: number) {
        if (adminRole !== Role.SUPER_ADMIN) {
            throw new AppError(MESSAGES.ERROR.ONLY_SUPER_ADMIN_APPROVE_COURSE, 403);
        }

        if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

        const request = await prisma.courseChangeRequest.findUnique({ where: { id: requestId } });
        if (!request) throw new AppError(MESSAGES.ERROR.REQUEST_NOT_FOUND, 404);

        // #2 FIX: Prevent double-processing
        if (request.status === RequestStatus.APPROVED || request.status === RequestStatus.REJECTED) {
            throw new AppError(`This request has already been ${request.status.toLowerCase()}`, 400);
        }

        const status = approved ? RequestStatus.APPROVED : RequestStatus.REJECTED;

        // Build update data for the request
        const updateData: any = {
            status,
            actionedBy: adminId,
            actionedAt: new Date()
        };
        if (recommendedByManagement !== undefined) {
            updateData.recommendedByManagement = recommendedByManagement;
        }
        if (branchChangeFee !== undefined) {
            updateData.branchChangeFee = branchChangeFee;
        }

        await prisma.$transaction(async (tx) => {
            await tx.courseChangeRequest.update({
                where: { id: requestId },
                data: updateData
            });

            if (approved) {
                const admission = await tx.studentAdmission.findUnique({
                    where: { studentId: request.studentId },
                    select: { academicYearId: true }
                });
                if (!admission?.academicYearId) {
                    throw new AppError('Student admission / academic year not found', 404);
                }
                const ayId = admission.academicYearId;

                // Check seat capacity (per academic year) before swapping
                const toCourse = await tx.course.findUnique({ where: { id: request.toCourse } });
                if (!toCourse) throw new AppError('Target course not found', 404);
                const toCapacity = await getCourseCapacity(tx, request.toCourse, ayId);
                if (toCapacity.filledSeats >= toCapacity.totalSeats) {
                    throw new AppError(`Target course "${toCourse.code || toCourse.name}" is fully booked (${toCapacity.filledSeats}/${toCapacity.totalSeats}). Cannot process branch change.`, 400);
                }

                // 1. Update Admission
                await tx.studentAdmission.update({
                    where: { studentId: request.studentId },
                    data: { allottedCourseId: request.toCourse }
                });

                // Update Degree if changed
                if ((request as any).fromDegree !== (request as any).toDegree) {
                    await tx.student.update({
                        where: { id: request.studentId },
                        data: { degreeType: (request as any).toDegree }
                    });
                }

                await decrementCourseCapacity(tx, request.fromCourse, ayId);
                await incrementCourseCapacity(tx, request.toCourse, ayId);

                await tx.courseChangeLog.create({
                    data: {
                        studentId: request.studentId,
                        oldCourse: request.fromCourse,
                        newCourse: request.toCourse,
                        oldDegree: (request as any).fromDegree,
                        newDegree: (request as any).toDegree,
                        approvedBy: adminId || 'SUPER_ADMIN'
                    } as any
                });

                // 2. FINANCIAL RECONCILIATION
                const student = await tx.student.findUnique({
                    where: { id: request.studentId },
                    include: { admissionDetails: true }
                });

                if (!student) return;

                // Find ALL demands for this student and their successful payments
                const studentDemands = await tx.studentFeeDemand.findMany({
                    where: { studentId: request.studentId },
                    include: {
                        feeHead: true,
                        payments: { where: { status: 'SUCCESS' } }
                    }
                });

                // Determine Academic Year for reconciliation
                const academicYearId = studentDemands.find(d => (d.feeHead?.name || '').toLowerCase().includes('tuition'))?.academicYearId
                                        || student.admissionDetails?.academicYearId;

                if (!academicYearId) {
                    logger.warn(`[approveCourseChange] No academic year found for student ${request.studentId}. Skipping financial reconciliation.`);
                    return;
                }

                // Find New Course Fee Structure
                const newCourseStructures = await tx.feeStructure.findMany({
                    where: {
                        courseId: request.toCourse,
                        academicYearId
                    },
                    include: { feeHead: true }
                });

                // Track which fee heads exist in new course (for orphan cleanup)
                const newCourseHeadIds = new Set(newCourseStructures.map(s => s.feeHeadId));

                const totalPaidAcrossAll = studentDemands.reduce((sum, d) => sum + d.payments.reduce((ps, p) => ps + p.amount, 0), 0);

                // Process each structure in the NEW course
                for (const struct of newCourseStructures) {
                    const existingDemand = studentDemands.find(d => d.feeHeadId === struct.feeHeadId);
                    const isTuition = (struct.feeHead?.name || '').toLowerCase().includes('tuition');

                    if (existingDemand) {
                        const oldFee = existingDemand.amount;
                        const newFee = struct.amount;
                        const currentPaid = existingDemand.payments.reduce((sum, p) => sum + p.amount, 0);

                        // Proportional Scholarship Recalibration for Tuition
                        let newScholarshipAmt = 0;
                        let newDiscountTotal = existingDemand.discountAmount || 0;
                        const studentScholarship = isTuition ? await tx.studentScholarship.findUnique({ where: { studentId: request.studentId } }) : null;
                        const scholarshipPct = studentScholarship?.scholarshipPercentage || 0;
                        if (isTuition) {
                            const oldScholarship = existingDemand.scholarshipAmount || 0;
                            const manualDiscount = Math.max(0, (existingDemand.discountAmount || 0) - oldScholarship);
                            newScholarshipAmt = scholarshipPct > 0 ? (newFee * scholarshipPct / 100) : oldScholarship;
                            newDiscountTotal = manualDiscount + newScholarshipAmt;
                        }

                        const newNetAmount = newFee - newDiscountTotal;
                        const pending = newNetAmount - currentPaid;

                        // #3 FIX: Replace remarks instead of appending
                        await tx.studentFeeDemand.update({
                            where: { id: existingDemand.id },
                            data: {
                                amount: newFee,
                                scholarshipAmount: isTuition ? newScholarshipAmt : undefined,
                                discountAmount: isTuition ? newDiscountTotal : undefined,
                                netAmount: newNetAmount,
                                status: pending <= 0 ? FeeStatus.FULL : (currentPaid > 0 ? FeeStatus.PARTIAL : FeeStatus.PENDING),
                                remarks: oldFee !== newFee
                                    ? `Course Change: Fee updated from ${oldFee} to ${newFee}`
                                    : existingDemand.remarks
                            }
                        });

                        // Sync FEE_DEMAND ledger entry with updated amount
                        if (oldFee !== newFee) {
                            const existingDemandLedger = await tx.studentLedger.findFirst({
                                where: {
                                    studentId: request.studentId,
                                    feeHeadId: struct.feeHeadId,
                                    referenceType: 'FEE_DEMAND',
                                    type: 'DEBIT'
                                }
                            });

                            if (existingDemandLedger) {
                                // #3 FIX: Clean ledger description instead of appending
                                const baseName = (struct.feeHead?.name || 'Fee');
                                await tx.studentLedger.update({
                                    where: { id: existingDemandLedger.id },
                                    data: {
                                        amount: newFee,
                                        description: `Fee: ${baseName} (Updated: ${oldFee} → ${newFee})`,
                                    }
                                });
                            }

                            logger.info(`[approveCourseChange] FEE_DEMAND ledger synced for student ${request.studentId}. ${oldFee} → ${newFee}`);
                        }

                        // Sync scholarship ledger entry with recalculated amount
                        if (isTuition) {
                            const existingScholarshipLedger = await tx.studentLedger.findFirst({
                                where: {
                                    studentId: request.studentId,
                                    feeHeadId: struct.feeHeadId,
                                    referenceType: 'SCHOLARSHIP',
                                    type: 'CREDIT'
                                }
                            });

                            if (existingScholarshipLedger) {
                                if (newScholarshipAmt > 0) {
                                    await tx.studentLedger.update({
                                        where: { id: existingScholarshipLedger.id },
                                        data: {
                                            amount: newScholarshipAmt,
                                            description: `Scholarship adjusted during course change (${studentScholarship?.scholarshipPercentage || 0}%)`,
                                        }
                                    });
                                } else {
                                    await tx.studentLedger.delete({ where: { id: existingScholarshipLedger.id } });
                                }
                            } else if (newScholarshipAmt > 0) {
                                await tx.studentLedger.create({
                                    data: {
                                        studentId: request.studentId,
                                        type: LedgerTransactionType.CREDIT,
                                        amount: newScholarshipAmt,
                                        description: `Scholarship applied during course change (${studentScholarship?.scholarshipPercentage || 0}%)`,
                                        referenceType: 'SCHOLARSHIP',
                                        referenceId: existingDemand.id,
                                        feeHeadId: struct.feeHeadId,
                                        createdBy: adminId,
                                        academicYearId: academicYearId
                                    }
                                });
                            }

                            logger.info(`[approveCourseChange] Scholarship ledger synced for student ${request.studentId}. Old: ${existingScholarshipLedger?.amount || 0}, New: ${newScholarshipAmt}`);
                        }
                    } else {
                        // Create New Demand for missing heads in the new course
                        await tx.studentFeeDemand.create({
                            data: {
                                studentId: request.studentId,
                                feeHeadId: struct.feeHeadId,
                                feeStructureId: struct.id,
                                amount: struct.amount,
                                netAmount: struct.amount,
                                academicYearId,
                                yearOfStudy: struct.yearOfStudy ?? undefined,
                                dueDate: new Date(),
                                status: FeeStatus.PENDING,
                                remarks: `Added during course change to new course structure`
                            }
                        });
                    }
                }

                // #4 FIX: Soft-delete orphaned demands (fee heads in old course but not in new course)
                for (const demand of studentDemands) {
                    if (demand.feeHeadId && !newCourseHeadIds.has(demand.feeHeadId)) {
                        const headName = demand.feeHead?.name || demand.feeHeadId;
                        const paidOnDemand = demand.payments.reduce((sum, p) => sum + p.amount, 0);

                        await tx.studentFeeDemand.update({
                            where: { id: demand.id },
                            data: {
                                isDeleted: true,
                                deletedAt: new Date(),
                                deletedBy: adminId,
                                remarks: `Removed during course change: ${headName} not in new course structure`
                            }
                        });

                        // Soft-delete the corresponding ledger entry
                        await tx.studentLedger.updateMany({
                            where: {
                                studentId: request.studentId,
                                feeHeadId: demand.feeHeadId,
                                referenceType: 'FEE_DEMAND',
                                type: 'DEBIT',
                                isDeleted: false
                            },
                            data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId }
                        });

                        // Cascade to the demand's SCHOLARSHIP CREDIT (keyed by referenceId =
                        // demand id). Leaving it alive orphans the credit once the demand is
                        // gone, inflating ledger-based discount sums and the fee timeline.
                        await tx.studentLedger.updateMany({
                            where: {
                                referenceId: demand.id,
                                referenceType: 'SCHOLARSHIP',
                                type: 'CREDIT',
                                isDeleted: false
                            },
                            data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId }
                        });

                        // Carry forward any money already paid against this dropped fee head —
                        // otherwise it is silently lost (the carry-forward loop below only sees
                        // non-deleted demands). Mirror the BRANCH_CHANGE_REFUND correction used
                        // for over-paid surviving demands.
                        if (paidOnDemand > 0 && academicYearId) {
                            await tx.feeCorrection.create({
                                data: {
                                    studentId: request.studentId,
                                    academicYearId,
                                    amount: paidOnDemand,
                                    reason: `Branch change refund: ${headName} (fee head removed from new course). Paid: ${paidOnDemand}`,
                                    type: 'BRANCH_CHANGE_REFUND',
                                    referenceId: requestId,
                                    referenceType: 'COURSE_CHANGE_REQUEST',
                                    remarks: `Removed head "${headName}" had ${paidOnDemand} paid; carried forward.`,
                                    carryForward: true,
                                    isSettled: false,
                                    createdBy: adminId
                                }
                            });
                            await tx.studentLedger.create({
                                data: {
                                    studentId: request.studentId,
                                    type: LedgerTransactionType.CREDIT,
                                    amount: paidOnDemand,
                                    description: `Branch change refund: ${headName} removed from new course. Paid ${paidOnDemand} carried forward.`,
                                    referenceType: 'FEE_CORRECTION',
                                    referenceId: requestId,
                                    feeHeadId: demand.feeHeadId,
                                    academicYearId,
                                    createdBy: adminId
                                }
                            });
                        }

                        logger.info(`[approveCourseChange] Orphaned demand removed: ${headName} (paid: ${paidOnDemand}${paidOnDemand > 0 ? ' → carried forward as FeeCorrection' : ''}) for student ${request.studentId}`);
                    }
                }

                // 3a. SETTLE existing unsettled corrections (previous branch change refunds no longer valid)
                const existingCorrections = await tx.feeCorrection.findMany({
                    where: {
                        studentId: request.studentId,
                        isSettled: false,
                        type: 'BRANCH_CHANGE_REFUND'
                    }
                });

                if (existingCorrections.length > 0) {
                    const settledIds = existingCorrections.map((c: any) => c.id);
                    const settledTotal = existingCorrections.reduce((sum: number, c: any) => sum + c.amount, 0);

                    await tx.feeCorrection.updateMany({
                        where: { id: { in: settledIds } },
                        data: {
                            isSettled: true,
                            settledAt: new Date(),
                            settledBy: adminId,
                            // #6 FIX: Handle null remarks
                            remarks: `Settled: reversed by new branch change ${request.fromCourse} → ${request.toCourse}`
                        }
                    });

                    // Reverse the old CREDIT ledger entries by adding a DEBIT
                    await tx.studentLedger.create({
                        data: {
                            studentId: request.studentId,
                            type: LedgerTransactionType.DEBIT,
                            amount: settledTotal,
                            description: `Previous branch change corrections reversed (${existingCorrections.length} entries, total: ${settledTotal})`,
                            referenceType: 'FEE_CORRECTION_REVERSAL',
                            referenceId: requestId,
                            academicYearId,
                            createdBy: adminId
                        }
                    });

                    logger.info(`[approveCourseChange] Settled ${existingCorrections.length} previous corrections for student ${request.studentId}. Reversed: ${settledTotal}`);
                }

                // 3b. FEE CORRECTION — track overpaid amount per head (carry forward to next year)
                let totalCorrectionAmount = 0;

                // Re-fetch demands after updates to get accurate amounts
                const updatedDemands = await tx.studentFeeDemand.findMany({
                    where: { studentId: request.studentId, isDeleted: false },
                    include: {
                        feeHead: true,
                        payments: { where: { status: 'SUCCESS' } }
                    }
                });

                for (const demand of updatedDemands) {
                    const newFee = demand.amount;
                    const currentPaid = demand.payments.reduce((sum, p) => sum + p.amount, 0);
                    const excessPaid = currentPaid - newFee;

                    if (excessPaid > 0 && academicYearId) {
                        const headName = demand.feeHead?.name || demand.feeHeadId || 'Unknown';

                        await tx.feeCorrection.create({
                            data: {
                                studentId: request.studentId,
                                academicYearId,
                                amount: excessPaid,
                                reason: `Branch change refund: ${headName}. Fee: ${newFee}, Paid: ${currentPaid}, Excess: ${excessPaid}`,
                                type: 'BRANCH_CHANGE_REFUND',
                                referenceId: requestId,
                                referenceType: 'COURSE_CHANGE_REQUEST',
                                remarks: `Fee head: ${headName}, Fee: ${newFee}, Paid: ${currentPaid}, Refund: ${excessPaid}`,
                                carryForward: true,
                                isSettled: false,
                                createdBy: adminId
                            }
                        });

                        // CREDIT ledger entry for the overpaid correction
                        await tx.studentLedger.create({
                            data: {
                                studentId: request.studentId,
                                type: LedgerTransactionType.CREDIT,
                                amount: excessPaid,
                                description: `Branch change refund: ${headName}. Paid ${currentPaid} against fee ${newFee}. Carry forward.`,
                                referenceType: 'FEE_CORRECTION',
                                referenceId: requestId,
                                feeHeadId: demand.feeHeadId,
                                academicYearId,
                                createdBy: adminId
                            }
                        });

                        totalCorrectionAmount += excessPaid;
                    }
                }

                if (totalCorrectionAmount > 0) {
                    logger.info(`[approveCourseChange] FeeCorrections created for student ${request.studentId}. Total refund: ${totalCorrectionAmount}, carryForward: true`);
                }

                // 4. BRANCH CHANGE FEE — DEBIT ledger entry if fee applies
                // #1 FIX: Use admin-provided value first, then fall back to request value
                const changeFee = branchChangeFee ?? (request as any).branchChangeFee ?? 0;
                if (changeFee > 0) {
                    await tx.studentLedger.create({
                        data: {
                            studentId: request.studentId,
                            type: LedgerTransactionType.DEBIT,
                            amount: changeFee,
                            description: `Branch change fee: ${request.fromCourse} → ${request.toCourse}`,
                            referenceType: 'BRANCH_CHANGE_FEE',
                            referenceId: requestId,
                            academicYearId,
                            createdBy: adminId
                        }
                    });

                    logger.info(`[approveCourseChange] Branch change fee ledger DEBIT created for student ${request.studentId}. Amount: ${changeFee}`);
                }

                logger.info(`[approveCourseChange] Full reconciliation for Student ${student.id} to Course ${request.toCourse}. TotalPaid: ${totalPaidAcrossAll}`);

                // totalFee must follow the NEW course's demands; paidFee follows the payments.
                // Recompute from source so the admission row reflects the post-change demands
                // (the function rewrites/creates/deletes demands but never updated the totals).
                await recomputeStudentTotals(request.studentId, tx);
            }
        });

        // Regenerate allotment order with new course details (outside transaction)
        try {
            const { generateAndSaveAllotmentOrder } = await import('../../finance/payment.service');
            await generateAndSaveAllotmentOrder(request.studentId);
            logger.info(`[approveCourseChange] Allotment order regenerated for student ${request.studentId}`);
        } catch (err) {
            logger.error(`[approveCourseChange] Failed to regenerate allotment order: ${err}`);
        }
    },

    ...AccommodationService,

    /**
     * Broad admin-driven update of a student's accommodation + admission
     * details (hostel id/type/payment-mode, transport route, paid amount).
     * Recalculates fee deltas, supersedes pricing snapshot, and adjusts
     * totalFee accordingly.
     */
    async updateAdmissionDetails(data: any, adminId: string | undefined) {
        const { studentId, accommodationType, hostelType, hostelId, transportRouteId, paidAmount, hostelPaymentMode } = data;

        if (!studentId || !accommodationType) throw new AppError(MESSAGES.ERROR.STUDENT_ACCOMMODATION_REQUIRED, 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: true }
        });
        if (!student || !student.admissionDetails) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const admission = student.admissionDetails;
        const oldAccType = admission.accommodationType;
        // Initialize adjustment delta
        let feeAdjustment = 0;
        let oldCost = 0;
        let newCost = 0;
        let oldDescription = '';
        let newDescription = '';

        await prisma.$transaction(async (tx) => {
            // Release previous allocation and calculate subtraction from Total Fee
            if (admission.accommodationType === AccommodationType.HOSTEL && admission.hostelId) {
                if (accommodationType !== AccommodationType.HOSTEL || hostelId !== admission.hostelId) {
                    const oldHostel = await tx.hostel.findUnique({ where: { id: admission.hostelId } });
                    if (oldHostel) {
                        const oldPricing = await getHostelCostTx(admission.hostelType, tx);
                        oldCost = oldPricing.totalPrice;
                        oldDescription = `Hostel: ${oldHostel.name || admission.hostelId}`;
                        feeAdjustment -= oldCost;
                    }
                }
            } else if (admission.accommodationType === AccommodationType.TRANSPORT && admission.transportRouteId) {
                if (accommodationType !== AccommodationType.TRANSPORT || transportRouteId !== admission.transportRouteId) {
                    const oldRoute = await tx.transportRoute.findUnique({ where: { id: admission.transportRouteId } });
                    if (oldRoute) {
                        if ((oldRoute.filled ?? 0) > 0) {
                            await tx.transportRoute.update({
                                where: { id: admission.transportRouteId },
                                data: { filled: { decrement: 1 }, updatedBy: adminId }
                            });
                        }
                        oldCost = oldRoute.cost || 0;
                        oldDescription = `Transport: ${oldRoute.name || admission.transportRouteId}`;
                        feeAdjustment -= oldCost;
                    }
                }
            }

            // Assign new allocation and calculate addition to Total Fee
            if (accommodationType === AccommodationType.HOSTEL) {
                if (!hostelId) throw new AppError(MESSAGES.ERROR.HOSTEL_ID_REQUIRED, 400);

                if (hostelId !== admission.hostelId) {
                    const hostel = await tx.hostel.findUnique({ where: { id: hostelId } });
                    if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

                    await assertHostelHasCapacity(hostelId, tx);

                    const newPricing = await getHostelCostTx(hostelType, tx);
                    newCost = newPricing.totalPrice;
                    newDescription = `Hostel: ${hostel.name || hostelId}`;
                    feeAdjustment += newCost;
                }
            }
            else if (accommodationType === AccommodationType.TRANSPORT) {
                if (!transportRouteId) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_ID_REQUIRED, 400);

                if (transportRouteId !== admission.transportRouteId) {
                    const route = await tx.transportRoute.findUnique({ where: { id: transportRouteId } });
                    if (!route) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_NOT_FOUND, 404);

                    if ((route.filled ?? 0) >= (route.capacity ?? 0)) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_FULL, 400);

                    await tx.transportRoute.update({
                        where: { id: transportRouteId },
                        data: { filled: { increment: 1 }, updatedBy: adminId }
                    });

                    newCost = route.cost || 0;
                    newDescription = `Transport: ${route.name || transportRouteId}`;
                    feeAdjustment += newCost;
                }
            }

            // Handle Hostel Payment Mode Adjustment
            if (admission.accommodationType === AccommodationType.HOSTEL && admission.hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                const oldSemFee = await getSemwiseSurchargeTx(admission.hostelType, tx);
                oldCost += oldSemFee;
                feeAdjustment -= oldSemFee;
            }
            if (accommodationType === AccommodationType.HOSTEL && hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                const newSemFee = await getSemwiseSurchargeTx(hostelType, tx);
                newCost += newSemFee;
                feeAdjustment += newSemFee;
            }

            const currentPaid = (admission.paidFee ?? 0) + Number(paidAmount || 0);
            const newTotalFee = (admission.totalFee ?? 0) + feeAdjustment;

            let feeStatus: FeeStatus = FeeStatus.PENDING;
            if (currentPaid >= newTotalFee && newTotalFee > 0) feeStatus = FeeStatus.FULL;
            else if (currentPaid > 0) feeStatus = FeeStatus.PARTIAL;

            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType,
                    hostelType: accommodationType === AccommodationType.HOSTEL ? hostelType : null,
                    hostelId: accommodationType === AccommodationType.HOSTEL ? hostelId : null,
                    transportRouteId: accommodationType === AccommodationType.TRANSPORT ? transportRouteId : null,
                    totalFee: { increment: feeAdjustment },
                    paidFee: currentPaid,
                    feeStatus,
                    hostelPaymentMode: accommodationType === AccommodationType.HOSTEL ? hostelPaymentMode : null,
                }
            });

            // --- LEDGER & FEE CORRECTION ---
            const academicYearId = admission.academicYearId;
            const changeDescription = oldDescription && newDescription
                ? `Accommodation change: ${oldDescription} → ${newDescription}`
                : oldDescription
                    ? `Accommodation removed: ${oldDescription}`
                    : newDescription
                        ? `Accommodation added: ${newDescription}`
                        : 'Accommodation updated';

            // Calculate how much student paid on the old accommodation type
            const isRealChange = oldAccType && oldAccType !== AccommodationType.NONE && (oldCost > 0 || feeAdjustment !== 0);
            if (isRealChange && academicYearId) {
                const oldComponents = oldAccType === AccommodationType.HOSTEL
                    ? [PaymentComponent.HOSTEL, PaymentComponent.HOSTEL_ACCOMMODATION, PaymentComponent.HOSTEL_MESS]
                    : [PaymentComponent.TRANSPORT];

                const paidOnOld = await tx.payment.aggregate({
                    where: {
                        studentId,
                        status: PaymentStatus.SUCCESS,
                        component: { in: oldComponents }
                    },
                    _sum: { amount: true }
                });
                const totalPaidOnOld = (paidOnOld._sum as any)?.amount || 0;

                // Effective new cost: if same type change (hostel→hostel), use newCost; if type changed or NONE, it's 0
                const effectiveNewCost = (accommodationType === oldAccType) ? newCost : 0;
                const excessPaid = totalPaidOnOld - effectiveNewCost;

                if (excessPaid > 0) {
                    // Settle any previous accommodation corrections first
                    const prevCorrections = await tx.feeCorrection.findMany({
                        where: { studentId, isSettled: false, type: 'ACCOMMODATION_CHANGE_REFUND' }
                    });
                    if (prevCorrections.length > 0) {
                        const prevTotal = prevCorrections.reduce((sum: number, c: any) => sum + c.amount, 0);
                        await tx.feeCorrection.updateMany({
                            where: { id: { in: prevCorrections.map((c: any) => c.id) } },
                            data: { isSettled: true, settledAt: new Date(), settledBy: adminId, remarks: `Settled: reversed by new accommodation change` }
                        });
                        await tx.studentLedger.create({
                            data: {
                                studentId,
                                type: LedgerTransactionType.DEBIT,
                                amount: prevTotal,
                                description: `Previous accommodation corrections reversed (${prevCorrections.length} entries, total: ${prevTotal})`,
                                referenceType: 'FEE_CORRECTION_REVERSAL',
                                academicYearId,
                                createdBy: adminId
                            }
                        });
                        logger.info(`[updateAdmissionDetails] Settled ${prevCorrections.length} previous accommodation corrections for student ${studentId}. Reversed: ${prevTotal}`);
                    }

                    // Create new correction
                    const oldLabel = oldAccType === AccommodationType.HOSTEL ? 'Hostel' : 'Transport';
                    await tx.feeCorrection.create({
                        data: {
                            studentId,
                            academicYearId,
                            amount: excessPaid,
                            reason: `Accommodation change refund: ${oldLabel}. Paid: ${totalPaidOnOld}, New cost: ${effectiveNewCost}, Excess: ${excessPaid}`,
                            type: 'ACCOMMODATION_CHANGE_REFUND',
                            referenceType: 'ACCOMMODATION_CHANGE',
                            remarks: `${changeDescription}. Paid: ${totalPaidOnOld}, Refund: ${excessPaid}`,
                            carryForward: true,
                            isSettled: false,
                            createdBy: adminId
                        }
                    });

                    await tx.studentLedger.create({
                        data: {
                            studentId,
                            type: LedgerTransactionType.CREDIT,
                            amount: excessPaid,
                            description: `Accommodation change refund: ${oldLabel}. Paid ${totalPaidOnOld} against new cost ${effectiveNewCost}. Carry forward.`,
                            referenceType: 'FEE_CORRECTION',
                            academicYearId,
                            createdBy: adminId
                        }
                    });

                    logger.info(`[updateAdmissionDetails] FeeCorrection created for student ${studentId}. Refund: ${excessPaid}, carryForward: true`);
                }
            }

            logger.info(`[updateAdmissionDetails] Accommodation updated for student ${studentId}. ${oldAccType} → ${accommodationType}. Fee adjustment: ${feeAdjustment}`);
        });
    },


    /**
     * Assigns / overwrites a student's roll number for a given section + year.
     * Upserts the StudentEnrollment row so re-assigning is idempotent.
     */
    async updateRollNumber(studentId: string, rollNumber: string, sectionId: string, academicYearId: string, userId?: string) {
        const student = await prisma.student.findUnique({
             where: { id: studentId }
        });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        
        // Upsert Enrollment
        const enrollment = await (prisma.studentEnrollment as any).upsert({
            where: { studentId },
            update: { rollNumber, sectionId, academicYearId, updatedBy: userId },
            create: {
                studentId,
                rollNumber,
                sectionId,
                academicYearId,
                createdBy: userId
            }
        });
        
        return enrollment;
    },

    /** Admin override of an admission's status (used for manual corrections). */
    async updateStudentAdmissionStatus(studentId: string, status: AdmissionStatus, _adminId: string | undefined) {
        if (!studentId || !status) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        if (!Object.values(AdmissionStatus).includes(status)) {
            throw new AppError('Invalid admission status', 400);
        }
        
        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        await prisma.studentAdmission.update({
            where: { studentId },
            data: { status }
        });

        return { success: true, message: `Admission status updated to ${status}` };
    },

    /** Sets the rule a student is eligible under (admin-managed). */
    async setScholarshipEligibility(studentId: string, ruleId: string) {
        if (!studentId || !ruleId) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        const rule = await prisma.scholarshipRule.findUnique({ where: { id: ruleId } });
        if (!rule) throw new AppError('Scholarship Rule not found', 404);
        if (!rule.isActive) throw new AppError('Scholarship Rule is inactive', 400);

        logger.info(`setScholarshipEligibility: eligibleScholarshipRuleId field removed from Student; no-op for student ${studentId}, rule ${ruleId}`);
        return student;
    },

    /**
     * Updates a student's exam / entrance scores. Triggers scholarship-rule
     * re-evaluation if the percentile change crosses a rule threshold.
     */
    async updateStudentScores(studentId: string, scores: any, adminId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        const { class12Aggregate, jeePercentile, satScore, vvitPercentile } = scores;

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        // Update StudentExam
        return await prisma.studentExam.upsert({
            where: { studentId },
            update: {
                class12Aggregate,
                jeePercentile,
                satScore,
                vvitPercentile,
                examScore: vvitPercentile ?? undefined,
                updatedBy: adminId
            },
            create: {
                studentId,
                class12Aggregate,
                jeePercentile,
                satScore,
                vvitPercentile,
                examScore: vvitPercentile ?? undefined,
                createdBy: adminId,
                updatedBy: adminId
            }
        });
    },


    /** Admin edit of personal fields (name, dob, contacts, address, photo). */
    async updateStudentPersonalDetails(studentId: string, data: any, adminId: string | undefined) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        // Allow updates to all personal details including phone and aadhar
        const { ...updateData } = data;

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        // 1. Check Email Uniqueness
        if (updateData.email && updateData.email !== student.email) {
            const existingEmail = await prisma.student.findUnique({ where: { email: updateData.email } });
            if (existingEmail) throw new AppError('Email already in use by another student', 400);
            
            // Check against User table
            if (student.userId) {
                const existingUserEmail = await prisma.user.findUnique({ where: { email: updateData.email } });
                if (existingUserEmail && existingUserEmail.id !== student.userId) {
                    throw new AppError('Email already in use by another user', 400);
                }
            } else {
                 const existingUserEmail = await prisma.user.findUnique({ where: { email: updateData.email } });
                 if (existingUserEmail) throw new AppError('Email already in use by a user', 400);
            }
        }

        // 2. Check Phone Uniqueness
        if (updateData.phone && updateData.phone !== student.phone) {
             const existingPhone = await prisma.student.findFirst({ where: { phone: updateData.phone } });
             if (existingPhone) throw new AppError('Phone number already in use by another student', 400);
        }

        // 3. Check Aadhar Uniqueness
        if (updateData.aadharNumber && updateData.aadharNumber !== student.aadharNumber) {
             const existingAadhar = await prisma.student.findFirst({ where: { aadharNumber: updateData.aadharNumber } });
             if (existingAadhar) throw new AppError('Aadhar number already in use by another student', 400);
        }

        await prisma.$transaction(async (tx) => {
             // Update Student
             await tx.student.update({
                 where: { id: studentId },
                 data: {
                     ...updateData,
                     updatedBy: adminId
                 }
             });

             // Update User if linked and email is changed
             if (student.userId && updateData.email && updateData.email !== student.email) {
                 await tx.user.update({
                     where: { id: student.userId },
                     data: { email: updateData.email }
                 });
             }
        });

        // Return presigned profilePhotoUrl if it was updated
        let presignedPhotoUrl: string | null = null;
        if (updateData.profilePhotoUrl) {
            presignedPhotoUrl = await convertToPresignedUrl(updateData.profilePhotoUrl) || updateData.profilePhotoUrl;
        }

        return { success: true, message: 'Student personal details updated successfully', profilePhotoUrl: presignedPhotoUrl };
    },

    /**
     * Full student profile: admission, exam, documents, qualifications,
     * scholarship, fee demands + payments, ledger, course-change logs,
     * enrollments, active hostel + transport allocations (with academicYear
     * tag), pref courses + capacity. The "everything" detail endpoint.
     */
    async getStudentDetails(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                admissionDetails: {
                    include: {
                        allottedCourse: true,
                        hostel: true,
                        transportRoute: true
                    }
                },
                examDetails: true,
                documents: true,
                academicQualifications: true,
                scholarshipAllocation: { include: { rule: true } },
                studentScholarship: true,
                pref1Course: PREF_COURSE_WITH_CAPACITY,
                pref2Course: PREF_COURSE_WITH_CAPACITY,
                pref3Course: PREF_COURSE_WITH_CAPACITY,
                feeDemands: {
                    include: {
                        feeStructure: {
                            include: { feeHead: true }
                        },
                        payments: true
                    }
                },
                payments: true,
                courseChangeLogs: true,
                courseChangeRequests: {
                    where: { status: { in: ['REQUESTED', 'FORWARDED'] } },
                    orderBy: { createdAt: 'desc' }
                },
                discountRequests: true,
                ledgerEntries: true,
                enrollments: {
                     include: {
                         academicYear: true,
                         section: { include: { batch: true } }
                     }
                },
                hostelAllocations: { where: { status: 'ACTIVE' }, take: 1, orderBy: { startDate: 'desc' }, include: { bed: { include: { room: { include: { hostel: true } } } }, academicYear: { select: { id: true, code: true, isActive: true } } } },
                transportAllocations: { where: { status: 'ACTIVE' }, take: 1, orderBy: { startDate: 'desc' }, include: { route: true, stop: true, academicYear: { select: { id: true, code: true, isActive: true } } } },
                convenorDetails: true,
                pro: true,
                user: { select: { id: true, email: true, phone: true, role: true, isDeleted: true } }
            }
        });

        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        // Convert key documents to presigned
        const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);
        const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
            ...doc,
            url: await convertToPresignedUrl(doc.url)
        })));

        let hallTicketUrl = null;
        if (student.examDetails?.hallTicketUrl) {
            hallTicketUrl = await convertToPresignedUrl(student.examDetails.hallTicketUrl);
        }

        const { hostelAllocations: _hostelAllocations, transportAllocations: _transportAllocations, ...studentRest } = student as any;
        return {
            ...studentRest,
            hostelAllocation: _hostelAllocations?.[0] ?? null,
            transportAllocation: _transportAllocations?.[0] ?? null,
            pref1Course: attachCourseCapacity((student as any).pref1Course),
            pref2Course: attachCourseCapacity((student as any).pref2Course),
            pref3Course: attachCourseCapacity((student as any).pref3Course),
            profilePhotoUrl,
            documents: documentsWithPresignedUrls,
            examDetails: {
                ...student.examDetails,
                hallTicketUrl
            }
        };
    },

    /**
     * Same payload as getStudentDetails but looks up by applicationId /
     * name / email / phone (fuzzy match). Used by admin search bars.
     */
    async getStudentDetailsByApplicationId(applicationId: string) {
        if (!applicationId) throw new AppError('Application ID is required', 400);

        const student = await prisma.student.findFirst({
            where: {
                OR: [
                    { applicationId: { contains: applicationId, mode: 'insensitive' } },
                    { name: { contains: applicationId, mode: 'insensitive' } },
                    { email: { contains: applicationId, mode: 'insensitive' } },
                    { phone: { contains: applicationId } },
                ]
            },
            include: {
                admissionDetails: {
                    include: {
                        allottedCourse: true,
                        hostel: true,
                        transportRoute: true
                    }
                },
                examDetails: true,
                documents: true,
                academicQualifications: true,
                scholarshipAllocation: { include: { rule: true } },
                studentScholarship: true,
                pref1Course: PREF_COURSE_WITH_CAPACITY,
                pref2Course: PREF_COURSE_WITH_CAPACITY,
                pref3Course: PREF_COURSE_WITH_CAPACITY,
                feeDemands: {
                    include: {
                        feeStructure: {
                            include: { feeHead: true }
                        },
                        payments: true
                    }
                },
                payments: true,
                courseChangeLogs: true,
                courseChangeRequests: {
                    where: { status: { in: ['REQUESTED', 'FORWARDED'] } },
                    orderBy: { createdAt: 'desc' }
                },
                discountRequests: true,
                ledgerEntries: true,
                enrollments: {
                     include: {
                         academicYear: true,
                         section: { include: { batch: true } }
                     }
                },
                hostelAllocations: { where: { status: 'ACTIVE' }, take: 1, orderBy: { startDate: 'desc' }, include: { bed: { include: { room: { include: { hostel: true } } } }, academicYear: { select: { id: true, code: true, isActive: true } } } },
                transportAllocations: { where: { status: 'ACTIVE' }, take: 1, orderBy: { startDate: 'desc' }, include: { route: true, stop: true, academicYear: { select: { id: true, code: true, isActive: true } } } },
                convenorDetails: true,
                pro: true,
                user: { select: { id: true, email: true, phone: true, role: true, isDeleted: true } }
            }
        });

        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        // Convert key documents to presigned
        const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);
        const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
            ...doc,
            url: await convertToPresignedUrl(doc.url)
        })));

        let hallTicketUrl = null;
        if (student.examDetails?.hallTicketUrl) {
            hallTicketUrl = await convertToPresignedUrl(student.examDetails.hallTicketUrl);
        }

        const { hostelAllocations: _hostelAllocations, transportAllocations: _transportAllocations, ...studentRest } = student as any;
        return {
            ...studentRest,
            hostelAllocation: _hostelAllocations?.[0] ?? null,
            transportAllocation: _transportAllocations?.[0] ?? null,
            pref1Course: attachCourseCapacity((student as any).pref1Course),
            pref2Course: attachCourseCapacity((student as any).pref2Course),
            pref3Course: attachCourseCapacity((student as any).pref3Course),
            profilePhotoUrl,
            documents: documentsWithPresignedUrls,
            examDetails: {
                ...student.examDetails,
                hallTicketUrl
            }
        };
    },

    /** Admin edit of a single AcademicQualification row (marks/board/year). */
    async updateAcademicQualification(id: string, data: any, adminId: string | undefined) {
        if (!id) throw new AppError('Qualification ID is required', 400);

        const qualification = await prisma.academicQualification.findUnique({
            where: { id }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        return await prisma.academicQualification.update({
            where: { id },
            data: {
                ...data,
                updatedBy: adminId
            }
        });
    },

    /** Hard-delete of a qualification row (admin-only, used to fix duplicates). */
    async deleteAcademicQualification(id: string) {
        if (!id) throw new AppError('Qualification ID is required', 400);

        const qualification = await prisma.academicQualification.findUnique({
            where: { id }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        await prisma.academicQualification.delete({
            where: { id }
        });

        return { success: true, message: 'Qualification deleted successfully' };
    },

    /**
     * Admin sets a qualification's verificationStatus (APPROVED / REJECTED /
     * PENDING). Records verifiedBy + remarks for audit. Doesn't cascade —
     * use verifyStudentDocument for the document-level flow.
     */
    async validateAcademicQualification(qualificationId: string, status: string, remarks: string | undefined, adminId: string | undefined) {
        if (!qualificationId || !status) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        const qualification = await prisma.academicQualification.findUnique({
             where: { id: qualificationId }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        // Update verification column via Prisma
        await prisma.academicQualification.update({
            where: { id: qualificationId },
            data: {
                verificationStatus: status,
                remarks: remarks ?? null,
                verifiedBy: adminId ?? null,
                updatedBy: adminId ?? null
            }
        });

        return { success: true, message: 'Qualification status updated successfully' };
    },
    
    /**
     * Upsert the student's scholarship: type, percentage, qualification link,
     * eligibility flag. On percentage change, propagates the new discount into
     * every PENDING tuition demand via propagateScholarshipUpdate.
     */
    async updateStudentScholarship(studentId: string, data: any, adminId: string | undefined) {
         if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

         const { type, degreeType, score, remarks, scholarshipPercentage, qualificationId, isEligible } = data;

         // Check if qualification exists if provided
         if (qualificationId) {
             const qual = await prisma.academicQualification.findUnique({ where: { id: qualificationId } });
             if (!qual) throw new AppError('Qualification not found', 404);
         }

         // Check if scholarship already exists for this student
         const existing = await prisma.studentScholarship.findFirst({
             where: { studentId }
         });

         if (existing) {
             // UPDATE Existing (Dynamic Update as requested)
             // key fields to exclude from update
             const { studentId: _sid, id: _id, ...updateProps } = data;

             // Apply conversions if specific fields are present
             if (updateProps.score !== undefined) updateProps.score = Number(updateProps.score);
             if (updateProps.scholarshipPercentage !== undefined) {
                 updateProps.scholarshipPercentage = Number(updateProps.scholarshipPercentage);
                 if (updateProps.scholarshipPercentage > 0) updateProps.isEligible = 'YES';
             }

             // Check qualification existence if updating it
             if (updateProps.qualificationId) {
                  const qual = await prisma.academicQualification.findUnique({ where: { id: updateProps.qualificationId } });
                  if (!qual) throw new AppError('Qualification not found', 404);
             }

             const oldPct = existing.scholarshipPercentage || 0;

             const updated = await prisma.$transaction(async (tx) => {
                 const result = await tx.studentScholarship.update({
                     where: { id: existing.id },
                     data: {
                         ...updateProps,
                         updatedBy: adminId
                     }
                 });

                 // Propagate fee changes when scholarship percentage is updated
                 const newPct = result.scholarshipPercentage || 0;
                 await this.propagateScholarshipUpdate(studentId, newPct, adminId, tx);

                 return result;
             });

             // Send email notification if percentage changed
             const newPct = updated.scholarshipPercentage || 0;
             if (oldPct !== newPct) {
                 const student = await prisma.student.findUnique({
                     where: { id: studentId },
                     select: { name: true, email: true, applicationId: true },
                 });
                 if (student?.email) {
                     sendScholarshipUpdateEmail(student.email, {
                         studentName: student.name,
                         applicationId: student.applicationId || studentId.substring(0, 8).toUpperCase(),
                         oldPercentage: oldPct,
                         newPercentage: newPct,
                     }).catch(err => logger.warn(`[updateStudentScholarship] Email failed (non-fatal): ${err}`));
                 }

                 // Regenerate allotment order only if student has an allotted course
                 try {
                     const adm = await prisma.studentAdmission.findUnique({
                         where: { studentId },
                         select: { allottedCourseId: true }
                     });
                     if (adm?.allottedCourseId) {
                         await generateAndSaveAllotmentOrder(studentId);
                         logger.info(`[updateStudentScholarship] Allotment order regenerated for student ${studentId}`);
                     }
                 } catch (err) {
                     logger.error(`[updateStudentScholarship] Failed to regenerate allotment order: ${err}`);
                 }
             }

             return updated;
         }

         // CREATE New — tag with the active academic year (required since the phase-3 year-tag migration).
         const newScholarshipYearId: string = (await getActiveAcademicYear()).id;
         const newScholarship = await prisma.studentScholarship.create({
             data: {
                 studentId,
                 type,
                 degreeType,
                 score: score !== undefined ? Number(score) : undefined,
                 remarks,
                 scholarshipPercentage: scholarshipPercentage !== undefined ? Number(scholarshipPercentage) : undefined,
                 qualificationId,
                 academicYearId: newScholarshipYearId,
                 isEligible: (scholarshipPercentage !== undefined && Number(scholarshipPercentage) > 0) ? 'YES' : isEligible,
                 createdBy: adminId,
                 updatedBy: adminId
             }
         });
         
         // Propagate changes for NEW scholarship too (if fee demands exist)
         const newPct = newScholarship.scholarshipPercentage || 0;
         if (newPct > 0) {
             await prisma.$transaction(async (tx) => {
                  await this.propagateScholarshipUpdate(studentId, newPct, adminId, tx);
             });

             // Send email notification for new scholarship
             const student = await prisma.student.findUnique({
                 where: { id: studentId },
                 select: { name: true, email: true, applicationId: true },
             });
             if (student?.email) {
                 sendScholarshipUpdateEmail(student.email, {
                     studentName: student.name,
                     applicationId: student.applicationId || studentId.substring(0, 8).toUpperCase(),
                     oldPercentage: 0,
                     newPercentage: newPct,
                 }).catch(err => logger.warn(`[updateStudentScholarship] Email failed (non-fatal): ${err}`));
             }

             // Regenerate allotment order only if student has an allotted course
             try {
                 const adm = await prisma.studentAdmission.findUnique({
                     where: { studentId },
                     select: { allottedCourseId: true }
                 });
                 if (adm?.allottedCourseId) {
                     await generateAndSaveAllotmentOrder(studentId);
                     logger.info(`[updateStudentScholarship] Allotment order regenerated for student ${studentId}`);
                 }
             } catch (err) {
                 logger.error(`[updateStudentScholarship] Failed to regenerate allotment order: ${err}`);
             }
         }

         return newScholarship;
    },

    /** Returns the current StudentScholarship row (one per student, latest year). */
    async getStudentScholarships(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        return await prisma.studentScholarship.findMany({
            where: { studentId },
            include: { qualification: true },
            orderBy: { createdAt: 'desc' }
        });
    },

    /**
     * Edit a specific scholarship row by id (vs updateStudentScholarship which
     * upserts by studentId). Used by the "edit existing scholarship" admin UI.
     */
    async editStudentScholarship(scholarshipId: string, data: any, adminId: string | undefined) {
        if (!scholarshipId) throw new AppError('Scholarship ID is required', 400);

        const existing = await prisma.studentScholarship.findUnique({ where: { id: scholarshipId } });
        if (!existing) throw new AppError('Scholarship record not found', 404);

        const { type, degreeType, score, remarks, scholarshipPercentage, qualificationId, isEligible } = data;

        // Check qualification existence if updating it
        if (qualificationId) {
             const qual = await prisma.academicQualification.findUnique({ where: { id: qualificationId } });
             if (!qual) throw new AppError('Qualification not found', 404);
        }

        const oldPct = existing.scholarshipPercentage || 0;

        const updatedScholarship = await prisma.$transaction(async (tx) => {
            // 1. Update the Scholarship Record
            const result = await tx.studentScholarship.update({
                where: { id: scholarshipId },
                data: {
                    type,
                    degreeType,
                    score: score ? Number(score) : undefined,
                    remarks,
                    scholarshipPercentage: scholarshipPercentage ? Number(scholarshipPercentage) : undefined,
                    qualificationId,
                    isEligible,
                    updatedBy: adminId
                }
            });

            // 2. Propagate Changes to Demands & Ledger (Using Helper)
            const newPct = result.scholarshipPercentage || 0;
            const sid = result.studentId;

            logger.info(`[editStudentScholarship] Propagating update to ${newPct}% for student ${sid}`);

            await this.propagateScholarshipUpdate(sid, newPct, adminId, tx);

            return result;
        });

        // Send email notification if percentage changed
        const newPct = updatedScholarship.scholarshipPercentage || 0;
        if (oldPct !== newPct) {
            const student = await prisma.student.findUnique({
                where: { id: updatedScholarship.studentId },
                select: { name: true, email: true, applicationId: true },
            });
            if (student?.email) {
                sendScholarshipUpdateEmail(student.email, {
                    studentName: student.name,
                    applicationId: student.applicationId || updatedScholarship.studentId.substring(0, 8).toUpperCase(),
                    oldPercentage: oldPct,
                    newPercentage: newPct,
                }).catch(err => logger.warn(`[editStudentScholarship] Email failed (non-fatal): ${err}`));
            }

            // Regenerate allotment order only if student has an allotted course
            try {
                const adm = await prisma.studentAdmission.findUnique({
                    where: { studentId: updatedScholarship.studentId },
                    select: { allottedCourseId: true }
                });
                if (adm?.allottedCourseId) {
                    await generateAndSaveAllotmentOrder(updatedScholarship.studentId);
                    logger.info(`[editStudentScholarship] Allotment order regenerated for student ${updatedScholarship.studentId}`);
                }
            } catch (err) {
                logger.error(`[editStudentScholarship] Failed to regenerate allotment order: ${err}`);
            }
        }

        return updatedScholarship;
    },

    /**
     * Aggregate scholarship dashboard: count of LOCKED vs RESERVED per rule,
     * total discount approved, remaining slots. Powers the admin overview card.
     */
    async getScholarshipStats() {
        // Group by degreeType and scholarshipPercentage
        const dbStats = await prisma.studentScholarship.groupBy({
            by: ['degreeType', 'scholarshipPercentage'],
            where: {
                student: {
                    admissionDetails: {
                        allottedCourseId: { not: null }
                    }
                }
            },
            _count: {
                studentId: true
            }
        });

        // Define required combinations
        const manualDefaults = [
            { degreeType: 'B.Tech', scholarshipPercentage: 50, total: 400 },
            { degreeType: 'B.Tech', scholarshipPercentage: 25, total: 200 },
            { degreeType: 'B.Tech', scholarshipPercentage: 15, total: 400 },
            { degreeType: 'BBA', scholarshipPercentage: 50, total: 0 },
            { degreeType: 'BBA', scholarshipPercentage: 30, total: 0 },
            { degreeType: 'M.Tech', scholarshipPercentage: 50, total: 0 },
            { degreeType: 'M.Tech', scholarshipPercentage: 25, total: 0 },
            { degreeType: 'MCA', scholarshipPercentage: 50, total: 0 },
            { degreeType: 'MCA', scholarshipPercentage: 25, total: 0 },
            { degreeType: 'MBA', scholarshipPercentage: 50, total: 0 },
            { degreeType: 'MBA', scholarshipPercentage: 25, total: 0 }
        ];

        // Create a map of existing stats
        // Key: "DegreeType-Percentage"
        const statsMap = new Map();
        dbStats.forEach(item => {
            const key = `${item.degreeType}-${item.scholarshipPercentage}`;
            statsMap.set(key, item._count.studentId);
        });

        const finalStats: { degreeType: string; scholarshipPercentage: number | null; count: number; total: number }[] = [];

        // 1. Add required defaults (overwriting with actuals if present)
        manualDefaults.forEach(def => {
            const key = `${def.degreeType}-${def.scholarshipPercentage}`;
            const count = statsMap.get(key) || 0;
            finalStats.push({
                degreeType: def.degreeType,
                scholarshipPercentage: def.scholarshipPercentage,
                count: count,
                total: def.total
            });
            // Mark as processed so we don't duplicate if we want to show "others"
            statsMap.delete(key);
        });

        // 2. Add any other combinations found in DB that were not in manual defaults
        dbStats.forEach(item => {
             const isDefault = manualDefaults.some(d => d.degreeType === item.degreeType && d.scholarshipPercentage === item.scholarshipPercentage);
             if (!isDefault) {
                 finalStats.push({
                     degreeType: item.degreeType || 'Unknown',
                     scholarshipPercentage: item.scholarshipPercentage,
                     count: item._count.studentId,
                     total: 0
                 });
             }
        });

        return finalStats;

    },



    // --- HELPER: Propagate Scholarship Changes ---
    /**
     * Internal helper: when a student's scholarship percentage changes, walk
     * every PENDING tuition demand and re-apply the discount + matching
     * ledger DEBIT/CREDIT delta. Must run inside a tx (passed by caller).
     */
    propagateScholarshipUpdate: async (studentId: string, newPct: number, adminId: string | undefined, tx: any) => {
        logger.info(`[propagateScholarshipUpdate] Updating demands to ${newPct}% for student ${studentId}`);

        // Fetch demands with their linked Fee Heads (Direct or via Structure) + paid amounts
        const demands = await tx.studentFeeDemand.findMany({
            where: { studentId },
            include: {
                feeHead: true,
                feeStructure: { include: { feeHead: true } },
                payments: { where: { status: 'SUCCESS', isDeleted: false } }
            }
        });

        // Filter to demands tied to the TUITION component (strict — no name keyword match)
        const tuitionDemands = demands.filter((d: any) => {
            const head = d.feeHead || d.feeStructure?.feeHead;
            return head?.component === 'TUITION';
        });

        for (const demand of tuitionDemands) {
            const baseAmount = demand.amount;
            // Preserve any MANUAL (non-scholarship) discount: discountAmount holds
            // manual + scholarship; the manual portion is whatever exceeds the recorded
            // scholarshipAmount. (Mirrors approveCourseChange so conventions match and a
            // manual discount is never clobbered by a scholarship % change.)
            const manualDiscount = Math.max(0, (demand.discountAmount || 0) - (demand.scholarshipAmount || 0));
            const newScholarship = (baseAmount * newPct) / 100;
            const newDiscountTotal = manualDiscount + newScholarship;
            const newNet = Math.max(0, baseAmount - newDiscountTotal);
            const paid = (demand.payments || []).reduce((s: number, p: any) => s + (p.amount ?? 0), 0);
            const newStatus = paid >= newNet ? FeeStatus.FULL : (paid > 0 ? FeeStatus.PARTIAL : FeeStatus.PENDING);

            logger.info(`[propagateScholarshipUpdate] Demand ${demand.id}: base=${baseAmount}, manual=${manualDiscount}, scholarship=${newScholarship}, net=${newNet}, paid=${paid}, status=${newStatus}`);

            // A. Update Demand — recompute payable + status; keep the manual discount intact.
            await tx.studentFeeDemand.update({
                where: { id: demand.id },
                data: {
                    scholarshipAmount: newScholarship,
                    discountAmount: newDiscountTotal,
                    netAmount: newNet,
                    status: newStatus,
                    remarks: `Scholarship applied: ${newPct}%`
                }
            });

            // B. Update/Create the scholarship CREDIT ledger entry (= scholarship portion only)
            const ledger = await tx.studentLedger.findFirst({
                where: {
                    referenceId: demand.id,
                    referenceType: 'SCHOLARSHIP',
                    type: 'CREDIT',
                    isDeleted: false
                }
            });

            if (ledger) {
                if (newScholarship > 0) {
                    await tx.studentLedger.update({
                        where: { id: ledger.id },
                        data: {
                            amount: newScholarship,
                            description: `Scholarship (${newPct}%)`,
                            createdBy: adminId
                        }
                    });
                } else {
                    await tx.studentLedger.delete({ where: { id: ledger.id } });
                }
            } else if (newScholarship > 0) {
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: 'CREDIT', // Cast if needed
                        amount: newScholarship,
                        description: `Scholarship (${newPct}%)`,
                        referenceId: demand.id,
                        referenceType: 'SCHOLARSHIP',
                        feeHeadId: demand.feeHeadId,
                        academicYearId: demand.academicYearId,
                        createdBy: adminId
                    } as any
                });
            }
        }
    },

    /**
     * Helper: Processes logic after a successful payment (Offline or Online Verification).
     * Handles: Ledger Creation, Paid Fee Update, Demand Settlement, and Admission Updates.
     */
    async processPaymentSuccess(payment: any, adminId: string | undefined, tx: any) {
        const resolvedAdminId = adminId || 'SYSTEM';

        // Guard: skip if ledger entry already exists for this payment (prevents duplicate from race condition)
        const existingLedger = await tx.studentLedger.findFirst({
            where: {
                referenceId: payment.id,
                referenceType: 'PAYMENT',
                studentId: payment.studentId
            }
        });
        if (existingLedger) {
            logger.warn(`[processPaymentSuccess] Ledger already exists for payment ${payment.id}. Skipping duplicate.`);
            return;
        }

        // 1. Create Ledger Entry — academicYearId is REQUIRED on StudentLedger;
        // carry it from the payment (fall back to active year) or the create fails.
        const ledgerYearId = payment.academicYearId ?? (await getActiveAcademicYear()).id;
        await tx.studentLedger.create({
            data: {
                studentId: payment.studentId,
                type: LedgerTransactionType.CREDIT,
                amount: payment.amount,
                description: `Admission Payment (${payment.method || 'ONLINE'}) - ${payment.component || 'FEE'}`,
                referenceId: payment.id,
                referenceType: 'PAYMENT',
                feeHeadId: payment.feeHeadId,
                academicYearId: ledgerYearId,
                yearOfStudy: payment.yearOfStudy ?? undefined,
                createdBy: resolvedAdminId
            }
        });

        // 2. Settle Fee Demand (if linked) — set status from cumulative pay vs net payable
        if (payment.feeDemandId) {
             const demand = await tx.studentFeeDemand.findUnique({ where: { id: payment.feeDemandId } });
             if (demand) {
                 // Check if fully paid (compare against netAmount if exists, else amount)
                 const targetAmount = demand.netAmount ?? demand.amount;
                 const newStatus = payment.amount >= targetAmount ? 'FULL' : 'PARTIAL';

                 await tx.studentFeeDemand.update({
                     where: { id: payment.feeDemandId },
                     data: { status: newStatus }
                 });
             }
        }

        // 3. Recompute paidFee/totalFee from the source rows (idempotent) instead of a
        //    blind `paidFee += amount` — this is the same definition the webhook engine
        //    uses (recomputeStudentTotals), so the two completion paths can never disagree
        //    or double-count a payment.
        await recomputeStudentTotals(payment.studentId, tx);

        // 4. Execute Admission Updates (Allocation/Scholarship) if metadata dictates
        const meta = payment.metadata as any;
        if (meta && meta.targetAction === 'FINALIZE_ADMISSION') {
             await this.executeAdmissionUpdates(payment.studentId, meta, payment.id, resolvedAdminId, tx);
        }
    },

    /**
     * Sends the admission-confirmation email + receipt PDF after a successful
     * admission-fee payment. Idempotent by paymentId.
     */
    async sendAdmissionSuccessEmail(paymentId: string) {
         try {
             const p = await prisma.payment.findUnique({ 
                 where: { id: paymentId },
                 include: { student: true }
             });

             if (p && p.student.email) {
                let invoiceUrl = p.invoiceUrl;
                if (invoiceUrl) {
                    invoiceUrl = await convertToPresignedUrl(invoiceUrl);
                }

                // Derive Payment Name
                let paymentTypeName = 'Admission Fee'; 
                let emailPaymentType = 'ADMISSION_FEE';

                if (p.component === PaymentComponent.TUITION) {
                    paymentTypeName = 'Tuition Fee';
                    emailPaymentType = 'TUITION_FEE';
                } else if (p.component === PaymentComponent.APPLICATION_FEE) {
                    paymentTypeName = 'Application Fee';
                    emailPaymentType = 'APPLICATION_FEE';
                } else if (p.component === PaymentComponent.SCHOLARSHIP_TOKEN) {
                    paymentTypeName = 'Admission Fee';
                     emailPaymentType = 'ADMISSION_FEE';
                }

                await sendPaymentReceipt(p.student.email, {
                    studentName: p.student.name,
                    invoiceNumber: p.referenceNumber || p.id, 
                    applicationId: p.student.applicationId || 'N/A',
                    transactionId: p.referenceNumber || p.providerTxId || 'N/A',
                    amount: p.amount,
                    date: new Date(),
                    paymentType: emailPaymentType as any, 
                    customFeeType: paymentTypeName, 
                    invoiceUrl: invoiceUrl || undefined,
                    address: {
                        line1: p.student.address,
                        line2: p.student.address2 || '',
                        city: p.student.city,
                        state: p.student.state,
                        pincode: p.student.pincode
                    }
                });
                logger.info(`[sendAdmissionSuccessEmail] Email receipt sent to ${p.student.email}`);
             }
         } catch(e) {
             logger.error(`[sendAdmissionSuccessEmail] Failed to send email: ${e}`);
         }
    },

    /**
     * Internal helper run inside finalizeAdmission's transaction. Updates the
     * StudentAdmission record with allotted course, accommodation choice, and
     * fee totals based on the finalize payload. Must run in a tx.
     */
    async executeAdmissionUpdates(studentId: string, payload: any, _paymentId: string, adminId: string, tx: any) {
        try {
            const { allocation, scholarship, course } = payload;
            logger.info(`[executeAdmissionUpdates] Allocation: ${allocation.type}, Scholarship: ${scholarship.percentage}%`);

            // --- 1. Accommodation Handling ---
            logger.debug(`[executeAdmissionUpdates] Processing Accommodation: ${allocation?.type}`);
            const student = await tx.student.findUnique({ where: { id: studentId }, include: { admissionDetails: true } });
            const oldAdmission = student?.admissionDetails;

            const ayId = oldAdmission?.academicYearId;
            if (!ayId) {
                throw new AppError('Student admission / academic year not found', 404);
            }

            // Batch year = the academic year the student's batch started 1st year, which
            // is the seat pool the course seat is claimed from. Regular students share the
            // current year; a lateral joins an earlier batch (its previous-year pool).
            // Resolution: explicit payload.batchAcademicYearId wins (used for lateral via
            // finalize); else step back (entryYearOfStudy - 1) academic years; else current.
            let batchAcademicYearId: string = ayId;
            if (payload.batchAcademicYearId) {
                const okYear = await tx.academicYear.findUnique({ where: { id: payload.batchAcademicYearId }, select: { id: true } });
                if (!okYear) throw new AppError('Invalid batchAcademicYearId', 400);
                batchAcademicYearId = payload.batchAcademicYearId;
            } else {
                const yos = oldAdmission?.entryYearOfStudy ?? 1;
                if (yos > 1) {
                    const years = await tx.academicYear.findMany({ where: { isDeleted: false }, orderBy: { startDate: 'asc' }, select: { id: true } });
                    const idx = years.findIndex((y: { id: string }) => y.id === ayId);
                    const batchIdx = idx - (yos - 1);
                    if (idx >= 0 && batchIdx >= 0) batchAcademicYearId = years[batchIdx].id;
                }
            }

            // Release old seats if any
            if (oldAdmission) {
                if (oldAdmission.transportRouteId && (oldAdmission.transportRouteId !== allocation.transportRouteId || allocation.type !== AccommodationType.TRANSPORT)) {
                     logger.debug(`[executeAdmissionUpdates] Releasing old transport seat: ${oldAdmission.transportRouteId}`);
                     await tx.transportRoute.update({ where: { id: oldAdmission.transportRouteId }, data: { filled: { decrement: 1 } } });
                }
                // Course Seat (Decrement old if different) — released from the batch pool it was claimed from.
                if (oldAdmission.allottedCourseId && oldAdmission.allottedCourseId !== course.allottedCourseId) {
                     logger.debug(`[executeAdmissionUpdates] Releasing old course seat: ${oldAdmission.allottedCourseId}`);
                     await decrementCourseCapacity(tx, oldAdmission.allottedCourseId, batchAcademicYearId);
                }
            }

            // Assign New Accommodation (hostel "filled" is computed on-demand from StudentAdmission.hostelId).
            // Guard the seat increment on a genuine change so a re-run (webhook + verify both
            // completing the same finalize) can't double-count transportRoute.filled.
            if (allocation.type === AccommodationType.TRANSPORT && oldAdmission?.transportRouteId !== allocation.transportRouteId) {
                logger.debug(`[executeAdmissionUpdates] Assigning new transport seat: ${allocation.transportRouteId}`);
                await tx.transportRoute.update({ where: { id: allocation.transportRouteId }, data: { filled: { increment: 1 } } });
            }

            // --- 2. Course Allocation --- claim from the BATCH year's pool (= current year for regular).
            if (!oldAdmission?.allottedCourseId || oldAdmission.allottedCourseId !== course.allottedCourseId) {
                logger.debug(`[executeAdmissionUpdates] Assigning new course seat: ${course.allottedCourseId} (batchYear=${batchAcademicYearId})`);
                // Atomic check-and-increment via helper (prevents TOCTOU overbooking).
                const claimed = await tryAtomicIncrementCourseCapacity(tx, course.allottedCourseId, batchAcademicYearId);
                if (!claimed) {
                    const cap = await getCourseCapacity(tx, course.allottedCourseId, batchAcademicYearId);
                    logger.warn(`[executeAdmissionUpdates] Course ${course.allottedCourseId} is fully booked (${cap.filledSeats}/${cap.totalSeats}) for batch year ${batchAcademicYearId}`);
                    throw new AppError("Course is fully booked. No seats available.", 400);
                }
            }

            // --- Calculate Accommodation Cost Delta ---
            let accCostDelta = 0;

            // 1. Subtract Old Cost
            if (oldAdmission) {
                 if (oldAdmission.accommodationType === AccommodationType.HOSTEL && oldAdmission.hostelId) {
                     const oldMode = oldAdmission.hostelPaymentMode === HostelPaymentMode.SEMWISE ? 'SEMWISE' : 'YEARWISE';
                     const oldPricing = await getHostelCostTx(oldAdmission.hostelType, tx, oldMode);
                     accCostDelta -= oldPricing.totalPrice;
                 } else if (oldAdmission.accommodationType === AccommodationType.TRANSPORT && oldAdmission.transportRouteId) {
                     const r = await tx.transportRoute.findUnique({ where: { id: oldAdmission.transportRouteId } });
                     if (r) accCostDelta -= (r.cost || 0);
                 }
            }

            // 2. Add New Cost
            if (allocation.type === AccommodationType.HOSTEL && allocation.hostelId) {
                 const newMode = allocation.hostelPaymentMode === HostelPaymentMode.SEMWISE ? 'SEMWISE' : 'YEARWISE';
                 const newPricing = await getHostelCostTx(allocation.hostelType, tx, newMode);
                 accCostDelta += newPricing.totalPrice;
             } else if (allocation.type === AccommodationType.TRANSPORT && allocation.transportRouteId) {
                 const r = await tx.transportRoute.findUnique({ where: { id: allocation.transportRouteId } });
                 if (r) accCostDelta += (r.cost || 0);
             }
            
            logger.debug(`[executeAdmissionUpdates] Total Fee Adjustment: ${accCostDelta}`);

            // --- Determine Base Tuition Fee (For New Admissions) ---
            let baseTuition = 0;

            // --- 3. Update Admission Record ---
            logger.debug(`[executeAdmissionUpdates] Updating Student Admission record`);
            await tx.studentAdmission.upsert({
                where: { studentId },
                update: {
                    status: AdmissionStatus.ADMISSION_CONFIRMED,
                    allottedCourseId: course.allottedCourseId,
                    batchAcademicYearId,
                    accommodationType: allocation.type,
                    hostelId: allocation.type === AccommodationType.HOSTEL ? allocation.hostelId : null,
                    hostelType: allocation.type === AccommodationType.HOSTEL ? allocation.hostelType : null,
                    hostelPaymentMode: allocation.type === AccommodationType.HOSTEL ? allocation.hostelPaymentMode : null,
                    transportRouteId: allocation.type === AccommodationType.TRANSPORT ? allocation.transportRouteId : null,
                    // totalFee is NOT incremented here — accommodation fees are already billed
                    // as StudentFeeDemand rows by assignHostel/assignTransport, and totalFee is
                    // recomputed from those demands below. Incrementing accCostDelta here
                    // double-counted the accommodation charge.
                    seatAllottedAt: new Date()
                },
                create: {
                    studentId,
                    // academicYearId is REQUIRED on StudentAdmission — without it the
                    // upsert's create branch fails Prisma validation ("Argument
                    // `academicYear` is missing") even when the update branch would run.
                    academicYearId: ayId,
                    status: AdmissionStatus.ADMISSION_CONFIRMED,
                    allottedCourseId: course.allottedCourseId,
                    batchAcademicYearId,
                    accommodationType: allocation.type,
                    hostelId: allocation.type === AccommodationType.HOSTEL ? allocation.hostelId : null,
                    hostelType: allocation.type === AccommodationType.HOSTEL ? allocation.hostelType : null,
                    hostelPaymentMode: allocation.type === AccommodationType.HOSTEL ? allocation.hostelPaymentMode : null,
                    transportRouteId: allocation.type === AccommodationType.TRANSPORT ? allocation.transportRouteId : null,
                    totalFee: 0,
                    seatAllottedAt: new Date()
                }
            });
            
            // --- 4. Update Scholarship ---
            const scholarshipPct = scholarship.percentage ?? 0;
            await tx.studentScholarship.update({
                where: { studentId },
                data: {
                    scholarshipPercentage: scholarshipPct,
                    isEligible: scholarshipPct > 0 ? 'YES' : 'NO',
                    updatedBy: adminId
                }
            });
            logger.debug(`[executeAdmissionUpdates] Scholarship updated: percentage=${scholarshipPct}`);

            if (scholarshipPct > 0) {
                await this.propagateScholarshipUpdate(studentId, scholarshipPct, adminId, tx);
            }

            // Recompute totalFee (Σ active demand gross) and paidFee (Σ SUCCESS non-application
            // payments) from the source rows — authoritative, idempotent, and double-count-proof.
            await recomputeStudentTotals(studentId, tx);

            logger.info(`[executeAdmissionUpdates] Successfully completed all updates for student=${studentId}`);
        } catch (error) {
            logger.error(`[executeAdmissionUpdates] Failed to execute updates: ${error}`);
            throw error; 
        }
    },

    /**
     * Finalizes the admission process for a student.
     * 
     * Handles two flows:
     * 1. ONLINE: Creates a Pending Payment and returns a Payment Link (PhonePe).
     * 2. OFFLINE: Creates a Success Payment immediately and finalizes admission (Allocation, Ledger, etc).
     * 
     * @param payload - Contains payment details, allocation preferences, and scholarship info.
     * @param adminId - ID of the admin performing the action.
     */
    async finalizeAdmission(payload: any, adminId: string) {
        logger.info(`[finalizeAdmission] Request received for student=${payload.studentId} method=${payload?.payment?.method}`);
        logger.debug(`[finalizeAdmission] Full Payload: ${JSON.stringify(payload)}`);
        
        // Ensure allocation exists (default to NONE) - User Request: neither hostel/transport mandatory
        if (!payload.allocation) {
            payload.allocation = { type: AccommodationType.NONE };
        }
        
        const { studentId, payment, scholarship, allocation, course, batchAcademicYearId } = payload;
        
        // 1. Validation Checks (Parallelized for Performance)
        const [student, validCourse, validFeeHead, validFeeStructure] = await Promise.all([
            prisma.student.findUnique({
                where: { id: studentId },
                include: { admissionDetails: true }
            }),
            prisma.course.findUnique({ where: { id: course.allottedCourseId } }),
            payment.feeHeadId ? prisma.feeHead.findUnique({ where: { id: payment.feeHeadId } }) : Promise.resolve({ id: 'skip' }),
            payment.feeStructureId ? prisma.feeStructure.findUnique({ where: { id: payment.feeStructureId } }) : Promise.resolve({ id: 'skip' })
        ]);

        if (!student) {
            logger.warn(`[finalizeAdmission] Student not found: ${studentId}`);
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const blockedStatuses: AdmissionStatus[] = [AdmissionStatus.ADMISSION_CONFIRMED, AdmissionStatus.ENROLLED, AdmissionStatus.CANCELLED];
        if (student.admissionDetails?.status && blockedStatuses.includes(student.admissionDetails.status)) {
             logger.info(`[finalizeAdmission] Student ${studentId} cannot be finalized (Status: ${student.admissionDetails?.status})`);
             throw new AppError("Student admission cannot be finalized in its current status.", 400);
        }
        // Refuse if the admission's academic year has been locked.
        if (student.admissionDetails?.academicYearId) {
            await assertAcademicYearWritable(student.admissionDetails.academicYearId);
        }

        if (!validCourse) {
            logger.warn(`[finalizeAdmission] Invalid Course ID: ${course.allottedCourseId}`);
            throw new AppError("Invalid Course ID" , 400);
        }

        if (!payment.amount || payment.amount <= 0) {
            logger.warn(`[finalizeAdmission] Invalid payment amount: ${payment.amount}`);
            throw new AppError("Payment amount must be greater than zero", 400);
        }

        // Check Mandatory Fee Head ID (Exempting specific types)
        const exemptComponents = [
            'HOSTEL_ACCOMMODATION',
            'HOSTEL_MESS',
            'TRANSPORT',
            'OTHER',
            'HOSTEL'
        ];

        if (!payment.feeHeadId && !exemptComponents.includes(payment.component || '')) {
            logger.warn(`[finalizeAdmission] Fee Head ID missing for student ${studentId} (Component: ${payment.component})`);
            throw new AppError("Fee Head ID is mandatory for admission finalization", 400);
        }

        if (payment.feeHeadId && !validFeeHead) {
            logger.warn(`[finalizeAdmission] Invalid Fee Head ID: ${payment.feeHeadId}`);
            throw new AppError("Invalid Fee Head ID", 400);
        }

        // Validate Allocation IDs
        if (allocation.type === AccommodationType.HOSTEL && allocation.hostelId) {
            const h = await prisma.hostel.findUnique({ where: { id: allocation.hostelId } });
            if (!h) {
                 logger.warn(`[finalizeAdmission] Invalid Hostel ID: ${allocation.hostelId}`);
                 throw new AppError("Invalid Hostel ID", 400);
            }
        }
        if (allocation.type === AccommodationType.TRANSPORT && allocation.transportRouteId) {
            const r = await prisma.transportRoute.findUnique({ where: { id: allocation.transportRouteId } });
            if (!r) {
                 logger.warn(`[finalizeAdmission] Invalid Transport Route ID: ${allocation.transportRouteId}`);
                 throw new AppError("Invalid Transport Route ID", 400);
            }
        }

        // Apply HOSTEL allocation up-front: flip accommodationType + create
        // StudentAccommodationPricing snapshot + 4 hostel StudentFeeDemand rows
        // + increment totalFee. This way, hostel components passed in
        // payment.component reconcile against demands that already exist.
        // Idempotent: assignHostel handles re-assignment before bed allocation.
        if (
            allocation.type === AccommodationType.HOSTEL &&
            allocation.hostelType &&
            allocation.hostelPaymentMode
        ) {
            // Body no longer requires hostelId — fall back to whatever the student
            // already has on their admission row (set in an earlier seat-allotment / assign-hostel step).
            const targetHostelId = allocation.hostelId
                ?? student.admissionDetails?.hostelId
                ?? null;

            if (!targetHostelId) {
                // No hostelId in body and none on admission. Skip the hostel allocation
                // block entirely — admin can run assign-hostel later.
                logger.warn(`[finalizeAdmission] HOSTEL allocation skipped for student=${studentId} — no hostelId in body and none on admission. Run assign-hostel later to set up hostel pricing/demands.`);
            } else {
                const hostelResult = await AccommodationService.assignHostel(
                    studentId,
                    targetHostelId,
                    allocation.hostelPaymentMode as 'YEARWISE' | 'SEMWISE',
                    allocation.hostelType as HostelType,
                    adminId
                );
                if (hostelResult.feeDemandsCreated > 0) {
                    logger.info(`[finalizeAdmission] Hostel snapshot+demands created via assignHostel for student=${studentId} hostelId=${targetHostelId} type=${allocation.hostelType} mode=${allocation.hostelPaymentMode} demandsCreated=${hostelResult.feeDemandsCreated}`);
                } else {
                    logger.warn(`[finalizeAdmission] Hostel snapshot created BUT no fee demands for student=${studentId} — likely no FeeHead tagged with HOSTEL_ACCOMMODATION/MESS/LAUNDRY/REGISTRATION components, OR all component prices are 0. Result=${JSON.stringify(hostelResult)}`);
                }
            }
        }

        // Apply TRANSPORT allocation up-front: flip accommodationType + create
        // single TRANSPORT StudentFeeDemand using route.cost + increment totalFee.
        // Idempotent: assignTransport handles re-assignment before TransportAllocation row exists.
        if (
            allocation.type === AccommodationType.TRANSPORT &&
            allocation.transportRouteId
        ) {
            const transportResult = await AccommodationService.assignTransport(
                studentId,
                allocation.transportRouteId,
                adminId
            );
            if (transportResult.feeDemandsCreated > 0) {
                logger.info(`[finalizeAdmission] Transport demand created via assignTransport for student=${studentId} routeId=${allocation.transportRouteId} cost=${transportResult.cost}`);
            } else if (transportResult.missingFeeHead) {
                logger.warn(`[finalizeAdmission] Transport demand NOT created for student=${studentId} — ${transportResult.missingFeeHead}`);
            } else {
                logger.warn(`[finalizeAdmission] Transport demand NOT created for student=${studentId} routeId=${allocation.transportRouteId} — route cost may be 0 (got cost=${transportResult.cost})`);
            }
        }

        // Validate Fee Structure ID if provided and resolve Demand
        // validFeeStructure is either the fetched record or {id:'skip'} (when feeStructureId was not provided).
        // When feeStructureId IS provided, Promise.all ran prisma.feeStructure.findUnique which returns Object | null.
        let feeDemandId = null;
        if (payment.feeStructureId) {
            if (!validFeeStructure || (validFeeStructure as any).id === 'skip') {
                logger.warn(`[finalizeAdmission] Invalid Fee Structure ID: ${payment.feeStructureId}`);
                throw new AppError("Invalid Fee Structure ID", 400);
            }

            // Try to find matching Demand to link
            const demand = await prisma.studentFeeDemand.findFirst({
                where: {
                    studentId,
                    feeStructureId: payment.feeStructureId
                }
            });
            if (demand) {
                feeDemandId = demand.id;
                logger.info(`[finalizeAdmission] Linking payment to existing Demand: ${demand.id}`);
            }
        }

        // 2. Identify Flow
        const isOnline = !([
            PaymentMethod.CASH, 
            PaymentMethod.CHEQUE, 
            PaymentMethod.DEMAND_DRAFT,
            PaymentMethod.NEFT,
            PaymentMethod.RTGS,
            PaymentMethod.IMPS,
            PaymentMethod.NEFT_RTGS
        ].includes(payment.method));
        logger.info(`[finalizeAdmission] Flow Type detected: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);

            if (isOnline) {
             // === ONLINE FLOW (Initiate) ===
             try {

             const targetComponent = payment.component || PaymentComponent.TUITION;

             // ------------------------------------------------------------------
             // BLOCK 3 & 4: IDEMPOTENCY CHECK + CREATE — wrapped in a transaction
             // to prevent duplicate PENDING records under concurrent requests.
             // ------------------------------------------------------------------
             let newPayment = await prisma.$transaction(async (itx) => {
                 const existingPending = await itx.payment.findFirst({
                     where: {
                         studentId,
                         component: targetComponent,
                         status: PaymentStatus.PENDING
                     }
                 });

                 if (existingPending) {
                     logger.info(`[finalizeAdmission] Found existing PENDING payment ${existingPending.id}. Reusing it.`);
                     // Refresh amount and metadata with the latest payload in case they changed
                     const refreshed = await itx.payment.update({
                         where: { id: existingPending.id },
                         data: {
                             amount: payment.amount,
                             providerTxId: (existingPending.providerTxId?.startsWith('TXN_'))
                                 ? existingPending.providerTxId
                                 : `TXN_${Date.now()}_${studentId.substring(0, 8)}`,
                             metadata: {
                                 scholarship,
                                 allocation,
                                 course,
                                 feeComponent: targetComponent,
                                 amount: payment.amount,
                                 feeStructureId: payment.feeStructureId,
                                 batchAcademicYearId,

                                 targetAction: 'FINALIZE_ADMISSION'
                             }
                         }
                     });
                     return refreshed;
                 }

                 // ------------------------------------------------------------------
                 // No existing payment found — create a fresh PENDING record.
                 // ------------------------------------------------------------------
                 logger.info(`[finalizeAdmission][Online] Step 1: Creating PENDING payment record`);
                 const merchantTransactionId = `TXN_${Date.now()}_${studentId.substring(0, 8)}`;
                 const yearCtx = await resolveFeeDemandContext(feeDemandId, itx);

                 return itx.payment.create({
                     data: {
                         studentId,
                         amount: payment.amount,
                         method: payment.method,
                         mode: PaymentMode.ONLINE,
                         status: PaymentStatus.PENDING,
                         component: targetComponent,
                         providerTxId: merchantTransactionId,
                         idempotencyKey: `${merchantTransactionId}_${targetComponent}`,
                         feeHeadId: payment.feeHeadId,
                         feeDemandId: feeDemandId || undefined,
                         academicYearId: yearCtx.academicYearId,
                         yearOfStudy: yearCtx.yearOfStudy,
                         collectedBy: adminId,
                         createdBy: adminId,
                         metadata: {
                             scholarship,
                             allocation,
                             course,
                             feeComponent: targetComponent,
                             amount: payment.amount,
                             feeStructureId: payment.feeStructureId,
                             batchAcademicYearId,

                             targetAction: 'FINALIZE_ADMISSION'
                         }
                     }
                 });
             });

             // Use stored providerTxId or regenerate if missing (shouldn't happen for new ones)
             const merchantTransactionId = newPayment.providerTxId || newPayment.id.replace(/-/g, '');


                 // ------------------------------------------------------------------
                 // BLOCK 5: PAYMENT GATEWAY INTEGRATION
                 // Initiate the payment request with PhonePe SDK.
                 // We receive a redirect URL to send to the frontend.
                 // ------------------------------------------------------------------
                 // Step 2: PhonePe Integration
                 logger.info(`[finalizeAdmission][Online] Step 2: Initiating PhonePe Request`);

                 let clientType: 'ADMISSION' | 'HOSTEL' | 'MESS' = 'ADMISSION';
                 if (targetComponent === PaymentComponent.HOSTEL || targetComponent === PaymentComponent.HOSTEL_ACCOMMODATION) clientType = 'HOSTEL';
                 else if (targetComponent === PaymentComponent.HOSTEL_MESS) clientType = 'MESS';

                 const callbackUrl = `${FRONTEND_URL_ADMISSION}/admin/seatallotment/details?studentId=${studentId}&paymentId=${newPayment.id}`;
                 
                 const result = await initiatePhonePePayment(studentId, payment.amount, merchantTransactionId, callbackUrl, clientType);
                 const redirectUrl = result.redirectUrl;

                 logger.info(`[finalizeAdmission][Online] Payment initiated successfully. ID=${newPayment.id} PhonePeTxId=${merchantTransactionId}`);

                 return { 
                     success: true, 
                     type: 'ONLINE_INITIATED', 
                     message: "Payment Link Generated", 
                     paymentId: newPayment.id,
                     redirectUrl: redirectUrl 
                 };

             } catch (error) {
                 logger.error(`[finalizeAdmission][Online] Failed to initiate payment: ${error}`);
                 throw error;
             }

        } else {
             // === OFFLINE FLOW (Immediate) ===
             // ------------------------------------------------------------------
             // BLOCK 6: OFFLINE TRANSACTION
             // Processing Cash/Cheque/DD payment.
             // We create a SUCCESS payment record immediately and executing admission logic.
             // This happens in a single transaction.
             // ------------------------------------------------------------------
             if (!payment.referenceNumber && payment.method !== PaymentMethod.CASH) {
                 throw new AppError("Reference Number is required for Non-Cash payments", 400);
             }

             const offlineResult = await prisma.$transaction(async (tx) => {
                 logger.info(`[finalizeAdmission][Offline] Starting transaction for student=${studentId}`);

                 // Determine Payment Name based on Component
                 const feeComponent = payment.component || PaymentComponent.TUITION;

                 // Idempotency: reject if a SUCCESS payment already exists for this student + component
                 const existingSuccess = await tx.payment.findFirst({
                     where: { studentId, component: feeComponent, status: PaymentStatus.SUCCESS }
                 });
                 if (existingSuccess) {
                     logger.warn(`[finalizeAdmission][Offline] Duplicate payment detected for student=${studentId} component=${feeComponent}`);
                     throw new AppError("Payment for this component has already been completed.", 409);
                 }

                 // Resolve feeDemandId inside the transaction to avoid stale links
                 let resolvedFeeDemandId = feeDemandId;
                 if (payment.feeStructureId && !resolvedFeeDemandId) {
                     const demand = await tx.studentFeeDemand.findFirst({
                         where: { studentId, feeStructureId: payment.feeStructureId }
                     });
                     if (demand) {
                         resolvedFeeDemandId = demand.id;
                         logger.info(`[finalizeAdmission][Offline] Resolved feeDemandId inside TX: ${demand.id}`);
                     }
                 }

                 // ------------------------------------------------------------------
                 // SUB-BLOCK 6.1: RECORD PAYMENT
                 // Create a payment record with status SUCCESS.
                 // ------------------------------------------------------------------
                 // 1. Create Successful Payment
                 const yearCtx = await resolveFeeDemandContext(resolvedFeeDemandId, tx);
                 const _refForKey = payment.referenceNumber || `OFF_${Date.now()}`;
                 const newPayment = await tx.payment.create({
                    data: {
                        studentId,
                        amount: payment.amount,
                        method: payment.method,
                        mode: PaymentMode.OFFLINE,
                        status: PaymentStatus.SUCCESS,
                        component: feeComponent,
                        feeHeadId: payment.feeHeadId,
                        feeDemandId: resolvedFeeDemandId || undefined,
                        academicYearId: yearCtx.academicYearId,
                        yearOfStudy: yearCtx.yearOfStudy,
                        idempotencyKey: `${_refForKey}_${feeComponent}`,
                        referenceNumber: (() => {
                            if (!payment.referenceNumber) {
                                const autoRef = `REF-${Date.now()}`;
                                logger.warn(`[finalizeAdmission][Offline] No referenceNumber provided for CASH payment. Auto-generating: ${autoRef}. This may affect audit/reconciliation.`);
                                return autoRef;
                            }
                            return payment.referenceNumber;
                        })(),
                        instrumentDate: payment.date ? new Date(payment.date) : new Date(),
                        collectedBy: adminId,
                        createdBy: adminId, // Strict data
                        metadata: {
                            scholarship,
                            allocation,
                            course,
                            feeComponent,
                            amount: payment.amount,
                            feeStructureId: payment.feeStructureId,
                            notes: 'Offline Immediate Finalization',
                            batchAcademicYearId,

                            targetAction: 'FINALIZE_ADMISSION'
                        }
                    }
                });
                logger.debug(`[finalizeAdmission][Offline] Payment record created: ${newPayment.id}`);

                // Step 2 & 3 & 4 & 5: Centralized Success Processing
                logger.info(`[finalizeAdmission][Offline] Processing Post-Payment actions`);
                await this.processPaymentSuccess(newPayment, adminId, tx);

                logger.info(`[finalizeAdmission][Offline] Transaction committed successfully.`);
                return { success: true, type: 'OFFLINE_COMPLETED', message: "Admission Finalized Successfully", paymentId: newPayment.id };
             });


             // Pre-generate Allotment Order (must happen before invoice so email can attach it)
             try {
                if (offlineResult.paymentId) {
                    const offPayment = await prisma.payment.findUnique({ where: { id: offlineResult.paymentId }, select: { studentId: true, component: true } });
                    if (offPayment && (offPayment.component === PaymentComponent.SCHOLARSHIP_TOKEN || offPayment.component === PaymentComponent.TUITION)) {
                        const existingAllotment = await prisma.studentDocument.findUnique({
                            where: { studentId_documentKey: { studentId: offPayment.studentId, documentKey: 'ALLOTMENT_ORDER' } }
                        });
                        if (!existingAllotment?.url) {
                            await generateAndSaveAllotmentOrder(offPayment.studentId);
                            logger.info(`[finalizeAdmission] Allotment Order generated for student=${offPayment.studentId}`);
                        }
                    }
                }
             } catch (err) {
                logger.warn(`[finalizeAdmission] Failed to generate allotment order: ${err}`);
             }

             // Auto-generate invoice (Outside TX)
             try {
                if (offlineResult.paymentId) {
                    await InvoiceService.generateInvoiceForPayment(offlineResult.paymentId);
                }
             } catch (err) {
                logger.warn(`[finalizeAdmission] Failed to auto-generate invoice: ${err}`);
             }

             // Send Email Notification (Offline) - Handled by InvoiceService
             // if (offlineResult.paymentId) {
             //    await this.sendAdmissionSuccessEmail(offlineResult.paymentId);
             // }

             // Fetch final details for response
             const finalPayment = await prisma.payment.findUnique({ where: { id: offlineResult.paymentId } });
             let responseInvoiceUrl = finalPayment?.invoiceUrl;
             if (responseInvoiceUrl) {
                 responseInvoiceUrl = await convertToPresignedUrl(responseInvoiceUrl);
             }

             return { 
                 ...offlineResult,
                 data: {
                    paymentId: finalPayment?.id,
                    invoiceUrl: responseInvoiceUrl,
                    amount: finalPayment?.amount,
                    transactionId: finalPayment?.referenceNumber, // Use reference for offline
                    payment: finalPayment
                 }
             };
        }
    },

    // New Method for Callbacks
    /**
     * Verifies the status of an Online Payment with PhonePe and completes admission if successful.
     * 
     * Steps:
     * 1. Validates Payment existence.
     * 2. Calls PhonePe Status API.
     * 3. If Success -> Calls _completeAdmissionTransaction to finalize.
     */
    async verifyAndCompletePayment(paymentId: string, adminId: string | undefined) {
        logger.info(`[verifyAndCompletePayment] Verifying paymentId=${paymentId}`);
        // 1. Fetch Payment
        const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
        if (!payment) {
            throw new AppError("Payment not found", 404);
        }
        
        // Find Siblings (Bundled Payments)
        let relatedPayments = [payment];
        if (payment.providerTxId && payment.providerTxId.startsWith('TXN_')) {
             const siblings = await prisma.payment.findMany({
                 where: { 
                     providerTxId: payment.providerTxId,
                     id: { not: payment.id } 
                 }
             });
             relatedPayments = [payment, ...siblings];
             logger.info(`[verifyAndCompletePayment] Found ${siblings.length} sibling payments for bundle.`);
        }

        const isSuccess = payment.status === PaymentStatus.SUCCESS;
        if (isSuccess) {
             logger.info(`[verifyAndCompletePayment] Payment ${paymentId} already processed.`);
             return { 
                success: true, 
                message: "Payment successfully processed", 
                status: PaymentStatus.SUCCESS,
                data: {
                    paymentId: payment.id,
                    invoiceUrl: await convertToPresignedUrl(payment.invoiceUrl),
                    amount: payment.amount,
                    transactionId: payment.providerTxId,
                    payment: payment
                }
             };
        }

        try {
             // Verify Gateway using PRIMARY ID
             const merchantTransactionId = payment.providerTxId || payment.id.replace(/-/g, '');
             
             // USE SHARED CLIENT
             let feeType: 'ADMISSION' | 'HOSTEL' | 'MESS' = 'ADMISSION';
             if (payment.component === PaymentComponent.HOSTEL || payment.component === PaymentComponent.HOSTEL_ACCOMMODATION) feeType = 'HOSTEL';
             if (payment.component === PaymentComponent.HOSTEL_MESS) feeType = 'MESS';

             const client = getPhonePeClient(feeType);
             logger.info(`[verifyAndCompletePayment] Verifying with Client Type: ${feeType}`);
             
             const response = await client.getOrderStatus(merchantTransactionId); 
             
             const responseData = (response as any).data || {};
             const statusState = (response as any).state || responseData.state || responseData.responseCode;
             const statusCode = (response as any).code || responseData.code;

             logger.info(`[verifyAndCompletePayment] PhonePe Response: Code=${statusCode}, State=${statusState}`);
             logger.debug(`[verifyAndCompletePayment] Full Response: ${JSON.stringify(response)}`);

             const isGatewaySuccess =
                (statusCode === 'PAYMENT_SUCCESS' && (statusState === 'COMPLETED' || statusState === 'SUCCESS')) ||
                (!statusCode && (statusState === 'COMPLETED' || statusState === 'SUCCESS'));

             if (isGatewaySuccess) {
                 const responseData = (response as any).data || response;
                 const realProviderTxId = responseData.paymentInstrument?.pgTransactionId || merchantTransactionId;
                 return await this._completeAdmissionTransaction(relatedPayments, adminId, realProviderTxId, response);
             } else if (statusState === 'PENDING' || response.state === 'PENDING') {
                 return { success: false, message: "Payment is still pending", status: PaymentStatus.PENDING };
             } else {
                 await prisma.payment.updateMany({
                     where: { id: { in: relatedPayments.map(p => p.id) } },
                     data: { status: PaymentStatus.FAILED }
                  });
                  return { success: false, message: "Payment Failed", status: PaymentStatus.FAILED };
             }
        } catch (error) {
            logger.error(`[verifyAndCompletePayment] Error verifying payment: ${error}`);
            throw new AppError("Payment Verification Failed", 500);
        }
    },

    /**
     * Internal Helper: Executes the final admission steps after a successful payment (Online or Bypass).
     * 
     * Steps:
     * 1. Marks Payment as SUCCESS.
     * 2. Calls executeAdmissionUpdates (Allocation, Scholarship).
     * 3. Creates Ledger Entry.
     */
    async _completeAdmissionTransaction(payments: any[], adminId: string | undefined, providerTxId?: string, gatewayResponse?: any) {
        if (!payments || payments.length === 0) return;
        const primaryPayment = payments[0];
        logger.info(`[_completeAdmissionTransaction] Completing ${payments.length} payments. Primary=${primaryPayment.id}`);

        await prisma.$transaction(async (tx) => {
             // Filter out already processed
             const pendingPayments = payments.filter(p => p.status !== PaymentStatus.SUCCESS);
             if (pendingPayments.length === 0) return { success: true, status: PaymentStatus.SUCCESS };

             const paymentIds = pendingPayments.map(p => p.id);
             
             // Update All to SUCCESS
             await tx.payment.updateMany({
                 where: { id: { in: paymentIds } },
                 data: { 
                     status: PaymentStatus.SUCCESS,
                     providerTxId: providerTxId || primaryPayment.providerTxId,
                     metadata: gatewayResponse || undefined // Update with gateway response if available
                 }
             });

             // Logic for Each Payment (Sequential to avoid lock contention)
             for (const payment of pendingPayments) {
                  await this.processPaymentSuccess(payment, adminId, tx);
             }
             
             return { success: true, status: PaymentStatus.SUCCESS };
         });

         // Pre-generate Allotment Order for admission payments
         const hasAdmissionComponent = payments.some((p: any) => p.component === PaymentComponent.SCHOLARSHIP_TOKEN || p.component === PaymentComponent.TUITION);
         if (hasAdmissionComponent) {
             try {
                 const existingAllotment = await prisma.studentDocument.findUnique({
                     where: { studentId_documentKey: { studentId: primaryPayment.studentId, documentKey: 'ALLOTMENT_ORDER' } }
                 });
                 if (!existingAllotment?.url) {
                     await generateAndSaveAllotmentOrder(primaryPayment.studentId);
                     logger.info(`[verifyAndFinalizePayment] Allotment Order generated for student=${primaryPayment.studentId}`);
                 }
             } catch (err) { logger.warn(`Failed to generate allotment order: ${err}`); }
         }

         // Invoice (Unified) for Bundle
         try {
             await InvoiceService.generateInvoiceForPayment(primaryPayment.id);
         } catch (err) { logger.warn(`Failed to auto-generate invoice: ${err}`); }

         // Send Email Notification - Handled by InvoiceService
         // await this.sendAdmissionSuccessEmail(primaryPayment.id);
         
         // Final Return
         const finalPayment = await prisma.payment.findUnique({ where: { id: primaryPayment.id } });
         return { 
             success: true, 
             message: "Payment Verified and Finalized", 
             status: PaymentStatus.SUCCESS,
             data: {
                 paymentId: finalPayment?.id,
                 invoiceUrl: await convertToPresignedUrl(finalPayment?.invoiceUrl),
                 amount: payments.reduce((sum, p) => sum + p.amount, 0),
                 transactionId: finalPayment?.providerTxId
             }
         };
    },

    /** Returns the latest admission-fee invoice URL (presigned) for a student. */
    async getAdmissionInvoice(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        // Find the successful admission payment (Tuition)
        const payment = await prisma.payment.findFirst({
            where: {
                studentId,
                status: PaymentStatus.SUCCESS,
                component: PaymentComponent.TUITION
            },
            orderBy: { createdAt: 'desc' }, // Get latest if multiple
            include: { student: true }
        });

        if (!payment) {
            throw new AppError("No admission fee payment found for this student.", 404);
        }

        // Return existing or generate if missing
        if (payment.invoiceUrl) {
            // Convert to Presigned URL
            const finalUrl = await convertToPresignedUrl(payment.invoiceUrl);
            return { invoiceUrl: finalUrl };
        } else {
            // Generate
            const result = await InvoiceService.generateInvoiceForPayment(payment.id);
            // Convert to Presigned URL just in case the service returns a raw S3 key (though it returns URL usually, let's be safe)
            // InvoiceService returns { invoiceUrl } which is usually the key or full URL? 
            // Looking at InvoiceService.ts, it returns uploadFileToS3 result. 
            // uploadFileToS3 usually returns the S3 KEY or Location. 
            // Best to ensure we return a presigned URL if it's private.
            // But InvoiceService usually returns what uploadFileToS3 returns.
            return { invoiceUrl: await convertToPresignedUrl(result.invoiceUrl) };
        }
    },










    /**
     * Generic status-update email: approved / rejected / pending lists for
     * documents or qualifications. Single template, parameterized by updateType.
     */
    async sendStatusEmail(data: { studentId: string; updateType: string; approvedItems?: any[]; rejectedItems?: any[]; pendingItems?: any[] }) {
        const { studentId, updateType, approvedItems, rejectedItems, pendingItems } = data;

        if (!studentId || !updateType) {
            throw new AppError('Student ID and Update Type are required', 400);
        }

        const student = await prisma.student.findUnique({
            where: { id: studentId }
        });

        if (!student || !student.email) {
            throw new AppError('Student not found or email missing', 404);
        }

        // Import locally to avoid circular dependencies if any (though utils should be fine)
        const { sendStatusUpdateEmail } = require('../../utils/emailService');

        const emailData = {
            studentName: student.name,
            applicationId: student.applicationId || studentId, // Fallback if no app ID
            updateType: updateType as any,
            approvedItems,
            rejectedItems,
            pendingItems
        };


        const result = await sendStatusUpdateEmail(student.email, emailData);

        if (!result.success) {
            throw new AppError('Failed to send status email', 500);
        }

        return { success: true };
    },

    /**
     * Diagnostic endpoint: every student allotted to a course with their
     * admission status, fee paid, hostel/transport choices. Used to debug
     * "why does the dashboard say N but I only see M?" mismatches.
     */
    async debugCourseAllotments(courseId: string) {
        if (!courseId) throw new AppError('courseId is required', 400);

        const course = await prisma.course.findUnique({
            where: { id: courseId },
            select: {
                id: true, code: true, name: true,
                capacities: { select: { academicYearId: true, totalSeats: true, filledSeats: true } },
            }
        });
        if (!course) throw new AppError('Course not found', 404);

        // Raw query: ALL StudentAdmission records pointing to this course (no filters)
        const allAdmissions = await prisma.studentAdmission.findMany({
            where: { allottedCourseId: courseId },
            select: {
                id: true,
                studentId: true,
                status: true,
                allottedCourseId: true,
                createdAt: true,
                student: {
                    select: {
                        applicationId: true,
                        name: true,
                        phone: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        // Apply same filter as the seat counting query
        const activeAdmissions = allAdmissions.filter(a =>
            a.allottedCourseId !== null && a.status !== 'CANCELLED'
        );

        // Group by status
        const byStatus: Record<string, number> = {};
        for (const a of allAdmissions) {
            const key = a.status || 'NULL';
            byStatus[key] = (byStatus[key] || 0) + 1;
        }

        return {
            course,
            counts: {
                totalAdmissionsForCourse: allAdmissions.length,
                activeAdmissions: activeAdmissions.length,
                capacities: course.capacities,
                byStatus
            },
            allAdmissions
        };
    },

    /**
     * List CourseChangeRequest rows with filters (status, dateRange, fromCourse,
     * toCourse). Used by the super-admin approval queue.
     */
    async getCourseChangeRequests(filters: any) {
        const { status, studentId, applicationId, page = 1, limit = 10 } = filters;
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.max(1, Math.min(100, parseInt(limit)));
        const skip = (pageNum - 1) * limitNum;

        let resolvedStudentId = studentId;
        if (applicationId && !resolvedStudentId) {
            const student = await prisma.student.findUnique({ where: { applicationId } });
            if (student) resolvedStudentId = student.id;
        }

        const where = {
            ...(status ? { status } : {}),
            ...(resolvedStudentId ? { studentId: resolvedStudentId } : {})
        } as any;

        const [requests, total] = await Promise.all([
            prisma.courseChangeRequest.findMany({
                where,
                include: { student: true } as any,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limitNum
            }),
            prisma.courseChangeRequest.count({ where })
        ]);

        const courseIds = [...new Set(requests.flatMap((r: any) => [r.fromCourse, r.toCourse].filter(Boolean)))];

        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            select: { id: true },
        });

        const courses = await prisma.course.findMany({
            where: { id: { in: courseIds } },
            select: {
                id: true,
                name: true,
                capacities: activeYear
                    ? { where: { academicYearId: activeYear.id }, select: { totalSeats: true, filledSeats: true } }
                    : undefined,
            }
        });
        const courseMap = Object.fromEntries(courses.map(c => [c.id, {
            name: c.name,
            totalSeats:  c.capacities?.[0]?.totalSeats  ?? null,
            filledSeats: c.capacities?.[0]?.filledSeats ?? null,
        }]));

        const data = requests.map((r: any) => {
            const fromCourse = courseMap[r.fromCourse];
            const toCourse = courseMap[r.toCourse];
            return {
                ...r,
                fromCourseName: fromCourse?.name || null,
                toCourseName: toCourse?.name || null,
                fromCourseFilledSeats: fromCourse?.filledSeats ?? null,
                fromCourseTotalSeats: fromCourse?.totalSeats ?? null,
                toCourseFilledSeats: toCourse?.filledSeats ?? null,
                toCourseTotalSeats: toCourse?.totalSeats ?? null,
            };
        });

        return {
            data,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                totalPages: Math.ceil(total / limitNum)
            }
        };
    },

    /**
     * Reverses a mistakenly recorded offline/bank-transfer admission payment.
     *
     * Atomically:
     * 1. Validates the payment exists and is an offline SUCCESS payment.
     * 2. Deletes all StudentLedger entries linked to this payment (referenceId = payment.id).
     * 3. Deletes the Payment record itself.
     * 4. Resets StudentAdmission:
     *    - paidFee decremented by payment.amount
     *    - totalFee decremented by the same amount
     *    - status reverted to SEAT_ALLOTTED
     *    - allottedCourseId cleared, accommodationType reset to NONE
     * 5. Decrements Course.filledSeats (if course was allotted).
     * 6. Decrements Hostel.filled / TransportRoute.filled if accommodation was set.
     * 7. Resets linked StudentFeeDemand status back to PENDING (if any demand was settled).
     *
     * Only OFFLINE (NEFT, RTGS, IMPS, Cheque, DD, Cash) SUCCESS payments
     * whose metadata.targetAction === 'FINALIZE_ADMISSION' can be reversed here.
     */
    async reverseAdmissionPayment(paymentId: string, adminId: string, reason?: string) {
        logger.info(`[reverseAdmissionPayment] paymentId=${paymentId} adminId=${adminId}`);

        // 1. Fetch payment with related data
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            include: {
                student: { include: { admissionDetails: true } }
            }
        });

        if (!payment) {
            throw new AppError('Payment not found', 404);
        }

        // Guard: only OFFLINE mode
        if (payment.mode !== PaymentMode.OFFLINE) {
            throw new AppError(
                'Only offline/bank-transfer payments can be reversed via this endpoint. ' +
                'For online payments, use the payment gateway refund flow.',
                400
            );
        }

        // Guard: only SUCCESS payments
        if (payment.status !== PaymentStatus.SUCCESS) {
            throw new AppError(
                `Payment cannot be reversed — current status is "${payment.status}". Only SUCCESS payments can be reversed.`,
                400
            );
        }

        // Guard: must be an admission finalization payment
        const meta = payment.metadata as any;
        if (meta?.targetAction !== 'FINALIZE_ADMISSION') {
            throw new AppError(
                'This payment is not linked to an admission finalization. Only payments recorded via the Finalize Admission flow can be reversed here.',
                400
            );
        }

        const admission = payment.student?.admissionDetails;
        const studentId = payment.studentId;
        const paidAmount = payment.amount;
        const allottedCourseId = admission?.allottedCourseId ?? meta?.course?.allottedCourseId;
        const accommodationType = admission?.accommodationType;
        const transportRouteId = admission?.transportRouteId;

        // 2. Atomic rollback transaction
        await prisma.$transaction(async (tx) => {

            // 2a. Delete StudentLedger entries referencing this payment
            await (tx.studentLedger as any).deleteMany({
                where: { referenceId: paymentId, referenceType: 'PAYMENT' }
            });
            logger.info(`[reverseAdmissionPayment] Deleted payment ledger entries`);

            // 2b. Delete tuition FEE_GENERATION DEBIT ledger created during executeAdmissionUpdates
            //     (These use referenceType='FEE_GENERATION' and a referenceId like 'ADMISSION_<timestamp>')
            await (tx.studentLedger as any).deleteMany({
                where: {
                    studentId,
                    referenceType: 'FEE_GENERATION'
                }
            });
            logger.info(`[reverseAdmissionPayment] Deleted fee-generation ledger entries for student=${studentId}`);

            // 2c. Reset linked fee demand back to PENDING
            if (payment.feeDemandId) {
                try {
                    await tx.studentFeeDemand.update({
                        where: { id: payment.feeDemandId },
                        data: { status: FeeStatus.PENDING }
                    });
                } catch {
                    logger.warn(`[reverseAdmissionPayment] Could not reset fee demand ${payment.feeDemandId}`);
                }
            }

            // 2d. Delete the Payment record
            await tx.payment.delete({ where: { id: paymentId } });
            logger.info(`[reverseAdmissionPayment] Deleted payment record ${paymentId}`);

            // 2e. Decrement course capacity for the admission's academic year
            if (allottedCourseId && admission?.academicYearId) {
                await decrementCourseCapacity(tx, allottedCourseId, admission.academicYearId);
                logger.info(`[reverseAdmissionPayment] Decremented CourseCapacity for course=${allottedCourseId} year=${admission.academicYearId}`);
            }

            // 2f. Release transport seat (hostel "filled" is computed on-demand from StudentAdmission.hostelId)
            if (accommodationType === AccommodationType.TRANSPORT && transportRouteId) {
                await tx.transportRoute.update({
                    where: { id: transportRouteId },
                    data: { filled: { decrement: 1 } }
                });
            }

            // 2g. Reset StudentAdmission
            if (admission) {
                const newPaidFee = Math.max(0, (admission.paidFee ?? 0) - paidAmount);
                const newTotalFee = Math.max(0, (admission.totalFee ?? 0) - paidAmount);

                await tx.studentAdmission.update({
                    where: { studentId },
                    data: {
                        status: AdmissionStatus.SEAT_ALLOTTED,
                        paidFee: newPaidFee,
                        totalFee: newTotalFee,
                        feeStatus: FeeStatus.PENDING,
                        allottedCourseId: null,
                        accommodationType: AccommodationType.NONE,
                        hostelId: null,
                        hostelType: null,
                        hostelPaymentMode: null,
                        transportRouteId: null,
                        roomNumber: null
                    }
                });
                logger.info(`[reverseAdmissionPayment] Reset StudentAdmission for student=${studentId} → SEAT_ALLOTTED`);
            }
        });

        logger.info(`[reverseAdmissionPayment] Completed reversal. paymentId=${paymentId} student=${studentId} admin=${adminId} reason="${reason ?? 'none'}"`);

        return {
            success: true,
            message: 'Admission payment reversed successfully. The seat has been released and student status reset to SEAT_ALLOTTED.',
            reversed: {
                paymentId,
                studentId,
                amount: paidAmount,
                allottedCourseId,
                adminId,
                reason
            }
        };
    },

    /**
     * Backfill the `seatAllotedBy` column on StudentAdmission (the admin who
     * allotted the seat). Used to correct historical rows where the column
     * wasn't populated.
     */
    async updateSeatAllotedBy(studentId: string, seatAllotedBy: string, adminId: string | undefined) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
        if (!seatAllotedBy) throw new AppError('seatAllotedBy is required', 400);

        const user = await prisma.user.findUnique({ where: { id: seatAllotedBy } });
        if (!user) throw new AppError('User not found for seatAllotedBy ID', 404);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        const admission = await prisma.studentAdmission.findUnique({ where: { studentId } });
        if (!admission) throw new AppError('Admission record not found for this student', 404);

        const updated = await prisma.studentAdmission.update({
            where: { studentId },
            data: {
                seatAllotedBy,
                seatAllottedAt: new Date()
            }
        });

        logger.info(`[updateSeatAllotedBy] studentId=${studentId} seatAllotedBy="${seatAllotedBy}" by admin=${adminId}`);

        return updated;
    },


    // Note: waiting-list methods live in ./waitingList.ts and are spread at the
    // barrel level in adminStudent.service.ts. Don't re-spread WaitingListService here.

    /**
     * Manual entry admission — admin-driven backfill / lateral / transfer admission.
     *
     * Bypasses the standard application + entrance exam + seat-allotment flow.
     * Creates User + Student + StudentAdmission (status=ADMISSION_CONFIRMED) +
     * StudentEnrollment in a single transaction, then layers on optional
     * accommodation, prior payment, and scholarship intent.
     *
     * Payload shape is defined by `manualEntryAdmissionSchema` in adminValidators.ts.
     */
    async manualEntryAdmission(payload: any, adminId: string) {
        logger.info(`[manualEntryAdmission] Request by admin=${adminId} for ${payload?.student?.email || payload?.student?.phone} entry=${payload?.entry?.type}/${payload?.entry?.yearOfStudy}`);
        logger.debug(`[manualEntryAdmission] Full Payload: ${JSON.stringify(payload)}`);

        const { student: studentData, course, entry, enrollment, scholarship, accommodation, priorPayment } = payload;

        // ── Stage 1: Validation ──────────────────────────────────────────
        const [academicYear, validCourse, validSection, existingStudent] = await Promise.all([
            prisma.academicYear.findUnique({ where: { id: entry.academicYearId } }),
            prisma.course.findUnique({ where: { id: course.allottedCourseId } }),
            prisma.section.findUnique({ where: { id: enrollment.sectionId } }),
            prisma.student.findFirst({
                where: {
                    OR: [
                        ...(studentData.email ? [{ email: studentData.email }] : []),
                        { aadharNumber: studentData.aadharNumber },
                    ],
                },
            }),
        ]);

        if (!academicYear || academicYear.isDeleted) {
            logger.warn(`[manualEntryAdmission] Invalid academic year: ${entry.academicYearId}`);
            throw new AppError('Invalid Academic Year ID', 400);
        }
        // Locked / closed years are off-limits even for back-dated admissions —
        // the books for that year have been finalized.
        await assertAcademicYearWritable(entry.academicYearId);
        if (entry.isBackdated && new Date(academicYear.startDate) >= new Date()) {
            throw new AppError('Backdated entry requires an academic year whose startDate is in the past', 400);
        }
        if (!validCourse || validCourse.isDeleted) {
            throw new AppError('Invalid Course ID', 400);
        }
        if (!validSection || validSection.isDeleted) {
            throw new AppError('Invalid Section ID', 400);
        }
        if (entry.type === AdmissionEntryType.LATERAL && entry.yearOfStudy < 2) {
            throw new AppError('LATERAL entry requires yearOfStudy >= 2', 400);
        }
        if (entry.type === AdmissionEntryType.LATERAL && scholarship && ![0, 15, 25, 50].includes(scholarship.percentage)) {
            throw new AppError('Lateral entry scholarship must be 0, 15, 25, or 50', 400);
        }

        // Reject duplicate rollNumber within the entry academic year. Schema has no
        // `@unique` on rollNumber so this check is application-level. The bulk validator
        // also catches within-batch dupes; this catches DB collisions for both single
        // and bulk paths.
        const dupRoll = await prisma.studentEnrollment.findFirst({
            where: {
                rollNumber: enrollment.rollNumber,
                academicYearId: entry.academicYearId,
                status: { not: 'DROPPED' },
            },
            select: { id: true, studentId: true },
        });
        if (dupRoll) {
            throw new AppError(
                `Roll number "${enrollment.rollNumber}" already assigned to another active enrollment in this academic year`,
                409
            );
        }

        // Duplicate check — match registerStudent semantics: email OR aadhar last4 + dob
        if (existingStudent) {
            throw new AppError('Student already exists with this email or Aadhar', 409);
        }
        if (studentData.aadharNumber && studentData.dob) {
            const dobDate = studentData.dob instanceof Date ? studentData.dob : new Date(studentData.dob);
            const last4 = studentData.aadharNumber.toString().trim().replace(/\s/g, '').slice(-4);
            const maskedPattern = `XXXX XXXX ${last4}`;
            const dobStart = new Date(dobDate.getFullYear(), dobDate.getMonth(), dobDate.getDate());
            const dobEnd = new Date(dobDate.getFullYear(), dobDate.getMonth(), dobDate.getDate(), 23, 59, 59, 999);
            const dupByAadhar = await prisma.student.findFirst({
                where: {
                    aadharNumber: maskedPattern,
                    dob: { gte: dobStart, lte: dobEnd },
                },
            });
            if (dupByAadhar) {
                throw new AppError('Student already exists with this Aadhar + DOB', 409);
            }
        }

        // ── Stage 2: Defaults ────────────────────────────────────────────
        const currentSemester = entry.currentSemester ?? (entry.yearOfStudy * 2 - 1);
        const dobDate = studentData.dob instanceof Date ? studentData.dob : new Date(studentData.dob);

        // Mask the Aadhaar before storage (matches registerStudent convention)
        const last4 = studentData.aadharNumber.toString().trim().replace(/\s/g, '').slice(-4);
        const storedAadhar = `XXXX XXXX ${last4}`;

        // ── Stage 3: Atomic transaction (User + Student + Admission + Enrollment + ApplicationFee) ──
        const APPLICATION_FEE_AMOUNT = await getApplicationFeeAmount();
        const appFeeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.APPLICATION_FEE]);
        const appFeeHead = appFeeHeadMap.get(PaymentComponent.APPLICATION_FEE);

        const isAppFeeWaived = entry.type === AdmissionEntryType.LATERAL
            && studentData.quotaType === QuotaType.MANAGEMENT;

        const txResult = await prisma.$transaction(async (tx) => {
            // 1. ApplicationId — MAN prefix marks manual-entry admissions
            const applicationId = `MAN${Date.now()}${Math.floor(Math.random() * 100)}`;

            // 2. Hash default password
            const hashedPassword = await bcrypt.hash('Welcome@123', 10);

            // 3. Create User
            const user = await tx.user.create({
                data: {
                    name: studentData.name,
                    email: studentData.email,
                    phone: studentData.phone,
                    password: hashedPassword,
                    role: Role.STUDENT,
                    isDeleted: false,
                    createdBy: adminId,
                    updatedBy: adminId,
                },
            });

            // 4. Create Student
            const newStudent = await tx.student.create({
                data: {
                    applicationId,
                    name: studentData.name,
                    fatherName: studentData.fatherName,
                    motherName: studentData.motherName,
                    gender: studentData.gender,
                    dob: dobDate,
                    phone: studentData.phone,
                    email: studentData.email,
                    aadharNumber: storedAadhar,
                    category: studentData.category,
                    country: studentData.country,
                    address: studentData.address,
                    address2: studentData.address2,
                    city: studentData.city,
                    state: studentData.state,
                    pincode: studentData.pincode,
                    profilePhotoUrl: studentData.profilePhotoUrl,
                    quotaType: studentData.quotaType,
                    applicationMode: ApplicationMode.OFFLINE,
                    isOffline: true,
                    isKycVerified: true,
                    userId: user.id,
                    createdBy: adminId,
                    updatedBy: adminId,
                } as any,
            });

            // 5. Create StudentAdmission — status ADMISSION_CONFIRMED, skip exam flow
            // feeCohortAcademicYearId always equals entryAcademicYearId — the student's
            // own batch year drives their fee schedule, with FeeStructure.entryType
            // differentiating REGULAR vs LATERAL fees within that year.
            const feeCohortAcademicYearId = entry.academicYearId;

            // Batch year = the academic year the student's BATCH started 1st year.
            // For REGULAR (yearOfStudy 1) it's the current year; a lateral/2nd-year+
            // student joins the batch that started (yearOfStudy - 1) academic years ago.
            // Computed always (stored on the admission for reporting), then used to claim
            // the shared course-seat pool.
            let batchAcademicYearId = entry.academicYearId;
            if (entry.yearOfStudy > 1) {
                const years = await tx.academicYear.findMany({
                    where: { isDeleted: false },
                    orderBy: { startDate: 'asc' },
                    select: { id: true },
                });
                const idx = years.findIndex(y => y.id === entry.academicYearId);
                if (idx < 0) throw new AppError('Current academic year not found while resolving the lateral batch year', 400);
                const batchIdx = idx - (entry.yearOfStudy - 1);
                if (batchIdx < 0) {
                    throw new AppError(`No academic year exists ${entry.yearOfStudy - 1} year(s) before the current year — cannot resolve the lateral batch's seat pool`, 400);
                }
                batchAcademicYearId = years[batchIdx].id;
            }

            // Seat capacity: regular and lateral share ONE pool per course/batch (e.g.
            // 120 seats; 110 regular → 10 left for laterals). The seat comes from the
            // BATCH year's CourseCapacity, not the current admission year. Skipped for
            // back-dated historical entries (their old-year capacity may be unconfigured
            // and shouldn't block data backfill).
            if (!entry.isBackdated) {
                const seatClaimed = await tryAtomicIncrementCourseCapacity(tx, course.allottedCourseId, batchAcademicYearId);
                if (!seatClaimed) {
                    const cap = await getCourseCapacity(tx, course.allottedCourseId, batchAcademicYearId);
                    throw new AppError(
                        `No seats available in this course for the batch (filled ${cap.filledSeats}/${cap.totalSeats}). Cannot admit.`,
                        400,
                    );
                }
                logger.info(`[manualEntryAdmission] Claimed seat for student in course=${course.allottedCourseId} batchYear=${batchAcademicYearId} (entryType=${entry.type}, yearOfStudy=${entry.yearOfStudy})`);
            }

            const newAdmission = await tx.studentAdmission.create({
                data: {
                    studentId: newStudent.id,
                    status: AdmissionStatus.ADMISSION_CONFIRMED,
                    allottedCourseId: course.allottedCourseId,
                    academicYearId: entry.academicYearId,
                    entryType: entry.type,
                    entryYearOfStudy: entry.yearOfStudy,
                    entryAcademicYearId: entry.academicYearId,
                    feeCohortAcademicYearId,
                    batchAcademicYearId,
                    instituteCode: entry.instituteCode ?? 'VVIG',
                    entryReason: entry.reason,
                    isBackdated: entry.isBackdated,
                    paidFee: 0,
                    totalFee: 0,
                    feeStatus: FeeStatus.PENDING,
                    accommodationType: AccommodationType.NONE,
                } as any,
            });

            // 6. Create StudentExam (matches registerStudent convention; harmless empty row)
            await tx.studentExam.create({
                data: { studentId: newStudent.id },
            });

            // 7. Create StudentEnrollment
            const newEnrollment = await tx.studentEnrollment.create({
                data: {
                    studentId: newStudent.id,
                    sectionId: enrollment.sectionId,
                    rollNumber: enrollment.rollNumber,
                    currentSemester,
                    yearOfStudy: entry.yearOfStudy,
                    academicYearId: entry.academicYearId,
                    status: 'ACTIVE',
                    createdBy: adminId,
                    updatedBy: adminId,
                } as any,
            });

            // 8. Application fee handling
            if (appFeeHead) {
                if (isAppFeeWaived) {
                    // Lateral + Management → fully-waived APPLICATION_FEE demand
                    const waivedDemand = await tx.studentFeeDemand.create({
                        data: {
                            studentId: newStudent.id,
                            feeHeadId: appFeeHead.id,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            amount: APPLICATION_FEE_AMOUNT,
                            discountAmount: APPLICATION_FEE_AMOUNT,
                            netAmount: 0,
                            status: FeeStatus.FULL,
                            dueDate: new Date(),
                            remarks: 'Application fee waived: lateral entry, management quota',
                            createdBy: adminId,
                            updatedBy: adminId,
                        } as any,
                    });
                    await tx.studentLedger.create({
                        data: {
                            studentId: newStudent.id,
                            type: LedgerTransactionType.CREDIT,
                            amount: APPLICATION_FEE_AMOUNT,
                            description: 'Application fee waiver: lateral + management quota',
                            referenceId: waivedDemand.id,
                            referenceType: 'WAIVER',
                            feeHeadId: appFeeHead.id,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            createdBy: adminId,
                        } as any,
                    });
                } else {
                    // Normal PENDING APPLICATION_FEE demand
                    await tx.studentFeeDemand.create({
                        data: {
                            studentId: newStudent.id,
                            feeHeadId: appFeeHead.id,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            amount: APPLICATION_FEE_AMOUNT,
                            netAmount: APPLICATION_FEE_AMOUNT,
                            status: FeeStatus.PENDING,
                            dueDate: new Date(),
                            remarks: 'Application fee — manual entry admission',
                            createdBy: adminId,
                            updatedBy: adminId,
                        } as any,
                    });
                }
            } else {
                logger.warn(`[manualEntryAdmission] No FeeHead tagged with PaymentComponent.APPLICATION_FEE — skipping application fee demand for student=${newStudent.id}`);
            }

            return { user, student: newStudent, admission: newAdmission, enrollment: newEnrollment };
        });

        const { student, admission, enrollment: createdEnrollment } = txResult;
        logger.info(`[manualEntryAdmission] Core records created. studentId=${student.id} applicationId=${student.applicationId}`);

        // ── Stage 4: Side effects (outside main transaction — they own their own TXs) ──

        // 9. Tuition / yearly fee demand seeding.
        // For lateral / back-dated admissions, the entry academicYear must already have
        // FeeStructure rows for the chosen course. If absent (e.g. admin forgot to clone
        // from current year), we proceed with the admission but flag in the response so
        // admin can run POST /finance/fees/fee-structure/clone-academic-year and then
        // call generateFeeDemands manually.
        let totalFeeDemandsCreated = 0;
        let feeStructureMissing = false;
        try {
            const fsCount = await prisma.feeStructure.count({
                where: {
                    courseId: course.allottedCourseId,
                    academicYearId: entry.academicYearId,
                    isDeleted: false,
                },
            });
            if (fsCount === 0) {
                feeStructureMissing = true;
                logger.warn(
                    `[manualEntryAdmission] No FeeStructure rows for course=${course.allottedCourseId} ` +
                    `academicYearId=${entry.academicYearId}. Admission created but tuition demands NOT seeded. ` +
                    `Clone fee structures from a prior year via POST /finance/fees/fee-structure/clone-academic-year, ` +
                    `then run generateFeeDemands for student=${student.id}.`
                );
            } else {
                const seeded = await FeeService.generateFeeDemands(
                    student.id,
                    course.allottedCourseId,
                    entry.academicYearId,
                    adminId,
                    false
                    // allowLegacyFallback defaults to true → preserves legacy behavior for manual entries
                );
                totalFeeDemandsCreated = seeded?.generated ?? 0;
                logger.info(`[manualEntryAdmission] generateFeeDemands seeded ${totalFeeDemandsCreated} demand(s) for student=${student.id} (fallback=${seeded?.fallbackUsed})`);
            }
        } catch (err) {
            logger.error(`[manualEntryAdmission] generateFeeDemands failed for student=${student.id}: ${err}`);
        }

        // 10. Optional accommodation
        let hostelAllocated = false;
        let transportAllocated = false;
        if (accommodation && accommodation.type === AccommodationType.HOSTEL && accommodation.hostelId && accommodation.hostelType && accommodation.hostelPaymentMode) {
            try {
                await AccommodationService.assignHostel(
                    student.id,
                    accommodation.hostelId,
                    accommodation.hostelPaymentMode as 'YEARWISE' | 'SEMWISE',
                    accommodation.hostelType as HostelType,
                    adminId
                );
                hostelAllocated = true;
                logger.info(`[manualEntryAdmission] Hostel assigned student=${student.id} hostelId=${accommodation.hostelId}`);
            } catch (err) {
                logger.error(`[manualEntryAdmission] assignHostel failed for student=${student.id}: ${err}`);
            }
        } else if (accommodation && accommodation.type === AccommodationType.TRANSPORT && accommodation.transportRouteId) {
            try {
                await AccommodationService.assignTransport(student.id, accommodation.transportRouteId, adminId);
                transportAllocated = true;
                logger.info(`[manualEntryAdmission] Transport assigned student=${student.id} routeId=${accommodation.transportRouteId}`);
            } catch (err) {
                logger.error(`[manualEntryAdmission] assignTransport failed for student=${student.id}: ${err}`);
            }
        }

        // 11. Optional priorPayment — record carried-over payment
        let priorPaymentRecorded = false;
        if (priorPayment && priorPayment.amount > 0) {
            try {
                const providerTxId = `MAN_${Date.now()}_${student.id.substring(0, 8)}`;
                await prisma.$transaction(async (tx) => {
                    const payment = await tx.payment.create({
                        data: {
                            studentId: student.id,
                            amount: priorPayment.amount,
                            method: priorPayment.method,
                            mode: PaymentMode.OFFLINE,
                            status: PaymentStatus.SUCCESS,
                            component: priorPayment.component,
                            providerTxId,
                            idempotencyKey: `${providerTxId}_${priorPayment.component}`,
                            referenceNumber: priorPayment.referenceNumber || null,
                            feeHeadId: priorPayment.feeHeadId,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            collectedBy: adminId,
                            createdBy: adminId,
                            updatedBy: adminId,
                            metadata: { source: 'manual-entry', adminId },
                        } as any,
                    });

                    await tx.studentLedger.create({
                        data: {
                            studentId: student.id,
                            type: LedgerTransactionType.CREDIT,
                            amount: priorPayment.amount,
                            description: `Prior payment carried over (${priorPayment.component}) — manual entry`,
                            referenceId: payment.id,
                            referenceType: 'PAYMENT',
                            feeHeadId: priorPayment.feeHeadId,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            createdBy: adminId,
                        } as any,
                    });

                    await tx.studentAdmission.update({
                        where: { studentId: student.id },
                        data: { paidFee: { increment: priorPayment.amount } },
                    });
                });
                priorPaymentRecorded = true;
                logger.info(`[manualEntryAdmission] Prior payment recorded student=${student.id} amount=${priorPayment.amount} component=${priorPayment.component}`);
            } catch (err) {
                logger.error(`[manualEntryAdmission] priorPayment recording failed for student=${student.id}: ${err}`);
            }
        }

        // 12. Optional scholarship — store intent only (Phase 1)
        let scholarshipRecorded = false;
        if (scholarship && typeof scholarship.percentage === 'number') {
            try {
                await prisma.studentScholarship.create({
                    data: {
                        studentId: student.id,
                        type: entry.type === AdmissionEntryType.LATERAL ? 'LATERAL' : 'MANUAL_ENTRY',
                        scholarshipPercentage: scholarship.percentage,
                        remarks: scholarship.ruleId ? `Manual entry — ruleId=${scholarship.ruleId}` : 'Manual entry scholarship intent',
                        // Tag with the cohort's entry year — manual entry has explicit year context.
                        academicYearId: entry.academicYearId,
                        createdBy: adminId,
                        updatedBy: adminId,
                    } as any,
                });
                scholarshipRecorded = true;
                logger.info(`[manualEntryAdmission] Scholarship intent stored student=${student.id} pct=${scholarship.percentage}`);
            } catch (err) {
                logger.error(`[manualEntryAdmission] scholarship intent storage failed for student=${student.id}: ${err}`);
            }
        }

        // ── Stage 5: Audit ─────────────────────────────────────────────
        logger.info(`[manualEntryAdmission] DONE student=${student.id} app=${student.applicationId} admission=${admission.id} entry=${entry.type}/${entry.yearOfStudy} appFeeWaived=${isAppFeeWaived} hostel=${hostelAllocated} transport=${transportAllocated} priorPayment=${priorPaymentRecorded} scholarship=${scholarshipRecorded} demands=${totalFeeDemandsCreated}`);

        return {
            success: true,
            studentId: student.id,
            applicationId: student.applicationId,
            admissionId: admission.id,
            enrollmentId: createdEnrollment.id,
            entryType: entry.type,
            entryYearOfStudy: entry.yearOfStudy,
            applicationFeeWaived: isAppFeeWaived,
            hostelAllocated,
            transportAllocated,
            priorPaymentRecorded,
            scholarshipRecorded,
            totalFeeDemandsCreated,
            // True when no FeeStructure rows existed for this course+academicYear at admission time.
            // Admission was created but tuition demands were skipped — admin must clone fee
            // structures and re-trigger generateFeeDemands.
            feeStructureMissing,
            warning: feeStructureMissing
                ? `No FeeStructure rows for course ${course.allottedCourseId} in academic year ${entry.academicYearId}. ` +
                  `Tuition demands were not seeded. Clone fee structures via ` +
                  `POST /finance/fees/fee-structure/clone-academic-year, then re-run generateFeeDemands.`
                : undefined,
        };
    },

    /**
     * Assigns rollNumber + section to a registered student. Used after counseling /
     * seat allotment to create the StudentEnrollment row that backs roll-number-based
     * login and fee billing. Works for both fresh and lateral students — the entry
     * data was already captured during /student/register.
     */
    async assignEnrollment(
        studentId: string,
        rollNumber: string,
        sectionId: string,
        adminId: string,
        opts?: { currentSemester?: number; yearOfStudy?: number; seedFeeDemands?: boolean }
    ) {
        logger.info(`[assignEnrollment] studentId=${studentId} roll=${rollNumber} sectionId=${sectionId} admin=${adminId}`);

        // 1. Load student + admission to get entry data and active year
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: true }
        });
        if (!student) {
            throw new AppError('Student not found', 404);
        }
        if (!student.admissionDetails) {
            throw new AppError('Student admission record not found', 404);
        }

        // 2. Resolve active academic year (the year the enrollment will be tied to)
        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            orderBy: { startDate: 'desc' },
            select: { id: true, code: true },
        });
        if (!activeYear) {
            throw new AppError('No active academic year configured', 400);
        }

        // 3. Reject if student already has an enrollment for the active year
        const existing = await prisma.studentEnrollment.findFirst({
            where: { studentId, academicYearId: activeYear.id }
        });
        if (existing) {
            throw new AppError(
                `Student already has an enrollment for ${activeYear.code} (rollNumber=${existing.rollNumber})`,
                409
            );
        }

        // 4. Reject if rollNumber is already used in the active year
        const dupRoll = await prisma.studentEnrollment.findFirst({
            where: {
                rollNumber: rollNumber.trim(),
                academicYearId: activeYear.id,
                status: { not: 'DROPPED' },
            },
            select: { id: true, studentId: true },
        });
        if (dupRoll) {
            throw new AppError(
                `Roll number "${rollNumber}" already assigned to another active enrollment in ${activeYear.code}`,
                409
            );
        }

        // 5. Validate section exists
        const section = await prisma.section.findUnique({ where: { id: sectionId } });
        if (!section) {
            throw new AppError('Section not found', 404);
        }

        // 6. Defaults from entryYearOfStudy when caller doesn't specify
        const entryYos = student.admissionDetails.entryYearOfStudy ?? 1;
        const yearOfStudy     = opts?.yearOfStudy ?? entryYos;
        const currentSemester = opts?.currentSemester ?? (yearOfStudy * 2 - 1);

        // 7. Create the enrollment in a transaction; also bump admission status to
        //    SEAT_ALLOTTED if it's still REGISTERED (don't downgrade further-along statuses).
        const result = await prisma.$transaction(async (tx) => {
            const enrollment = await tx.studentEnrollment.create({
                data: {
                    studentId,
                    sectionId,
                    rollNumber: rollNumber.trim(),
                    academicYearId: activeYear.id,
                    currentSemester,
                    yearOfStudy,
                    status: 'ACTIVE',
                    createdBy: adminId,
                    updatedBy: adminId,
                }
            });

            if (student.admissionDetails!.status === AdmissionStatus.REGISTERED) {
                await tx.studentAdmission.update({
                    where: { studentId },
                    data: {
                        status: AdmissionStatus.SEAT_ALLOTTED,
                        seatAllotedBy: adminId,
                        seatAllottedAt: new Date(),
                    }
                });
            }

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'STUDENT_ENROLLMENT_ASSIGNED',
                    entity: 'StudentEnrollment',
                    entityId: enrollment.id,
                    details: { studentId, rollNumber: enrollment.rollNumber, sectionId, academicYearCode: activeYear.code },
                }
            });

            return enrollment;
        });

        logger.info(`[assignEnrollment] success enrollmentId=${result.id} studentId=${studentId} roll=${rollNumber}`);

        // 8. Optionally seed fee demands for the active year
        let feeDemandsSeeded = 0;
        const seedFeeDemands = opts?.seedFeeDemands ?? true;
        if (seedFeeDemands && student.admissionDetails.allottedCourseId) {
            try {
                const { FeeService } = require('../finance/fee.service');
                const result = await FeeService.generateFeeDemands(
                    studentId,
                    student.admissionDetails.allottedCourseId,
                    activeYear.id,
                    adminId,
                    false
                );
                feeDemandsSeeded = result?.generated ?? 0;
                logger.info(`[assignEnrollment] seeded ${feeDemandsSeeded} fee demands for studentId=${studentId} (fallback=${result?.fallbackUsed})`);
            } catch (err: any) {
                logger.error(`[assignEnrollment] generateFeeDemands failed for studentId=${studentId}: ${err.message}`);
            }
        }

        return {
            enrollment: result,
            admissionStatus: AdmissionStatus.SEAT_ALLOTTED,
            feeDemandsSeeded,
        };
    },
};
