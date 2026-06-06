

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
import { getHostelCostTx } from '../../../utils/hostelPricing';
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
    getStudentYearOfStudy,
} from '../../../utils/studentContext';
import { sendPaymentReceipt, sendScholarshipUpdateEmail } from '../../../utils/emailService';

import { StandardCheckoutClient, StandardCheckoutPayRequest } from 'pg-sdk-node';
import { InvoiceService } from '../../finance/invoice.service';
import { getPhonePeClient, initiatePhonePePayment, generateAndSaveAllotmentOrder } from '../../finance/payment.service';
import {
    FRONTEND_URL_ADMISSION,
    PREF_COURSE_WITH_CAPACITY,
    attachCourseCapacity,
} from './_shared';
import { AccommodationService } from './accommodation';

const SCHOLARSHIP_LOCKED_STATUSES: ReadonlySet<AdmissionStatus> = new Set([
    AdmissionStatus.SEAT_ALLOTTED,
    AdmissionStatus.ADMISSION_CONFIRMED,
    AdmissionStatus.ENROLLED,
]);

export const assertScholarshipEditableForStudent = async (
    studentId: string,
    callerRole?: string,
): Promise<void> => {

    if (callerRole === Role.SUPER_ADMIN) return;

    const admission = await prisma.studentAdmission.findUnique({
        where: { studentId },
        select: { status: true },
    });

    if (admission && SCHOLARSHIP_LOCKED_STATUSES.has(admission.status as AdmissionStatus)) {
        throw new AppError('Scholarship cannot be modified after seat allotment', 403);
    }
};

export const AdmissionService = {

    async requestCancellation(studentId: string, reason: string, refundAmount: number) {
        if (!studentId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_REASON_REQUIRED, 400);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const paidAgg = await prisma.payment.aggregate({
            where: { studentId, status: PaymentStatus.SUCCESS, isDeleted: false },
            _sum: { amount: true },
        });
        const totalPaid = paidAgg._sum.amount ?? 0;
        let cappedRefund = Number(refundAmount);
        if (cappedRefund > totalPaid) {
            logger.warn(
                `[requestCancellation] refundAmount ${cappedRefund} exceeds totalPaid ${totalPaid} for student ${studentId}. Capping to ${totalPaid}.`
            );
            cappedRefund = totalPaid;
        }

        const adminCancelYear = await getActiveAcademicYear();
        return await prisma.cancellationRequest.create({
            data: {
                studentId,
                academicYearId: adminCancelYear.id,
                reason,
                refundAmount: cappedRefund,
                status: CancellationStatus.REQUESTED
            }
        });
    },

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

    async verifyAndAllotSeat(studentId: string, approved: boolean, allottedCourseId: string, adminId: string | undefined, scholarshipPercentage?: number) {
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

        const course = await prisma.course.findUnique({ where: { id: allottedCourseId } });
        if (!course) throw new AppError("Course not found", 404);

        const hasScholarship = typeof scholarshipPercentage === 'number' && scholarshipPercentage > 0;

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
                    newCourse: course.name,
                    allocatedBy: adminId || 'ADMIN',
                    notes: 'Initial Seat Allotment'
                }
            });

            if (hasScholarship) {
                if (!admission.academicYearId) {
                    throw new AppError('Cannot set scholarship: admission has no academicYearId', 400);
                }
                await tx.studentScholarship.upsert({
                    where: { studentId },
                    update: {
                        scholarshipPercentage,
                        isEligible: 'YES',
                        type: 'MANUAL',
                        updatedBy: adminId,
                    },
                    create: {
                        studentId,
                        academicYearId: admission.academicYearId,
                        scholarshipPercentage,
                        isEligible: 'YES',
                        type: 'MANUAL',
                        createdBy: adminId,
                    },
                });
            } else {
                await tx.studentScholarship.updateMany({
                    where: { studentId },
                    data: {
                        isEligible: 'NO',
                        scholarshipPercentage: 0,
                        updatedBy: adminId,
                    },
                });
            }

            const appFeeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.APPLICATION_FEE]);
            const appFeeHead = appFeeHeadMap.get(PaymentComponent.APPLICATION_FEE);
            if (appFeeHead) {
                const [existingPayment, existingDemand] = await Promise.all([
                    tx.payment.findFirst({
                        where: {
                            studentId,
                            component: PaymentComponent.APPLICATION_FEE,
                            status: PaymentStatus.SUCCESS,
                            isDeleted: false,
                        },
                        select: { id: true },
                    }),
                    tx.studentFeeDemand.findFirst({
                        where: {
                            studentId,
                            feeHeadId: appFeeHead.id,
                            isDeleted: false,
                        },
                        select: { id: true },
                    }),
                ]);

                if (!existingPayment && !existingDemand) {
                    const appFeeAmount = await getApplicationFeeAmount();
                    const allotYearOfStudy = await getStudentYearOfStudy(studentId, tx);
                    await tx.studentFeeDemand.create({
                        data: {
                            studentId,
                            feeHeadId: appFeeHead.id,
                            academicYearId: admission.academicYearId,
                            yearOfStudy: allotYearOfStudy,
                            amount: appFeeAmount,
                            netAmount: appFeeAmount,
                            status: FeeStatus.PENDING,
                            dueDate: new Date(),
                            remarks: 'Application fee — seeded at seat allotment (admin allotted before student paid).',
                            createdBy: adminId,
                        } as any,
                    });
                    logger.info(`[verifyAndAllotSeat] Seeded PENDING APPLICATION_FEE demand for ${studentId} (no payment or prior demand found).`);
                }
            } else {
                logger.warn(`[verifyAndAllotSeat] No FeeHead tagged component=APPLICATION_FEE — cannot seed pending app-fee demand for ${studentId}.`);
            }
        });

        logger.info(
            `[verifyAndAllotSeat] Scholarship state for ${studentId}: ` +
            (hasScholarship ? `${scholarshipPercentage}% (manual, eligible)` : 'cleared — any existing row forced to NO')
        );

        return { success: true, message: MESSAGES.SUCCESS.SEAT_ALLOTTED };
    },

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

    async requestBranchChange(studentId: string, newCourseId: string, reason: string, recommendedByManagement: boolean = false, branchChangeFee: number = 0) {
        if (!studentId || !newCourseId || !reason) {
            throw new AppError('studentId, newCourseId and reason are required', 400);
        }

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

        if (oldCourse?.degree !== newCourse.degree) {
            throw new AppError(
                `Branch change requires the same degree program. Old: "${oldCourse?.degree}", New: "${newCourse.degree}". Use Program Change for cross-program transfers.`,
                400
            );
        }

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

    async requestProgramChange(studentId: string, newCourseId: string, reason: string) {
        if (!studentId || !newCourseId || !reason) {
            throw new AppError('studentId, newCourseId and reason are required', 400);
        }

        const pendingRequest = await prisma.courseChangeRequest.findFirst({
            where: { studentId, status: { in: [RequestStatus.REQUESTED, RequestStatus.FORWARDED] } },
            select: { id: true }
        });
        if (pendingRequest) {
            throw new AppError(`A course/branch change request is already pending for this student (ID: ${pendingRequest.id}). Approve or reject it before raising a new one.`, 409);
        }

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

        if (fromDegree === toDegree) {
            throw new AppError(
                `Program change requires different degree programs. Both are "${oldCourse?.degree}". Use Branch Change instead.`,
                400
            );
        }

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

    async requestCourseChange(studentId: string, newCourseId: string, reason: string) {
        if (!studentId || !newCourseId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_NEWCOURSE_REASON_REQUIRED, 400);

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

    async approveCourseChange(requestId: string, approved: boolean, adminRole: string | undefined, adminId: string | undefined, recommendedByManagement?: boolean, branchChangeFee?: number) {
        if (adminRole !== Role.SUPER_ADMIN) {
            throw new AppError(MESSAGES.ERROR.ONLY_SUPER_ADMIN_APPROVE_COURSE, 403);
        }

        if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

        const request = await prisma.courseChangeRequest.findUnique({ where: { id: requestId } });
        if (!request) throw new AppError(MESSAGES.ERROR.REQUEST_NOT_FOUND, 404);

        if (request.status === RequestStatus.APPROVED || request.status === RequestStatus.REJECTED) {
            throw new AppError(`This request has already been ${request.status.toLowerCase()}`, 400);
        }

        const status = approved ? RequestStatus.APPROVED : RequestStatus.REJECTED;

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

                const toCourse = await tx.course.findUnique({ where: { id: request.toCourse } });
                if (!toCourse) throw new AppError('Target course not found', 404);
                const toCapacity = await getCourseCapacity(tx, request.toCourse, ayId);
                if (toCapacity.filledSeats >= toCapacity.totalSeats) {
                    throw new AppError(`Target course "${toCourse.code || toCourse.name}" is fully booked (${toCapacity.filledSeats}/${toCapacity.totalSeats}). Cannot process branch change.`, 400);
                }

                await tx.studentAdmission.update({
                    where: { studentId: request.studentId },
                    data: { allottedCourseId: request.toCourse }
                });

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
                        academicYearId: ayId,
                        oldCourse: request.fromCourse,
                        newCourse: request.toCourse,
                        oldDegree: (request as any).fromDegree,
                        newDegree: (request as any).toDegree,
                        approvedBy: adminId || 'SUPER_ADMIN'
                    } as any
                });

                const student = await tx.student.findUnique({
                    where: { id: request.studentId },
                    include: { admissionDetails: true }
                });

                if (!student) return;

                const studentDemands = await tx.studentFeeDemand.findMany({
                    where: { studentId: request.studentId },
                    include: {
                        feeHead: true,
                        payments: { where: { status: 'SUCCESS' } }
                    }
                });

                const academicYearId = studentDemands.find(d => (d.feeHead?.name || '').toLowerCase().includes('tuition'))?.academicYearId
                                        || student.admissionDetails?.academicYearId;

                if (!academicYearId) {
                    logger.warn(`[approveCourseChange] No academic year found for student ${request.studentId}. Skipping financial reconciliation.`);
                    return;
                }

                const courseChangeYearOfStudy = await getStudentYearOfStudy(request.studentId, tx);

                const newCourseStructures = await tx.feeStructure.findMany({
                    where: {
                        courseId: request.toCourse,
                        academicYearId
                    },
                    include: { feeHead: true }
                });

                const newCourseHeadIds = new Set(newCourseStructures.map(s => s.feeHeadId));

                const totalPaidAcrossAll = studentDemands.reduce((sum, d) => sum + d.payments.reduce((ps, p) => ps + p.amount, 0), 0);

                for (const struct of newCourseStructures) {
                    const existingDemand = studentDemands.find(d => d.feeHeadId === struct.feeHeadId);
                    const isTuition = (struct.feeHead?.name || '').toLowerCase().includes('tuition');

                    if (existingDemand) {
                        const oldFee = existingDemand.amount;
                        const newFee = struct.amount;
                        const currentPaid = existingDemand.payments.reduce((sum, p) => sum + p.amount, 0);

                        let newScholarshipAmt = 0;
                        let newDiscountTotal = existingDemand.discountAmount || 0;
                        const studentScholarship = isTuition ? await tx.studentScholarship.findUnique({ where: { studentId: request.studentId } }) : null;
                        const scholarshipPct = studentScholarship?.scholarshipPercentage || 0;
                        if (isTuition) {
                            const oldScholarship = existingDemand.scholarshipAmount || 0;
                            const manualDiscount = Math.max(0, (existingDemand.discountAmount || 0) - oldScholarship);

                            newScholarshipAmt = (newFee * scholarshipPct) / 100;
                            newDiscountTotal = manualDiscount + newScholarshipAmt;
                        }

                        const newNetAmount = newFee - newDiscountTotal;
                        const pending = newNetAmount - currentPaid;

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
                                        academicYearId: academicYearId,
                                        yearOfStudy: existingDemand.yearOfStudy ?? courseChangeYearOfStudy,
                                    }
                                });
                            }

                            logger.info(`[approveCourseChange] Scholarship ledger synced for student ${request.studentId}. Old: ${existingScholarshipLedger?.amount || 0}, New: ${newScholarshipAmt}`);
                        }
                    } else {

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

                        await tx.studentLedger.updateMany({
                            where: {
                                referenceId: demand.id,
                                referenceType: 'SCHOLARSHIP',
                                type: 'CREDIT',
                                isDeleted: false
                            },
                            data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId }
                        });

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
                                    yearOfStudy: demand.yearOfStudy ?? courseChangeYearOfStudy,
                                    createdBy: adminId
                                }
                            });
                        }

                        logger.info(`[approveCourseChange] Orphaned demand removed: ${headName} (paid: ${paidOnDemand}${paidOnDemand > 0 ? ' → carried forward as FeeCorrection' : ''}) for student ${request.studentId}`);
                    }
                }

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

                            remarks: `Settled: reversed by new branch change ${request.fromCourse} → ${request.toCourse}`
                        }
                    });

                    await tx.studentLedger.create({
                        data: {
                            studentId: request.studentId,
                            type: LedgerTransactionType.DEBIT,
                            amount: settledTotal,
                            description: `Previous branch change corrections reversed (${existingCorrections.length} entries, total: ${settledTotal})`,
                            referenceType: 'FEE_CORRECTION_REVERSAL',
                            referenceId: requestId,
                            academicYearId,
                            yearOfStudy: courseChangeYearOfStudy,
                            createdBy: adminId
                        }
                    });

                    logger.info(`[approveCourseChange] Settled ${existingCorrections.length} previous corrections for student ${request.studentId}. Reversed: ${settledTotal}`);
                }

                let totalCorrectionAmount = 0;

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
                                yearOfStudy: demand.yearOfStudy ?? courseChangeYearOfStudy,
                                createdBy: adminId
                            }
                        });

                        totalCorrectionAmount += excessPaid;
                    }
                }

                if (totalCorrectionAmount > 0) {
                    logger.info(`[approveCourseChange] FeeCorrections created for student ${request.studentId}. Total refund: ${totalCorrectionAmount}, carryForward: true`);
                }

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
                            yearOfStudy: courseChangeYearOfStudy,
                            createdBy: adminId
                        }
                    });

                    logger.info(`[approveCourseChange] Branch change fee ledger DEBIT created for student ${request.studentId}. Amount: ${changeFee}`);
                }

                logger.info(`[approveCourseChange] Full reconciliation for Student ${student.id} to Course ${request.toCourse}. TotalPaid: ${totalPaidAcrossAll}`);

                await recomputeStudentTotals(request.studentId, tx);
            }
        });

        try {
            const { generateAndSaveAllotmentOrder } = await import('../../finance/payment.service');
            await generateAndSaveAllotmentOrder(request.studentId);
            logger.info(`[approveCourseChange] Allotment order regenerated for student ${request.studentId}`);
        } catch (err) {
            logger.error(`[approveCourseChange] Failed to regenerate allotment order: ${err}`);
        }
    },

    ...AccommodationService,

    async updateAdmissionDetails(data: any, adminId: string | undefined) {
        const { studentId, accommodationType: target, hostelType, hostelId, transportRouteId, hostelPaymentMode } = data;

        if (!studentId || !target) throw new AppError(MESSAGES.ERROR.STUDENT_ACCOMMODATION_REQUIRED, 400);

        if (data.paidAmount != null && Number(data.paidAmount) > 0) {
            logger.warn(`[updateAdmissionDetails] Ignoring paidAmount=${data.paidAmount} for student ${studentId} — record payments via the finance APIs, not this endpoint.`);
        }

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: true }
        });
        if (!student || !student.admissionDetails) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const current = student.admissionDetails.accommodationType ?? AccommodationType.NONE;
        const reason = 'Accommodation change (update-admission)';
        const payMode: 'YEARWISE' | 'SEMWISE' = hostelPaymentMode === HostelPaymentMode.SEMWISE ? 'SEMWISE' : 'YEARWISE';

        const sameHostel = target === AccommodationType.HOSTEL && hostelId === student.admissionDetails.hostelId;
        const sameRoute = target === AccommodationType.TRANSPORT && transportRouteId === student.admissionDetails.transportRouteId;
        if (current === target && (target === AccommodationType.NONE || sameHostel || sameRoute)) {
            logger.info(`[updateAdmissionDetails] No accommodation change for ${studentId} (already ${current}).`);
            return;
        }

        if (current === AccommodationType.NONE && target === AccommodationType.HOSTEL) {
            await AccommodationService.assignHostel(studentId, hostelId, payMode, hostelType, adminId);
        } else if (current === AccommodationType.NONE && target === AccommodationType.TRANSPORT) {
            await AccommodationService.assignTransport(studentId, transportRouteId, adminId);
        } else if (current === AccommodationType.HOSTEL && target === AccommodationType.NONE) {
            await AccommodationService.cancelHostel(studentId, { reason }, adminId);
        } else if (current === AccommodationType.HOSTEL && target === AccommodationType.TRANSPORT) {
            await AccommodationService.switchHostelToTransport(studentId, { reason, transportRouteId }, adminId);
        } else if (current === AccommodationType.TRANSPORT && target === AccommodationType.NONE) {
            await AccommodationService.cancelTransport(studentId, { reason }, adminId);
        } else if (current === AccommodationType.TRANSPORT && target === AccommodationType.HOSTEL) {
            await AccommodationService.switchTransportToHostel(studentId, { reason, hostelId: hostelId ?? undefined, hostelType, hostelPaymentMode: payMode }, adminId);
        } else if (current === AccommodationType.TRANSPORT && target === AccommodationType.TRANSPORT) {
            await AccommodationService.reassignTransport(studentId, { transportRouteId, reason }, adminId);
        } else if (current === AccommodationType.HOSTEL && target === AccommodationType.HOSTEL) {

            throw new AppError('Hostel-to-hostel change must use the reassign-hostel endpoint (bed selection required).', 400);
        }

        await recomputeStudentTotals(studentId);

        logger.info(`[updateAdmissionDetails] ${current} → ${target} delegated to dedicated accommodation flow for student ${studentId}.`);
    },

    async updateRollNumber(studentId: string, rollNumber: string, sectionId: string, academicYearId: string, userId?: string) {
        const student = await prisma.student.findUnique({
             where: { id: studentId }
        });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

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

    async updateStudentScores(studentId: string, scores: any, adminId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        const { class12Aggregate, jeePercentile, satScore, vvitPercentile } = scores;

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

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

    async updateStudentPersonalDetails(studentId: string, data: any, adminId: string | undefined) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        const ALLOWED_PERSONAL_FIELDS = new Set([
            'name', 'dateOfBirth', 'gender', 'fatherName', 'motherName', 'guardianName',
            'address', 'city', 'state', 'pincode', 'category', 'subCategory',
            'religion', 'nationality', 'profilePhotoUrl',

            'email', 'phone', 'aadharNumber',
        ]);
        const updateData: Record<string, any> = {};
        for (const key of Object.keys(data)) {
            if (ALLOWED_PERSONAL_FIELDS.has(key)) {
                updateData[key] = data[key];
            }
        }

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        if (updateData.email && updateData.email !== student.email) {
            const existingEmail = await prisma.student.findUnique({ where: { email: updateData.email } });
            if (existingEmail) throw new AppError('Email already in use by another student', 400);

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

        if (updateData.phone && updateData.phone !== student.phone) {
             const existingPhone = await prisma.student.findFirst({ where: { phone: updateData.phone } });
             if (existingPhone) throw new AppError('Phone number already in use by another student', 400);
        }

        if (updateData.aadharNumber && updateData.aadharNumber !== student.aadharNumber) {
             const existingAadhar = await prisma.student.findFirst({ where: { aadharNumber: updateData.aadharNumber } });
             if (existingAadhar) throw new AppError('Aadhar number already in use by another student', 400);
        }

        await prisma.$transaction(async (tx) => {

             await tx.student.update({
                 where: { id: studentId },
                 data: {
                     ...updateData,
                     updatedBy: adminId
                 }
             });

             if (student.userId && updateData.email && updateData.email !== student.email) {
                 await tx.user.update({
                     where: { id: student.userId },
                     data: { email: updateData.email }
                 });
             }
        });

        let presignedPhotoUrl: string | null = null;
        if (updateData.profilePhotoUrl) {
            presignedPhotoUrl = await convertToPresignedUrl(updateData.profilePhotoUrl) || updateData.profilePhotoUrl;
        }

        return { success: true, message: 'Student personal details updated successfully', profilePhotoUrl: presignedPhotoUrl };
    },

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

                waitingListEntries: {
                    take: 1,
                    orderBy: { createdAt: 'desc' },
                    select: { id: true, category: true, waitingNumber: true, status: true, courseId: true, academicYearId: true },
                },
                user: { select: { id: true, email: true, phone: true, role: true, isDeleted: true } }
            }
        });

        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);
        const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
            ...doc,
            url: await convertToPresignedUrl(doc.url)
        })));

        let hallTicketUrl = null;
        if (student.examDetails?.hallTicketUrl) {
            hallTicketUrl = await convertToPresignedUrl(student.examDetails.hallTicketUrl);
        }

        const { hostelAllocations: _hostelAllocations, transportAllocations: _transportAllocations, waitingListEntries: _waitingListEntries, ...studentRest } = student as any;

        const _waitingEntry = _waitingListEntries?.[0] ?? null;
        return {
            ...studentRest,
            isInWaitingList: !!_waitingEntry,
            waitingListCategory: _waitingEntry?.category ?? null,
            waitingList: _waitingEntry,
            hostelAllocation: _hostelAllocations?.[0] ?? null,
            transportAllocation: _transportAllocations?.[0] ?? null,
            pref1Course: attachCourseCapacity((student as any).pref1Course, (student as any).admissionDetails?.batchAcademicYearId),
            pref2Course: attachCourseCapacity((student as any).pref2Course, (student as any).admissionDetails?.batchAcademicYearId),
            pref3Course: attachCourseCapacity((student as any).pref3Course, (student as any).admissionDetails?.batchAcademicYearId),
            profilePhotoUrl,
            documents: documentsWithPresignedUrls,
            examDetails: {
                ...student.examDetails,
                hallTicketUrl
            }
        };
    },

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

                waitingListEntries: {
                    take: 1,
                    orderBy: { createdAt: 'desc' },
                    select: { id: true, category: true, waitingNumber: true, status: true, courseId: true, academicYearId: true },
                },
                user: { select: { id: true, email: true, phone: true, role: true, isDeleted: true } }
            }
        });

        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);
        const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
            ...doc,
            url: await convertToPresignedUrl(doc.url)
        })));

        let hallTicketUrl = null;
        if (student.examDetails?.hallTicketUrl) {
            hallTicketUrl = await convertToPresignedUrl(student.examDetails.hallTicketUrl);
        }

        const { hostelAllocations: _hostelAllocations, transportAllocations: _transportAllocations, waitingListEntries: _waitingListEntries, ...studentRest } = student as any;

        const _waitingEntry = _waitingListEntries?.[0] ?? null;
        return {
            ...studentRest,
            isInWaitingList: !!_waitingEntry,
            waitingListCategory: _waitingEntry?.category ?? null,
            waitingList: _waitingEntry,
            hostelAllocation: _hostelAllocations?.[0] ?? null,
            transportAllocation: _transportAllocations?.[0] ?? null,
            pref1Course: attachCourseCapacity((student as any).pref1Course, (student as any).admissionDetails?.batchAcademicYearId),
            pref2Course: attachCourseCapacity((student as any).pref2Course, (student as any).admissionDetails?.batchAcademicYearId),
            pref3Course: attachCourseCapacity((student as any).pref3Course, (student as any).admissionDetails?.batchAcademicYearId),
            profilePhotoUrl,
            documents: documentsWithPresignedUrls,
            examDetails: {
                ...student.examDetails,
                hallTicketUrl
            }
        };
    },

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

    async validateAcademicQualification(qualificationId: string, status: string, remarks: string | undefined, adminId: string | undefined) {
        if (!qualificationId || !status) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        const qualification = await prisma.academicQualification.findUnique({
             where: { id: qualificationId }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

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

    async updateStudentScholarship(studentId: string, data: any, adminId: string | undefined, adminRole?: string) {
         if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

         await assertScholarshipEditableForStudent(studentId, adminRole);

         const { type, degreeType, score, remarks, scholarshipPercentage, qualificationId, isEligible } = data;

         if (qualificationId) {
             const qual = await prisma.academicQualification.findUnique({ where: { id: qualificationId } });
             if (!qual) throw new AppError('Qualification not found', 404);
         }

         const existing = await prisma.studentScholarship.findFirst({
             where: { studentId }
         });

         if (existing) {

             const { studentId: _sid, id: _id, ...updateProps } = data;

             if (updateProps.score !== undefined) updateProps.score = Number(updateProps.score);
             if (updateProps.scholarshipPercentage !== undefined) {
                 updateProps.scholarshipPercentage = Number(updateProps.scholarshipPercentage);
                 if (updateProps.scholarshipPercentage > 0) updateProps.isEligible = 'YES';
             }

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

                 const newPct = result.scholarshipPercentage || 0;
                 await this.propagateScholarshipUpdate(studentId, newPct, adminId, tx);

                 return result;
             });

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

         const newPct = newScholarship.scholarshipPercentage || 0;
         if (newPct > 0) {
             await prisma.$transaction(async (tx) => {
                  await this.propagateScholarshipUpdate(studentId, newPct, adminId, tx);
             });

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

    async getStudentScholarships(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        return await prisma.studentScholarship.findMany({
            where: { studentId },
            include: { qualification: true },
            orderBy: { createdAt: 'desc' }
        });
    },

    async editStudentScholarship(scholarshipId: string, data: any, adminId: string | undefined, adminRole?: string) {
        if (!scholarshipId) throw new AppError('Scholarship ID is required', 400);

        const existing = await prisma.studentScholarship.findUnique({ where: { id: scholarshipId } });
        if (!existing) throw new AppError('Scholarship record not found', 404);

        await assertScholarshipEditableForStudent(existing.studentId, adminRole);

        const { type, degreeType, score, remarks, scholarshipPercentage, qualificationId, isEligible } = data;

        if (qualificationId) {
             const qual = await prisma.academicQualification.findUnique({ where: { id: qualificationId } });
             if (!qual) throw new AppError('Qualification not found', 404);
        }

        const oldPct = existing.scholarshipPercentage || 0;

        const updatedScholarship = await prisma.$transaction(async (tx) => {

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

            const newPct = result.scholarshipPercentage || 0;
            const sid = result.studentId;

            logger.info(`[editStudentScholarship] Propagating update to ${newPct}% for student ${sid}`);

            await this.propagateScholarshipUpdate(sid, newPct, adminId, tx);

            return result;
        });

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

    async getScholarshipStats() {

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

        const statsMap = new Map();
        dbStats.forEach(item => {
            const key = `${item.degreeType}-${item.scholarshipPercentage}`;
            statsMap.set(key, item._count.studentId);
        });

        const finalStats: { degreeType: string; scholarshipPercentage: number | null; count: number; total: number }[] = [];

        manualDefaults.forEach(def => {
            const key = `${def.degreeType}-${def.scholarshipPercentage}`;
            const count = statsMap.get(key) || 0;
            finalStats.push({
                degreeType: def.degreeType,
                scholarshipPercentage: def.scholarshipPercentage,
                count: count,
                total: def.total
            });

            statsMap.delete(key);
        });

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

    propagateScholarshipUpdate: async (studentId: string, newPct: number, adminId: string | undefined, tx: any) => {
        logger.info(`[propagateScholarshipUpdate] Updating demands to ${newPct}% for student ${studentId}`);

        const demands = await tx.studentFeeDemand.findMany({
            where: { studentId },
            include: {
                feeHead: true,
                feeStructure: { include: { feeHead: true } },
                payments: { where: { status: 'SUCCESS', isDeleted: false } }
            }
        });

        const tuitionDemands = demands.filter((d: any) => {
            const head = d.feeHead || d.feeStructure?.feeHead;
            return head?.component === 'TUITION';
        });

        for (const demand of tuitionDemands) {
            const baseAmount = demand.amount;

            const manualDiscount = Math.max(0, (demand.discountAmount || 0) - (demand.scholarshipAmount || 0));
            const newScholarship = (baseAmount * newPct) / 100;
            const newDiscountTotal = manualDiscount + newScholarship;
            const newNet = Math.max(0, baseAmount - newDiscountTotal);
            const paid = (demand.payments || []).reduce((s: number, p: any) => s + (p.amount ?? 0), 0);
            const newStatus = paid >= newNet ? FeeStatus.FULL : (paid > 0 ? FeeStatus.PARTIAL : FeeStatus.PENDING);

            logger.info(`[propagateScholarshipUpdate] Demand ${demand.id}: base=${baseAmount}, manual=${manualDiscount}, scholarship=${newScholarship}, net=${newNet}, paid=${paid}, status=${newStatus}`);

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
                        type: 'CREDIT',
                        amount: newScholarship,
                        description: `Scholarship (${newPct}%)`,
                        referenceId: demand.id,
                        referenceType: 'SCHOLARSHIP',
                        feeHeadId: demand.feeHeadId,
                        academicYearId: demand.academicYearId,
                        yearOfStudy: demand.yearOfStudy ?? undefined,
                        createdBy: adminId
                    } as any
                });
            }
        }
    },

    async processPaymentSuccess(payment: any, adminId: string | undefined, tx: any) {
        const resolvedAdminId = adminId || 'SYSTEM';

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

        if (payment.feeDemandId) {
             const demand = await tx.studentFeeDemand.findUnique({ where: { id: payment.feeDemandId } });
             if (demand) {

                 const targetAmount = demand.netAmount ?? demand.amount;
                 const newStatus = payment.amount >= targetAmount ? 'FULL' : 'PARTIAL';

                 await tx.studentFeeDemand.update({
                     where: { id: payment.feeDemandId },
                     data: { status: newStatus }
                 });
             }
        }

        await recomputeStudentTotals(payment.studentId, tx);

        const meta = payment.metadata as any;
        if (meta && meta.targetAction === 'FINALIZE_ADMISSION') {
             await this.executeAdmissionUpdates(payment.studentId, meta, payment.id, resolvedAdminId, tx);
        }
    },

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

    async executeAdmissionUpdates(studentId: string, payload: any, _paymentId: string, adminId: string, tx: any) {
        try {
            const { allocation, scholarship, course } = payload;
            logger.info(`[executeAdmissionUpdates] Allocation: ${allocation.type}, Scholarship: ${scholarship?.percentage ?? 'unchanged'}`);

            logger.debug(`[executeAdmissionUpdates] Processing Accommodation: ${allocation?.type}`);
            const student = await tx.student.findUnique({ where: { id: studentId }, include: { admissionDetails: true } });
            const oldAdmission = student?.admissionDetails;

            const ayId = oldAdmission?.academicYearId;
            if (!ayId) {
                throw new AppError('Student admission / academic year not found', 404);
            }

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

            if (oldAdmission) {
                if (oldAdmission.transportRouteId && (oldAdmission.transportRouteId !== allocation.transportRouteId || allocation.type !== AccommodationType.TRANSPORT)) {
                     logger.debug(`[executeAdmissionUpdates] Releasing old transport seat: ${oldAdmission.transportRouteId}`);
                     await tx.transportRoute.update({ where: { id: oldAdmission.transportRouteId }, data: { filled: { decrement: 1 } } });
                }

                if (oldAdmission.allottedCourseId && oldAdmission.allottedCourseId !== course.allottedCourseId) {
                     logger.debug(`[executeAdmissionUpdates] Releasing old course seat: ${oldAdmission.allottedCourseId}`);
                     await decrementCourseCapacity(tx, oldAdmission.allottedCourseId, batchAcademicYearId);
                }
            }

            if (allocation.type === AccommodationType.TRANSPORT && oldAdmission?.transportRouteId !== allocation.transportRouteId) {
                logger.debug(`[executeAdmissionUpdates] Assigning new transport seat: ${allocation.transportRouteId}`);
                await tx.transportRoute.update({ where: { id: allocation.transportRouteId }, data: { filled: { increment: 1 } } });
            }

            if (!oldAdmission?.allottedCourseId || oldAdmission.allottedCourseId !== course.allottedCourseId) {
                logger.debug(`[executeAdmissionUpdates] Assigning new course seat: ${course.allottedCourseId} (batchYear=${batchAcademicYearId})`);

                const claimed = await tryAtomicIncrementCourseCapacity(tx, course.allottedCourseId, batchAcademicYearId);
                if (!claimed) {
                    const cap = await getCourseCapacity(tx, course.allottedCourseId, batchAcademicYearId);
                    logger.warn(`[executeAdmissionUpdates] Course ${course.allottedCourseId} is fully booked (${cap.filledSeats}/${cap.totalSeats}) for batch year ${batchAcademicYearId}`);
                    throw new AppError("Course is fully booked. No seats available.", 400);
                }
            }

            let accCostDelta = 0;

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

            if (allocation.type === AccommodationType.HOSTEL && allocation.hostelId) {
                 const newMode = allocation.hostelPaymentMode === HostelPaymentMode.SEMWISE ? 'SEMWISE' : 'YEARWISE';
                 const newPricing = await getHostelCostTx(allocation.hostelType, tx, newMode);
                 accCostDelta += newPricing.totalPrice;
             } else if (allocation.type === AccommodationType.TRANSPORT && allocation.transportRouteId) {
                 const r = await tx.transportRoute.findUnique({ where: { id: allocation.transportRouteId } });
                 if (r) accCostDelta += (r.cost || 0);
             }
            
            logger.debug(`[executeAdmissionUpdates] Total Fee Adjustment: ${accCostDelta}`);

            let baseTuition = 0;

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

                    seatAllottedAt: new Date()
                },
                create: {
                    studentId,

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

            if (scholarship && Object.prototype.hasOwnProperty.call(scholarship, 'percentage')) {
                const scholarshipPct = scholarship.percentage ?? 0;

                await tx.studentScholarship.upsert({
                    where: { studentId },
                    update: {
                        scholarshipPercentage: scholarshipPct,
                        isEligible: scholarshipPct > 0 ? 'YES' : 'NO',
                        updatedBy: adminId,
                    },
                    create: {
                        studentId,
                        academicYearId: ayId,
                        type: 'MANUAL',
                        scholarshipPercentage: scholarshipPct,
                        isEligible: scholarshipPct > 0 ? 'YES' : 'NO',
                        createdBy: adminId,
                        updatedBy: adminId,
                    } as any,
                });
                logger.debug(`[executeAdmissionUpdates] Scholarship upserted: percentage=${scholarshipPct}`);

                await this.propagateScholarshipUpdate(studentId, scholarshipPct, adminId, tx);
            } else {
                logger.debug(`[executeAdmissionUpdates] Scholarship field absent — leaving existing scholarship + demands untouched.`);
            }

            await recomputeStudentTotals(studentId, tx);

            logger.info(`[executeAdmissionUpdates] Successfully completed all updates for student=${studentId}`);
        } catch (error) {
            logger.error(`[executeAdmissionUpdates] Failed to execute updates: ${error}`);
            throw error; 
        }
    },

    async finalizeAdmission(payload: any, adminId: string) {
        logger.info(`[finalizeAdmission] Request received for student=${payload.studentId} method=${payload?.payment?.method}`);
        logger.debug(`[finalizeAdmission] Full Payload: ${JSON.stringify(payload)}`);

        if (!payload.allocation) {
            payload.allocation = { type: AccommodationType.NONE };
        }
        
        const { studentId, payment, scholarship, allocation, course, batchAcademicYearId } = payload;

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

        if (
            allocation.type === AccommodationType.HOSTEL &&
            allocation.hostelType &&
            allocation.hostelPaymentMode
        ) {

            const targetHostelId = allocation.hostelId
                ?? student.admissionDetails?.hostelId
                ?? null;

            if (!targetHostelId) {

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

        let feeDemandId = null;
        if (payment.feeStructureId) {
            if (!validFeeStructure || (validFeeStructure as any).id === 'skip') {
                logger.warn(`[finalizeAdmission] Invalid Fee Structure ID: ${payment.feeStructureId}`);
                throw new AppError("Invalid Fee Structure ID", 400);
            }

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

        if (!feeDemandId && payment.feeHeadId) {
            const demand = await prisma.studentFeeDemand.findFirst({
                where: {
                    studentId,
                    isDeleted: false,
                    status: { in: ['PENDING', 'PARTIAL'] as any },
                    OR: [
                        { feeHeadId: payment.feeHeadId },
                        { feeStructure: { feeHeadId: payment.feeHeadId } },
                    ],
                },
                orderBy: { dueDate: 'asc' },
                select: { id: true },
            });
            if (demand) {
                feeDemandId = demand.id;
                logger.info(`[finalizeAdmission] Linked payment to Demand via feeHeadId: ${demand.id}`);
            }
        }

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

             try {

             const targetComponent = payment.component || PaymentComponent.TUITION;

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
                         yearOfStudy: yearCtx.yearOfStudy ?? student.admissionDetails?.entryYearOfStudy ?? undefined,
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

             const merchantTransactionId = newPayment.providerTxId || newPayment.id.replace(/-/g, '');

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

             if (!payment.referenceNumber && payment.method !== PaymentMethod.CASH) {
                 throw new AppError("Reference Number is required for Non-Cash payments", 400);
             }

             const offlineResult = await prisma.$transaction(async (tx) => {
                 logger.info(`[finalizeAdmission][Offline] Starting transaction for student=${studentId}`);

                 const feeComponent = payment.component || PaymentComponent.TUITION;

                 const existingSuccess = await tx.payment.findFirst({
                     where: { studentId, component: feeComponent, status: PaymentStatus.SUCCESS }
                 });
                 if (existingSuccess) {
                     logger.warn(`[finalizeAdmission][Offline] Duplicate payment detected for student=${studentId} component=${feeComponent}`);
                     throw new AppError("Payment for this component has already been completed.", 409);
                 }

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

                 const yearCtx = await resolveFeeDemandContext(resolvedFeeDemandId, tx);

                 const _refForKey = `${studentId}_${Date.now()}`;
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
                        createdBy: adminId,
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

                logger.info(`[finalizeAdmission][Offline] Processing Post-Payment actions`);
                await this.processPaymentSuccess(newPayment, adminId, tx);

                logger.info(`[finalizeAdmission][Offline] Transaction committed successfully.`);
                return { success: true, type: 'OFFLINE_COMPLETED', message: "Admission Finalized Successfully", paymentId: newPayment.id };
             });

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

             try {
                if (offlineResult.paymentId) {
                    await InvoiceService.generateInvoiceForPayment(offlineResult.paymentId);
                }
             } catch (err) {
                logger.warn(`[finalizeAdmission] Failed to auto-generate invoice: ${err}`);
             }

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
                    transactionId: finalPayment?.referenceNumber,
                    payment: finalPayment
                 }
             };
        }
    },

    async verifyAndCompletePayment(paymentId: string, adminId: string | undefined) {
        logger.info(`[verifyAndCompletePayment] Verifying paymentId=${paymentId}`);

        const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
        if (!payment) {
            throw new AppError("Payment not found", 404);
        }

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

             const merchantTransactionId = payment.providerTxId || payment.id.replace(/-/g, '');

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

    async _completeAdmissionTransaction(payments: any[], adminId: string | undefined, providerTxId?: string, gatewayResponse?: any) {
        if (!payments || payments.length === 0) return;
        const primaryPayment = payments[0];
        logger.info(`[_completeAdmissionTransaction] Completing ${payments.length} payments. Primary=${primaryPayment.id}`);

        await prisma.$transaction(async (tx) => {

             const pendingPayments = payments.filter(p => p.status !== PaymentStatus.SUCCESS);
             if (pendingPayments.length === 0) return { success: true, status: PaymentStatus.SUCCESS };

             const paymentIds = pendingPayments.map(p => p.id);

             await tx.payment.updateMany({
                 where: { id: { in: paymentIds } },
                 data: { 
                     status: PaymentStatus.SUCCESS,
                     providerTxId: providerTxId || primaryPayment.providerTxId,
                     metadata: gatewayResponse || undefined
                 }
             });

             for (const payment of pendingPayments) {
                  await this.processPaymentSuccess(payment, adminId, tx);
             }
             
             return { success: true, status: PaymentStatus.SUCCESS };
         });

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

         try {
             await InvoiceService.generateInvoiceForPayment(primaryPayment.id);
         } catch (err) { logger.warn(`Failed to auto-generate invoice: ${err}`); }

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

    async getAdmissionInvoice(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        const payment = await prisma.payment.findFirst({
            where: {
                studentId,
                status: PaymentStatus.SUCCESS,
                component: PaymentComponent.TUITION
            },
            orderBy: { createdAt: 'desc' },
            include: { student: true }
        });

        if (!payment) {
            throw new AppError("No admission fee payment found for this student.", 404);
        }

        if (payment.invoiceUrl) {

            const finalUrl = await convertToPresignedUrl(payment.invoiceUrl);
            return { invoiceUrl: finalUrl };
        } else {

            const result = await InvoiceService.generateInvoiceForPayment(payment.id);

            return { invoiceUrl: await convertToPresignedUrl(result.invoiceUrl) };
        }
    },

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

        const { sendStatusUpdateEmail } = require('../../utils/emailService');

        const emailData = {
            studentName: student.name,
            applicationId: student.applicationId || studentId,
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

        const activeAdmissions = allAdmissions.filter(a =>
            a.allottedCourseId !== null && a.status !== 'CANCELLED'
        );

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

    async reverseAdmissionPayment(paymentId: string, adminId: string, reason?: string) {
        logger.info(`[reverseAdmissionPayment] paymentId=${paymentId} adminId=${adminId}`);

        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            include: {
                student: { include: { admissionDetails: true } }
            }
        });

        if (!payment) {
            throw new AppError('Payment not found', 404);
        }

        if (payment.mode !== PaymentMode.OFFLINE) {
            throw new AppError(
                'Only offline/bank-transfer payments can be reversed via this endpoint. ' +
                'For online payments, use the payment gateway refund flow.',
                400
            );
        }

        if (payment.status !== PaymentStatus.SUCCESS) {
            throw new AppError(
                `Payment cannot be reversed — current status is "${payment.status}". Only SUCCESS payments can be reversed.`,
                400
            );
        }

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

        await prisma.$transaction(async (tx) => {

            await (tx.studentLedger as any).deleteMany({
                where: { referenceId: paymentId, referenceType: 'PAYMENT' }
            });
            logger.info(`[reverseAdmissionPayment] Deleted payment ledger entries`);

            await (tx.studentLedger as any).deleteMany({
                where: {
                    studentId,
                    referenceType: 'FEE_GENERATION'
                }
            });
            logger.info(`[reverseAdmissionPayment] Deleted fee-generation ledger entries for student=${studentId}`);

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

            await tx.payment.delete({ where: { id: paymentId } });
            logger.info(`[reverseAdmissionPayment] Deleted payment record ${paymentId}`);

            if (allottedCourseId && admission?.academicYearId) {
                await decrementCourseCapacity(tx, allottedCourseId, admission.academicYearId);
                logger.info(`[reverseAdmissionPayment] Decremented CourseCapacity for course=${allottedCourseId} year=${admission.academicYearId}`);
            }

            if (accommodationType === AccommodationType.TRANSPORT && transportRouteId) {
                await tx.transportRoute.update({
                    where: { id: transportRouteId },
                    data: { filled: { decrement: 1 } }
                });
            }

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

    async manualEntryAdmission(payload: any, adminId: string) {
        logger.info(`[manualEntryAdmission] Request by admin=${adminId} for ${payload?.student?.email || payload?.student?.phone} entry=${payload?.entry?.type}/${payload?.entry?.yearOfStudy}`);
        logger.debug(`[manualEntryAdmission] Full Payload: ${JSON.stringify(payload)}`);

        const { student: studentData, course, entry, enrollment, scholarship, accommodation, priorPayment } = payload;

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

        const currentSemester = entry.currentSemester ?? (entry.yearOfStudy * 2 - 1);
        const dobDate = studentData.dob instanceof Date ? studentData.dob : new Date(studentData.dob);

        const last4 = studentData.aadharNumber.toString().trim().replace(/\s/g, '').slice(-4);
        const storedAadhar = `XXXX XXXX ${last4}`;

        const APPLICATION_FEE_AMOUNT = await getApplicationFeeAmount();
        const appFeeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.APPLICATION_FEE]);
        const appFeeHead = appFeeHeadMap.get(PaymentComponent.APPLICATION_FEE);

        const isAppFeeWaived = entry.type === AdmissionEntryType.LATERAL
            && studentData.quotaType === QuotaType.MANAGEMENT;

        const txResult = await prisma.$transaction(async (tx) => {

            const applicationId = `MAN${Date.now()}${Math.floor(Math.random() * 100)}`;

            const hashedPassword = await bcrypt.hash('Welcome@123', 10);

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

            const feeCohortAcademicYearId = entry.academicYearId;

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
                    instituteCode: entry.instituteCode ?? 'MGMT',
                    entryReason: entry.reason,
                    isBackdated: entry.isBackdated,
                    paidFee: 0,
                    totalFee: 0,
                    feeStatus: FeeStatus.PENDING,
                    accommodationType: AccommodationType.NONE,
                } as any,
            });

            await tx.studentExam.create({
                data: { studentId: newStudent.id },
            });

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

            if (appFeeHead) {
                if (isAppFeeWaived) {

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

                );
                totalFeeDemandsCreated = seeded?.generated ?? 0;
                logger.info(`[manualEntryAdmission] generateFeeDemands seeded ${totalFeeDemandsCreated} demand(s) for student=${student.id} (fallback=${seeded?.fallbackUsed})`);
            }
        } catch (err) {
            logger.error(`[manualEntryAdmission] generateFeeDemands failed for student=${student.id}: ${err}`);
        }

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

        let scholarshipRecorded = false;
        if (scholarship && typeof scholarship.percentage === 'number') {
            try {
                await prisma.studentScholarship.create({
                    data: {
                        studentId: student.id,
                        type: entry.type === AdmissionEntryType.LATERAL ? 'LATERAL' : 'MANUAL_ENTRY',
                        scholarshipPercentage: scholarship.percentage,

                        isEligible: 'YES',
                        remarks: scholarship.ruleId ? `Manual entry — ruleId=${scholarship.ruleId}` : 'Manual entry scholarship intent',

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

        try {
            await recomputeStudentTotals(student.id);
        } catch (err) {
            logger.error(`[manualEntryAdmission] recomputeStudentTotals failed for student=${student.id}: ${err}`);
        }

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

            feeStructureMissing,
            warning: feeStructureMissing
                ? `No FeeStructure rows for course ${course.allottedCourseId} in academic year ${entry.academicYearId}. ` +
                  `Tuition demands were not seeded. Clone fee structures via ` +
                  `POST /finance/fees/fee-structure/clone-academic-year, then re-run generateFeeDemands.`
                : undefined,
        };
    },

    async assignEnrollment(
        studentId: string,
        rollNumber: string,
        sectionId: string,
        adminId: string,
        opts?: { currentSemester?: number; yearOfStudy?: number; seedFeeDemands?: boolean }
    ) {
        logger.info(`[assignEnrollment] studentId=${studentId} roll=${rollNumber} sectionId=${sectionId} admin=${adminId}`);

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

        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            orderBy: { startDate: 'desc' },
            select: { id: true, code: true },
        });
        if (!activeYear) {
            throw new AppError('No active academic year configured', 400);
        }

        const existing = await prisma.studentEnrollment.findFirst({
            where: { studentId, academicYearId: activeYear.id }
        });
        if (existing) {
            throw new AppError(
                `Student already has an enrollment for ${activeYear.code} (rollNumber=${existing.rollNumber})`,
                409
            );
        }

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

        const section = await prisma.section.findUnique({ where: { id: sectionId } });
        if (!section) {
            throw new AppError('Section not found', 404);
        }

        const entryYos = student.admissionDetails.entryYearOfStudy ?? 1;
        const yearOfStudy     = opts?.yearOfStudy ?? entryYos;
        const currentSemester = opts?.currentSemester ?? (yearOfStudy * 2 - 1);

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

    async reconcileStudentFees(studentId: string, adminId: string | undefined, adminRole?: string) {
        if (adminRole !== Role.SUPER_ADMIN) {
            throw new AppError('Fee reconciliation is restricted to SUPER_ADMIN.', 403);
        }
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        const admission = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { accommodationType: true },
        });
        if (!admission) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        const accType = admission.accommodationType;

        const HOSTEL_COMPONENTS: ReadonlySet<string> = new Set([
            'HOSTEL', 'HOSTEL_ACCOMMODATION', 'HOSTEL_MESS', 'HOSTEL_LAUNDRY', 'HOSTEL_REGISTRATION',
        ]);
        const TRANSPORT_COMPONENTS: ReadonlySet<string> = new Set(['TRANSPORT']);

        const allDemands = await prisma.studentFeeDemand.findMany({
            where: { studentId, isDeleted: false },
            include: {
                feeStructure: { include: { feeHead: true } },
                feeHead: true,
                payments: { where: { status: PaymentStatus.SUCCESS, isDeleted: false } },
            },
        });

        type OrphanReport = { demandId: string; component: string; amount: number };
        const softDeleted: OrphanReport[] = [];
        const skipped: (OrphanReport & { reason: string; paidCount: number })[] = [];

        await prisma.$transaction(async (tx) => {
            for (const d of allDemands) {
                const comp = ((d.feeHead as any)?.component ?? (d.feeStructure as any)?.feeHead?.component) as string | null | undefined;
                if (!comp) continue;
                const isHostelComp = HOSTEL_COMPONENTS.has(comp);
                const isTransportComp = TRANSPORT_COMPONENTS.has(comp);
                const orphan =
                    (isHostelComp && accType !== AccommodationType.HOSTEL) ||
                    (isTransportComp && accType !== AccommodationType.TRANSPORT);
                if (!orphan) continue;

                if ((d as any).payments && (d as any).payments.length > 0) {
                    skipped.push({
                        demandId: d.id,
                        component: comp,
                        amount: d.amount,
                        paidCount: (d as any).payments.length,
                        reason: 'Has linked SUCCESS payments — handle via fee-correction flow before deletion.',
                    });
                    continue;
                }

                await tx.studentFeeDemand.update({
                    where: { id: d.id },
                    data: { isDeleted: true, updatedBy: adminId },
                });
                softDeleted.push({ demandId: d.id, component: comp, amount: d.amount });
            }
        });

        const totalsAfter = await recomputeStudentTotals(studentId);

        logger.info(
            `[reconcileStudentFees] student=${studentId} accType=${accType} ` +
            `softDeleted=${softDeleted.length} skipped(withPayments)=${skipped.length} ` +
            `newTotalFee=${totalsAfter.totalFee} newPaidFee=${totalsAfter.paidFee}`
        );

        return {
            studentId,
            accommodationType: accType,
            softDeletedCount: softDeleted.length,
            skippedCount: skipped.length,
            softDeleted,
            skipped,
            totalsAfter,
        };
    },
};
