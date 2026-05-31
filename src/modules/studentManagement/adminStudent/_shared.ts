// Shared helpers + constants for the adminStudent service modules.
// All split files (applications.ts, accommodation.ts, admission.ts, waitingList.ts)
// import from here so the legacy `adminStudent.service.ts` barrel doesn't have to.

import prisma from '../../../config/prisma';
import { AdmissionStatus, PaymentComponent, PaymentStatus, FeeStatus } from '@prisma/client';
import { Env } from 'pg-sdk-node';

// --- CONFIGURATION CONSTANTS ---
export const PHONEPE_MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID || '';
export const PHONEPE_SALT_KEY = process.env.PHONEPE_SALT_KEY || '';
export const PHONEPE_SALT_INDEX = parseInt(process.env.PHONEPE_SALT_INDEX || '1', 10);
export const PHONEPE_ENV = process.env.PHONEPE_ENV === 'PROD' ? Env.PRODUCTION : Env.SANDBOX;
export const FRONTEND_URL_ADMISSION = process.env.FRONTEND_URL_ADMISSION || 'http://localhost:5173';

/**
 * Prisma include fragment for a preference course: pulls the active-year
 * capacity row (totalSeats / filledSeats) plus its academic year tag.
 */
export const PREF_COURSE_WITH_CAPACITY = {
    include: {
        capacities: {
            where: { academicYear: { isActive: true } },
            take: 1,
            include: { academicYear: { select: { id: true, code: true, isActive: true } } },
        },
    },
} as const;

/**
 * Flatten the `capacities[0]` into top-level `totalSeats / filledSeats / academicYear`
 * on a pref-course object so the UI doesn't have to dig into the array.
 * Returns null/undefined unchanged.
 */
export const attachCourseCapacity = (course: any): any => {
    if (!course) return course;
    const cap = course.capacities?.[0];
    const { capacities: _ignored, ...rest } = course;
    return {
        ...rest,
        totalSeats: cap?.totalSeats ?? null,
        filledSeats: cap?.filledSeats ?? null,
        academicYear: cap?.academicYear ?? null,
    };
};

/**
 * Build the Prisma `where` object for the application list/export endpoints.
 * Accepts the full query payload and returns a Prisma-shaped where clause that
 * applies search, status, quotaType, degreeType, scholarship, exam-date, marks,
 * facilities, branch-change, cancellation, allotment-order, fee-paid and date-range
 * filters in one place.
 */
export const buildApplicationFilters = async (query: any): Promise<any> => {
    const { search, status, quotaType, degreeType, applicationId, isScholarshipEligible, createdBy, qualificationVerifiedBy, gender, pref1, pref2, pref3, applicationFeePaid, examDate, examStartDate, examEndDate, qualificationVerified, certificateStatus, qualificationLevel, qualificationBoard, marks10thMin, marks10thMax, marks12thMin, marks12thMax, certificatesApproved, seatStatus, scholarship, scholarshipPercentage, program, branch, facilities, discountApplied, branchChange, seatCancellation, cancellationReason, allotmentOrder, dateRange, startDate, endDate, seatAllotedBy, proCode, proReq } = query;

    const where: any = {};
    if (search) {
        where.OR = [
            { name: { contains: String(search), mode: 'insensitive' } },
            { email: { contains: String(search), mode: 'insensitive' } },
            { phone: { contains: String(search), mode: 'insensitive' } },
            { applicationId: { contains: String(search), mode: 'insensitive' } }
        ];
    }

    if (applicationId) {
        where.applicationId = String(applicationId);
    }

    if (status && status !== AdmissionStatus.CANCELLED) {
        where.admissionDetails = {
            status: status
        };
    }

    // Always exclude students whose admission has been CANCELLED — irrespective of
    // any other filter the caller passes in.
    where.NOT = [
        ...(Array.isArray(where.NOT) ? where.NOT : []),
        { admissionDetails: { status: AdmissionStatus.CANCELLED } }
    ];

    // Default-exclude REGISTERED too: students at the very first lifecycle step
    // (just signed up, no app-fee, no docs) shouldn't appear in admin queues by
    // default. Escape hatch: when the caller explicitly passes `status=REGISTERED`,
    // honor that and skip the exclusion so admins can still query the REGISTERED
    // cohort directly (e.g. to follow up on students who haven't paid yet).
    if (status !== AdmissionStatus.REGISTERED) {
        where.NOT.push({ admissionDetails: { status: AdmissionStatus.REGISTERED } });
    }

    if (quotaType) {
        where.quotaType = quotaType;
    }

    if (degreeType) {
        where.degreeType = degreeType;
    }

    if (isScholarshipEligible) {
        if (String(isScholarshipEligible).toUpperCase() === 'NULL') {
            where.studentScholarship = null;
        } else if (String(isScholarshipEligible).toUpperCase() === 'NOT_NULL') {
            where.studentScholarship = { isNot: null };
        } else {
            where.studentScholarship = {
                isEligible: String(isScholarshipEligible)
            };
        }
    }

    if (query.hasDocuments === 'true') {
        if (!where.AND) where.AND = [];
        where.AND.push({ documents: { some: {} } });
    } else if (query.hasDocuments === 'false') {
        if (!where.AND) where.AND = [];
        where.AND.push({ documents: { none: {} } });
    }

    if (createdBy) {
        where.createdBy = String(createdBy);
    }

    if (qualificationVerifiedBy) {
        if (!where.AND) where.AND = [];
        where.AND.push({
            academicQualifications: {
                some: { verifiedBy: String(qualificationVerifiedBy) }
            }
        });
    }

    if (seatAllotedBy) {
        if (!where.admissionDetails) where.admissionDetails = {};
        where.admissionDetails.seatAllotedBy = String(seatAllotedBy);
    }

    if (proReq === 'true' || proReq === true) {
        where.proId = { not: null };
        where.pro = { proNumber: { not: '0' } };
    }

    if (proCode) {
        const pro = await prisma.pRO.findUnique({ where: { proNumber: String(proCode) } });
        if (pro) {
            where.proId = pro.id;
        } else {
            where.id = 'NO_MATCH';
        }
    }

    if (gender) {
        where.gender = { equals: String(gender), mode: 'insensitive' };
    }

    if (pref1) {
        const values = String(pref1).split(',').map((v: string) => v.trim()).filter(Boolean);
        where.pref1 = values.length === 1 ? values[0] : { in: values };
    }

    if (pref2) {
        const values = String(pref2).split(',').map((v: string) => v.trim()).filter(Boolean);
        where.pref2 = values.length === 1 ? values[0] : { in: values };
    }

    if (pref3) {
        const values = String(pref3).split(',').map((v: string) => v.trim()).filter(Boolean);
        where.pref3 = values.length === 1 ? values[0] : { in: values };
    }

    if (examStartDate || examEndDate) {
        const testDateFilter: any = {};
        if (examStartDate) {
            const start = new Date(String(examStartDate));
            start.setHours(0, 0, 0, 0);
            testDateFilter.gte = start;
        }
        if (examEndDate) {
            const end = new Date(String(examEndDate));
            end.setHours(23, 59, 59, 999);
            testDateFilter.lte = end;
        }
        where.examDetails = { testDate: testDateFilter };
    } else if (examDate) {
        const start = new Date(String(examDate));
        start.setHours(0, 0, 0, 0);
        const end = new Date(String(examDate));
        end.setHours(23, 59, 59, 999);
        where.examDetails = {
            testDate: { gte: start, lte: end }
        };
    }

    if (qualificationVerified) {
        if (!where.AND) where.AND = [];
        where.AND.push({ academicQualifications: { some: {} } });
        const values = String(qualificationVerified).split(',').map((v: string) => v.trim().toUpperCase()).filter(Boolean);
        const verificationOrConditions: any[] = [];
        for (const val of values) {
            if (val === 'VERIFIED') {
                verificationOrConditions.push({
                    academicQualifications: { every: { verificationStatus: 'APPROVED' } }
                });
            } else if (val === 'UNVERIFIED') {
                verificationOrConditions.push({
                    academicQualifications: { none: { verificationStatus: 'APPROVED' } }
                });
            } else {
                verificationOrConditions.push({
                    academicQualifications: { some: { verificationStatus: val } }
                });
            }
        }
        if (verificationOrConditions.length === 1) {
            where.AND.push(verificationOrConditions[0]);
        } else if (verificationOrConditions.length > 1) {
            where.AND.push({ OR: verificationOrConditions });
        }
    }

    const academicQualificationConditions: any[] = [];

    if (qualificationLevel) {
        const levels = String(qualificationLevel).split(',').map((l: string) => l.trim()).filter(Boolean);
        academicQualificationConditions.push({
            academicQualifications: {
                some: { level: levels.length === 1 ? levels[0] : { in: levels } }
            }
        });
    }

    if (qualificationBoard) {
        academicQualificationConditions.push({
            academicQualifications: {
                some: { board: { contains: String(qualificationBoard), mode: 'insensitive' } }
            }
        });
    }

    if (marks10thMin || marks10thMax) {
        const conditions: string[] = [`"level" = '10th'`, `"gpaOrMarks" IS NOT NULL`];
        if (marks10thMin) conditions.push(`CAST("gpaOrMarks" AS DOUBLE PRECISION) >= ${Number(marks10thMin)}`);
        if (marks10thMax) conditions.push(`CAST("gpaOrMarks" AS DOUBLE PRECISION) <= ${Number(marks10thMax)}`);
        const studentIds10th: { studentId: string }[] = await prisma.$queryRawUnsafe(
            `SELECT DISTINCT "studentId" FROM "AcademicQualification" WHERE ${conditions.join(' AND ')}`
        );
        academicQualificationConditions.push({
            id: { in: studentIds10th.map(r => r.studentId) }
        });
    }

    if (marks12thMin || marks12thMax) {
        const conditions: string[] = [`"level" = '12th'`, `"gpaOrMarks" IS NOT NULL`];
        if (marks12thMin) conditions.push(`CAST("gpaOrMarks" AS DOUBLE PRECISION) >= ${Number(marks12thMin)}`);
        if (marks12thMax) conditions.push(`CAST("gpaOrMarks" AS DOUBLE PRECISION) <= ${Number(marks12thMax)}`);
        const studentIds12th: { studentId: string }[] = await prisma.$queryRawUnsafe(
            `SELECT DISTINCT "studentId" FROM "AcademicQualification" WHERE ${conditions.join(' AND ')}`
        );
        academicQualificationConditions.push({
            id: { in: studentIds12th.map(r => r.studentId) }
        });
    }

    if (academicQualificationConditions.length > 0) {
        where.AND = [...(where.AND || []), ...academicQualificationConditions];
    }

    if (certificateStatus) {
        if (!where.AND) where.AND = [];
        where.AND.push(
            { documents: { some: {} } },
            { documents: { every: { status: String(certificateStatus).toUpperCase() } } }
        );
    }

    if (certificatesApproved) {
        const val = String(certificatesApproved).toUpperCase();
        if (!where.AND) where.AND = [];
        if (val === 'YES') {
            where.AND.push({ documents: { some: { status: 'APPROVED' } } });
        } else if (val === 'NO') {
            where.AND.push({ documents: { none: { status: 'APPROVED' } } });
        } else if (val === 'PENDING') {
            where.AND.push({ documents: { some: { status: 'PENDING' } } });
        }
    }

    if (seatStatus) {
        const val = String(seatStatus).toUpperCase();
        if (val === 'ALLOTTED') {
            where.admissionDetails = { ...where.admissionDetails, allottedCourseId: { not: null } };
        } else if (val === 'PENDING') {
            where.admissionDetails = { ...where.admissionDetails, allottedCourseId: null };
        }
    }

    if (scholarship) {
        const val = String(scholarship).toUpperCase();
        where.studentScholarship = {
            isEligible: val === 'YES' ? 'YES' : 'NO'
        };
    }

    if (scholarshipPercentage) {
        where.studentScholarship = {
            ...where.studentScholarship,
            scholarshipPercentage: Number(scholarshipPercentage)
        };
    }

    if (program) {
        const values = String(program).split(',').map((v: string) => v.trim()).filter(Boolean);
        where.admissionDetails = {
            ...where.admissionDetails,
            allottedCourse: { degree: values.length === 1 ? values[0] : { in: values } }
        };
    }

    if (branch) {
        const values = String(branch).split(',').map((v: string) => v.trim()).filter(Boolean);
        where.admissionDetails = {
            ...where.admissionDetails,
            allottedCourseId: values.length === 1 ? values[0] : { in: values }
        };
    }

    if (facilities) {
        where.admissionDetails = {
            ...where.admissionDetails,
            accommodationType: String(facilities).toUpperCase()
        };
    }

    if (discountApplied) {
        const val = String(discountApplied).toUpperCase();
        if (val === 'YES') {
            where.discountRequests = { some: {} };
        } else if (val === 'NO') {
            where.discountRequests = { none: {} };
        }
    }

    if (branchChange) {
        const val = String(branchChange).toUpperCase();
        if (val === 'YES') {
            where.courseChangeLogs = { some: {} };
        } else if (val === 'NO') {
            where.courseChangeLogs = { none: {} };
        }
    }

    if (seatCancellation) {
        const val = String(seatCancellation).toUpperCase();
        if (val === 'YES') {
            where.cancellationRequests = { some: {} };
        } else if (val === 'NO') {
            where.cancellationRequests = { none: {} };
        }
    }

    if (cancellationReason) {
        where.cancellationRequests = {
            some: { conditionType: String(cancellationReason) }
        };
    }

    if (allotmentOrder) {
        const val = String(allotmentOrder).toUpperCase();
        if (!where.AND) where.AND = [];
        if (val === 'YES') {
            where.AND.push({ documents: { some: { documentKey: 'ALLOTMENT_ORDER' } } });
        } else if (val === 'NO') {
            where.AND.push({ documents: { none: { documentKey: 'ALLOTMENT_ORDER' } } });
        }
    }

    if (applicationFeePaid === 'UNPAID') {
        where.payments = {
            none: {
                component: PaymentComponent.APPLICATION_FEE,
                status: PaymentStatus.SUCCESS
            }
        };
    } else if (applicationFeePaid === 'PAID') {
        where.payments = {
            some: {
                component: PaymentComponent.APPLICATION_FEE,
                status: PaymentStatus.SUCCESS
            }
        };
    }

    // Used by the Verify Documents module: "cleared" = SUCCESS APPLICATION_FEE payment
    // OR a fully-waived APPLICATION_FEE demand (e.g. lateral + management quota — they
    // never produce a payment row, so the older `applicationFeePaid=PAID` filter would
    // wrongly exclude them). Unrelated callers should keep using `applicationFeePaid`.
    //
    // Default to CLEARED when `hasDocuments=true` (the Verify Documents context — the
    // only caller passing that flag). Pass `applicationFeeCleared=ALL` to opt out.
    let applicationFeeCleared = query.applicationFeeCleared;
    if (!applicationFeeCleared && query.hasDocuments === 'true') {
        applicationFeeCleared = 'CLEARED';
    }
    if (applicationFeeCleared === 'CLEARED' || applicationFeeCleared === 'UNCLEARED') {
        const clearedConditions = [
            { payments: { some: { component: PaymentComponent.APPLICATION_FEE, status: PaymentStatus.SUCCESS } } },
            { feeDemands: { some: {
                feeHead: { component: PaymentComponent.APPLICATION_FEE },
                status: FeeStatus.FULL,
                discountAmount: { gt: 0 },
                isDeleted: false,
            } } },
        ];
        if (!where.AND) where.AND = [];
        if (applicationFeeCleared === 'CLEARED') {
            where.AND.push({ OR: clearedConditions });
        } else {
            where.AND.push({ NOT: { OR: clearedConditions } });
        }
    }

    if (dateRange) {
        const now = new Date();
        const startOfDayFn = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
        const endOfDayFn = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

        let gte: Date | undefined;
        let lte: Date | undefined;

        const val = String(dateRange).toLowerCase();

        if (val === 'today') {
            gte = startOfDayFn(now);
            lte = endOfDayFn(now);
        } else if (val === 'yesterday') {
            const d = new Date(now);
            d.setDate(now.getDate() - 1);
            gte = startOfDayFn(d);
            lte = endOfDayFn(d);
        } else if (val === '7d') {
            const d = new Date(now);
            d.setDate(now.getDate() - 7);
            gte = startOfDayFn(d);
            lte = endOfDayFn(now);
        } else if (val === '15d') {
            const d = new Date(now);
            d.setDate(now.getDate() - 15);
            gte = startOfDayFn(d);
            lte = endOfDayFn(now);
        } else if (val === '30d') {
            const d = new Date(now);
            d.setDate(now.getDate() - 30);
            gte = startOfDayFn(d);
            lte = endOfDayFn(now);
        } else if (val === 'custom' && startDate && endDate) {
            gte = startOfDayFn(new Date(String(startDate)));
            lte = endOfDayFn(new Date(String(endDate)));
        }

        if (gte && lte) {
            const seatStatusUpper = seatStatus ? String(seatStatus).toUpperCase() : null;
            if (seatStatusUpper === 'ALLOTTED') {
                where.admissionDetails = {
                    ...where.admissionDetails,
                    seatAllottedAt: { gte, lte }
                };
            } else {
                where.createdAt = { gte, lte };
            }
        }
    }

    return where;
};
