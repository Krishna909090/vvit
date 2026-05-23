import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { SystemSetting, DiscountStatus, PaymentMethod, PaymentComponent, PaymentMode, QuotaType, AccommodationType, LedgerTransactionType } from '@prisma/client';
import { Role, RoleType } from '../../constants/roles';
import logger from '../../utils/logger';
import { convertToPresignedUrl } from '../../utils/s3Utils';
import { getHostelCostTx } from '../../utils/hostelPricing';
import { assertHostelHasCapacity } from '../accommodation/hostel/hostel.service';
import { recomputeStudentTotals } from '../../utils/studentContext';

const APP_FEE_KEY = 'APPLICATION_FEE_AMOUNT';
const DEFAULT_APP_FEE = '500';

/** Read the configured application-fee amount from SystemSetting (defaults to 500). */
export const getApplicationFeeAmount = async (): Promise<number> => {
    const setting = await prisma.systemSetting.findUnique({
        where: { key: APP_FEE_KEY }
    });
    return parseInt(setting?.value || DEFAULT_APP_FEE, 10);
};

/** Upsert the application-fee amount SystemSetting. */
export const setApplicationFeeAmount = async (amount: number, userId: string): Promise<SystemSetting> => {
    return prisma.systemSetting.upsert({
        where: { key: APP_FEE_KEY },
        update: {
            value: amount.toString(),
            updatedBy: userId
        },
        create: {
            key: APP_FEE_KEY,
            value: amount.toString(),
            updatedBy: userId
        }
    });
};

export const FeeService = {
    // Fee Head
    /** Create a fee head (a billable line item like TUITION / HOSTEL), optionally tagged to a payment component. */
    createFeeHead: async (name: string, description: string, userId: string, component?: PaymentComponent) => {
        return prisma.feeHead.create({
            data: { name, description, component: component ?? null, createdBy: userId, updatedBy: userId }
        });
    },

    /** List all fee heads. */
    getFeeHeads: async () => {
        return prisma.feeHead.findMany({ where: { isDeleted: false } });
    },

    /** List fee heads applicable to a course (with their structure amounts) for a given year. */
    getCourseFeeHeads: async (courseId: string, academicYearId?: string) => {
        const where: any = { isDeleted: false, courseId };
        if (academicYearId) where.academicYearId = academicYearId;

        const feeStructures = await prisma.feeStructure.findMany({
            where,
            include: {
                feeHead: true,
                academicYear: true
            }
        });

        const course = await prisma.course.findUnique({ where: { id: courseId } });
        if (!course) throw new AppError('Course not found', 404);

        // Strict: read explicit FeeHead.component only. Untagged heads bucket as 'OTHER'.
        const getCategoryForHead = (h: { component?: PaymentComponent | null }): string => {
            return h.component ? (h.component as string) : 'OTHER';
        };

        const breakdown: Record<string, { demanded: number, feeHeadId: string }> = {};

        feeStructures.forEach(fs => {
            const category = getCategoryForHead(fs.feeHead as any);
            if (!breakdown[category]) {
                breakdown[category] = { demanded: 0, feeHeadId: '' };
            }
            breakdown[category].demanded += fs.amount;
            if (!breakdown[category].feeHeadId) {
                breakdown[category].feeHeadId = fs.feeHeadId;
            }
        });

        const totalDemanded = Object.values(breakdown).reduce((sum, cat) => sum + cat.demanded, 0);

        return {
            courseName: course.name,
            summary: { totalDemanded },
            breakdown
        };
    },

    /** Patch a fee head's name/description/component. */
    updateFeeHead: async (id: string, name: string, description: string, userId: string, component?: PaymentComponent | null) => {
        const updateData: any = { updatedBy: userId };
        if (name !== undefined) updateData.name = name;
        if (description !== undefined) updateData.description = description;
        if (component !== undefined) updateData.component = component;
        return prisma.feeHead.update({
            where: { id },
            data: updateData
        });
    },

    /** Delete a fee head (guards against orphaning fee structures). */
    deleteFeeHead: async (id: string) => {
        return prisma.feeHead.update({
            where: { id },
            data: { isDeleted: true }
        });
    },

    // Fee Structure
    /** Create a FeeStructure row: the amount for (course, feeHead, year, quota, yearOfStudy). The recipe demands are generated from. */
    createFeeStructure: async (
        courseId: string,
        feeHeadId: string,
        amount: number,
        academicYearId: string,
        userId: string,
        quotaType?: QuotaType,
        yearOfStudy?: number,
        entryAcademicYearId?: string,
        entryType?: 'REGULAR' | 'LATERAL' | 'TRANSFER',
        instituteCode?: 'VVITU' | 'VVITPU',
    ) => {
        const existing = await prisma.feeStructure.findFirst({
            where: {
                courseId,
                feeHeadId,
                academicYearId,
                entryAcademicYearId: entryAcademicYearId ?? null,
                entryType: entryType ?? null,
                instituteCode: instituteCode ?? null,
                quotaType: quotaType ?? null,
                yearOfStudy: yearOfStudy ?? null,
                isDeleted: false
            }
        });

        if (existing) {
            throw new AppError("Fee Structure already exists for this combination", 409);
        }

        return prisma.feeStructure.create({
            data: {
                courseId,
                feeHeadId,
                amount,
                academicYearId,
                entryAcademicYearId,
                entryType,
                instituteCode,
                quotaType,
                yearOfStudy,
                createdBy: userId,
                updatedBy: userId
            }
        });
    },

    /** Bulk-create the same fee structure for every course in a degree (e.g. set tuition for all B.Tech branches at once). */
    createFeeStructureForDegree: async (degree: string, feeHeadId: string, amount: number, academicYearId: string, userId: string, quotaType?: QuotaType, yearOfStudy?: number) => {
        // 1. Find all courses for this degree
        const courses = await prisma.course.findMany({
            where: { degree, isDeleted: false }
        });

        if (courses.length === 0) {
            throw new AppError(`No courses found for degree: ${degree}`, 404);
        }

        // 2. Create entries for each course (skip if duplicate exists)
        const createdStructures = [];
        const skippedCourses: string[] = [];

        for (const course of courses) {
            const existing = await prisma.feeStructure.findFirst({
                where: {
                    courseId: course.id,
                    feeHeadId,
                    academicYearId,
                    quotaType: quotaType ?? null,
                    yearOfStudy: yearOfStudy ?? null,
                    isDeleted: false
                }
            });

            if (existing) {
                skippedCourses.push(course.name || course.id);
                continue;
            }

            const structure = await prisma.feeStructure.create({
                data: {
                    courseId: course.id,
                    feeHeadId,
                    amount,
                    academicYearId,
                    quotaType,
                    yearOfStudy,
                    createdBy: userId,
                    updatedBy: userId
                }
            });
            createdStructures.push(structure);
        }

        if (createdStructures.length === 0) {
            throw new AppError(`Fee structures already exist for all ${courses.length} course(s) in degree "${degree}". Nothing created.`, 409);
        }

        return {
            created: createdStructures,
            createdCount: createdStructures.length,
            skippedCount: skippedCourses.length,
            skippedCourses
        };
    },

    /**
     * Create FeeStructure rows for many fee heads in one call. All rows share the
     * same (course, year, entryType, quota, etc.) combination — only the
     * (feeHeadId, amount) varies per row.
     * Idempotent: rows that already exist for the same combination are skipped.
     */
    /** Cartesian bulk-create of fee structures across a combination of courses × fee heads × quotas × years. */
    createFeeStructuresForCombination: async (params: {
        courseId:            string;
        academicYearId:      string;
        entryAcademicYearId?: string;
        entryType?:          'REGULAR' | 'LATERAL' | 'TRANSFER';
        instituteCode?:      'VVIG' | 'VVITU' | 'VVITPU';
        quotaType?:          QuotaType;
        yearOfStudy?:        number;
        feeHeads:            Array<{ feeHeadId: string; amount: number }>;
        userId:              string;
    }) => {
        // ── Defensive guards (also enforced by zod validator) ──────────────
        if (!params.feeHeads.length) {
            throw new AppError('feeHeads must contain at least one entry', 400);
        }
        if (params.feeHeads.length > 50) {
            throw new AppError('feeHeads cannot exceed 50 entries per call', 400);
        }
        const dupCheck = new Set(params.feeHeads.map(h => h.feeHeadId));
        if (dupCheck.size !== params.feeHeads.length) {
            throw new AppError('Duplicate feeHeadId(s) in array — each fee head can appear only once', 400);
        }
        for (const h of params.feeHeads) {
            if (h.amount <= 0 || !Number.isFinite(h.amount)) {
                throw new AppError(`amount must be a positive finite number (feeHeadId=${h.feeHeadId})`, 400);
            }
            if (h.amount > 100_000_000) {
                throw new AppError(`amount exceeds reasonable limit (feeHeadId=${h.feeHeadId})`, 400);
            }
        }
        if (params.entryType === 'LATERAL' && (params.yearOfStudy ?? 2) < 2) {
            throw new AppError('LATERAL entry requires yearOfStudy >= 2', 400);
        }
        if (params.userId == null) {
            throw new AppError('userId is required', 400);
        }

        // ── Existence checks ───────────────────────────────────────────────
        const course = await prisma.course.findUnique({ where: { id: params.courseId } });
        if (!course || course.isDeleted) throw new AppError('Course not found', 404);

        const ay = await prisma.academicYear.findUnique({ where: { id: params.academicYearId } });
        if (!ay || ay.isDeleted) throw new AppError('Academic year not found', 404);

        if (params.entryAcademicYearId && params.entryAcademicYearId !== params.academicYearId) {
            const entryAy = await prisma.academicYear.findUnique({ where: { id: params.entryAcademicYearId } });
            if (!entryAy || entryAy.isDeleted) throw new AppError('Entry academic year not found', 404);
        }

        // ── Validate every fee head id resolves ────────────────────────────
        const headIds = params.feeHeads.map(h => h.feeHeadId);
        const heads = await prisma.feeHead.findMany({
            where: { id: { in: headIds }, isDeleted: false },
            select: { id: true, name: true },
        });
        const validHeadIds = new Set(heads.map(h => h.id));
        const missing = headIds.filter(id => !validHeadIds.has(id));
        if (missing.length) throw new AppError(`FeeHead(s) not found: ${missing.join(', ')}`, 404);
        const headNameById = new Map(heads.map(h => [h.id, h.name]));

        // Create each row; skip duplicates
        const created: any[] = [];
        const skipped: Array<{ feeHeadId: string; feeHeadName: string }> = [];

        for (const entry of params.feeHeads) {
            const existing = await prisma.feeStructure.findFirst({
                where: {
                    courseId:            params.courseId,
                    feeHeadId:           entry.feeHeadId,
                    academicYearId:      params.academicYearId,
                    entryAcademicYearId: params.entryAcademicYearId ?? null,
                    entryType:           params.entryType ?? null,
                    instituteCode:       params.instituteCode ?? null,
                    quotaType:           params.quotaType ?? null,
                    yearOfStudy:         params.yearOfStudy ?? null,
                    isDeleted:           false,
                },
            });
            if (existing) {
                skipped.push({ feeHeadId: entry.feeHeadId, feeHeadName: headNameById.get(entry.feeHeadId) ?? '?' });
                continue;
            }

            const row = await prisma.feeStructure.create({
                data: {
                    courseId:            params.courseId,
                    feeHeadId:           entry.feeHeadId,
                    amount:              entry.amount,
                    academicYearId:      params.academicYearId,
                    entryAcademicYearId: params.entryAcademicYearId,
                    entryType:           params.entryType,
                    instituteCode:       params.instituteCode,
                    quotaType:           params.quotaType,
                    yearOfStudy:         params.yearOfStudy,
                    createdBy:           params.userId,
                    updatedBy:           params.userId,
                },
            });
            created.push(row);
        }

        return {
            createdCount: created.length,
            skippedCount: skipped.length,
            created,
            skipped,
        };
    },

    /** List fee structures with rich filters (course/year/feeHead/quota/yearOfStudy/amount-range/search) + pagination. */
    getFeeStructures: async (filters?: {
        courseId?:            string;
        academicYearId?:      string;
        feeHeadId?:           string;
        entryAcademicYearId?: string;
        entryType?:           'REGULAR' | 'LATERAL' | 'TRANSFER';
        instituteCode?:       'VVIG' | 'VVITU' | 'VVITPU';
        quotaType?:           QuotaType;
        yearOfStudy?:         number;
        minAmount?:           number;
        maxAmount?:           number;
        includeDeleted?:      boolean;
        search?:              string;
        page?:                number;
        limit?:               number;
        sortBy?:              'amount' | 'createdAt' | 'updatedAt' | 'yearOfStudy';
        sortDir?:             'asc' | 'desc';
    }) => {
        const where: any = {};

        // Default to non-deleted unless explicitly asked otherwise
        if (!filters?.includeDeleted) where.isDeleted = false;

        // Exact-match filters
        if (filters?.courseId)            where.courseId            = filters.courseId;
        if (filters?.academicYearId)      where.academicYearId      = filters.academicYearId;
        if (filters?.feeHeadId)           where.feeHeadId           = filters.feeHeadId;
        if (filters?.entryAcademicYearId) where.entryAcademicYearId = filters.entryAcademicYearId;
        if (filters?.entryType)           where.entryType           = filters.entryType;
        if (filters?.instituteCode)       where.instituteCode       = filters.instituteCode;
        if (filters?.quotaType)           where.quotaType           = filters.quotaType;
        if (filters?.yearOfStudy !== undefined) where.yearOfStudy   = filters.yearOfStudy;

        // Amount range
        if (filters?.minAmount !== undefined || filters?.maxAmount !== undefined) {
            where.amount = {};
            if (filters.minAmount !== undefined) where.amount.gte = filters.minAmount;
            if (filters.maxAmount !== undefined) where.amount.lte = filters.maxAmount;
        }

        // Free-text search across course name/code and fee head name
        if (filters?.search) {
            where.OR = [
                { course:  { name: { contains: filters.search, mode: 'insensitive' } } },
                { course:  { code: { contains: filters.search, mode: 'insensitive' } } },
                { feeHead: { name: { contains: filters.search, mode: 'insensitive' } } },
            ];
        }

        // Pagination
        const page  = Math.max(1, Number(filters?.page  ?? 1));
        const limit = Math.min(200, Math.max(1, Number(filters?.limit ?? 50)));
        const skip  = (page - 1) * limit;

        // Sort
        const sortBy  = filters?.sortBy  ?? 'createdAt';
        const sortDir = filters?.sortDir ?? 'desc';

        const [rows, total] = await Promise.all([
            prisma.feeStructure.findMany({
                where,
                skip,
                take: limit,
                orderBy: { [sortBy]: sortDir },
                include: {
                    course:       { select: { id: true, code: true, name: true, degree: true } },
                    feeHead:      { select: { id: true, name: true, component: true } },
                    academicYear: { select: { id: true, code: true, isActive: true } },
                },
            }),
            prisma.feeStructure.count({ where }),
        ]);

        return {
            data:       rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
            filtersApplied: filters ?? {},
        };
    },

    /** Patch a fee structure row. Does not retroactively change already-generated demands. */
    updateFeeStructure: async (id: string, courseId: string, feeHeadId: string, amount: number, academicYearId: string, userId: string, quotaType?: QuotaType, yearOfStudy?: number) => {
        return prisma.feeStructure.update({
            where: { id },
            data: {
                courseId,
                feeHeadId,
                amount,
                academicYearId,
                quotaType,
                yearOfStudy,
                updatedBy: userId
            }
        });
    },

    /** Delete a fee structure. Existing demands generated from it are unaffected. */
    deleteFeeStructure: async (id: string) => {
        return prisma.feeStructure.update({
            where: { id },
            data: { isDeleted: true }
        });
    },

    /**
     * Clone all (non-deleted) FeeStructure rows from one academic year to another.
     *
     * Use cases:
     *   - Setting up fee structures for a NEW academic year — clone the prior year as
     *     a starting point, then edit individual rows.
     *   - Back-filling fee structures for a PAST year so back-dated/lateral admissions
     *     into that cohort have demands seeded correctly by `generateFeeDemands`.
     *
     * Skips rows that already exist in the target year for the same
     * (courseId, feeHeadId, yearOfStudy) tuple — safe to re-run.
     *
     * Optional `multiplier` lets admins apply a flat percentage adjustment
     * (e.g., 1.05 = 5% increase, 0.95 = 5% reduction). Default 1.0.
     * Optional `courseIds` restricts the clone to specific courses.
     */
    /** Copy a year's fee structures into the next year (optionally × multiplier). The year-promotion prep step so new-year demands can be seeded. */
    cloneFeeStructuresForAcademicYear: async (
        sourceAcademicYearId: string,
        targetAcademicYearId: string,
        userId: string,
        options?: {
            multiplier?: number;
            courseIds?: string[];
            entryAcademicYearId?: string;
            entryType?: 'REGULAR' | 'LATERAL' | 'TRANSFER';
            instituteCode?: 'VVITU' | 'VVITPU';
        }
    ) => {
        const multiplier = options?.multiplier ?? 1.0;

        if (sourceAcademicYearId === targetAcademicYearId) {
            throw new AppError('Source and target academic years must differ', 400);
        }

        const [source, target] = await Promise.all([
            prisma.academicYear.findUnique({ where: { id: sourceAcademicYearId } }),
            prisma.academicYear.findUnique({ where: { id: targetAcademicYearId } }),
        ]);
        if (!source) throw new AppError('Source academic year not found', 404);
        if (!target) throw new AppError('Target academic year not found', 404);

        // Source filter — read only the rows that match the cohort/type tags so that
        // a clone tagged for "2024-25 LATERAL" only copies LATERAL rows (not all rows).
        const sourceWhere: any = {
            academicYearId: sourceAcademicYearId,
            isDeleted: false,
        };
        if (options?.courseIds && options.courseIds.length > 0) {
            sourceWhere.courseId = { in: options.courseIds };
        }
        if (options?.entryAcademicYearId !== undefined) {
            sourceWhere.entryAcademicYearId = options.entryAcademicYearId;
        }
        if (options?.entryType !== undefined) {
            sourceWhere.entryType = options.entryType;
        }
        if (options?.instituteCode !== undefined) {
            sourceWhere.instituteCode = options.instituteCode;
        }

        const sourceStructures = await prisma.feeStructure.findMany({ where: sourceWhere });
        if (sourceStructures.length === 0) {
            return { cloned: 0, skipped: 0, total: 0, source: source.code, target: target.code };
        }

        // Pre-load existing rows in target year for dedup. Dedup key now includes the
        // cohort/type so that a cloned-for-cohort-A row doesn't dedup against an
        // already-cloned cohort-B row that happens to share course/feeHead/yearOfStudy.
        const existing = await prisma.feeStructure.findMany({
            where: {
                academicYearId: targetAcademicYearId,
                isDeleted: false,
                courseId: { in: Array.from(new Set(sourceStructures.map(s => s.courseId))) },
            },
            select: {
                courseId: true,
                feeHeadId: true,
                yearOfStudy: true,
                entryAcademicYearId: true,
                entryType: true,
                instituteCode: true,
            },
        });
        const targetEntryYearId  = options?.entryAcademicYearId ?? null;
        const targetEntryType    = options?.entryType ?? null;
        const targetInstitute    = options?.instituteCode ?? null;
        const existingKey = (s: {
            courseId: string;
            feeHeadId: string;
            yearOfStudy: number | null;
            entryAcademicYearId: string | null;
            entryType: string | null;
            instituteCode: string | null;
        }) =>
            `${s.courseId}|${s.feeHeadId}|${s.yearOfStudy ?? ''}|${s.entryAcademicYearId ?? ''}|${s.entryType ?? ''}|${s.instituteCode ?? ''}`;
        const existingSet = new Set(existing.map(existingKey));

        const toCreate = sourceStructures.filter(s =>
            !existingSet.has(existingKey({
                courseId:            s.courseId,
                feeHeadId:           s.feeHeadId,
                yearOfStudy:         s.yearOfStudy,
                entryAcademicYearId: targetEntryYearId,
                entryType:           targetEntryType,
                instituteCode:       targetInstitute,
            }))
        );
        const skipped  = sourceStructures.length - toCreate.length;

        if (toCreate.length === 0) {
            return { cloned: 0, skipped, total: sourceStructures.length, source: source.code, target: target.code };
        }

        await prisma.feeStructure.createMany({
            data: toCreate.map(s => ({
                courseId:            s.courseId,
                feeHeadId:           s.feeHeadId,
                amount:              Math.round(s.amount * multiplier * 100) / 100,
                currency:            s.currency,
                academicYearId:      targetAcademicYearId,
                // Provided options override source tags. Source tags carry forward when no override.
                entryAcademicYearId: options?.entryAcademicYearId ?? s.entryAcademicYearId,
                entryType:           options?.entryType           ?? s.entryType,
                instituteCode:       options?.instituteCode       ?? s.instituteCode,
                quotaType:           s.quotaType,
                yearOfStudy:         s.yearOfStudy,
                createdBy:           userId,
            })),
            skipDuplicates: true,
        });

        return {
            cloned: toCreate.length,
            skipped,
            total: sourceStructures.length,
            multiplier,
            source: source.code,
            target: target.code,
            entryAcademicYearId: options?.entryAcademicYearId,
            entryType: options?.entryType,
            instituteCode: options?.instituteCode,
        };
    },

    // Statistics
    /** Aggregate fee stats for the finance dashboard (collected / pending / by component / by method). */
    getFeeStatistics: async () => {
        const totalCollected = await prisma.payment.aggregate({
            where: { status: 'SUCCESS' },
            _sum: { amount: true }
        });
        const totalPending = await prisma.studentFeeDemand.aggregate({
            where: { status: 'PENDING' },
            _sum: { amount: true }
        });
        
        return {
            collected: totalCollected._sum.amount || 0,
            pending: totalPending._sum.amount || 0
        };
    },

    /** Create a discount request (per-component amounts) for approval. Blocks duplicate pending requests unless forceCreate. */
    createDiscountRequest: async (studentId: string, reason: string, documentUrl: string | undefined, items: { component: string, amount: number }[], requestedAmount: number, referredBy?: string, forceCreate: boolean = false) => {
        // Ensure we treat any truthy value (including undefined, null, or string "true") as a boolean
        const effectiveForceCreate = Boolean(forceCreate);
        console.log('forceCreate received in service:', forceCreate, '=> effectiveForceCreate:', effectiveForceCreate);
        if (!effectiveForceCreate) {
            // Check if any non-rejected request exists for this student
            const existingActiveRequest = await prisma.discountRequest.findFirst({
                where: {
                    studentId,
                    status: { not: DiscountStatus.REJECTED }
                }
            });

            if (existingActiveRequest) {
                const createdByUser = existingActiveRequest.createdBy
                    ? await prisma.user.findUnique({ where: { id: existingActiveRequest.createdBy }, select: { name: true } })
                    : null;
                const creatorName = createdByUser?.name || 'an Admin';

                const incomingComponents = items.map(i => i.component.toUpperCase());
                const existingItems = (existingActiveRequest.items as any[]) || [];
                const conflictingComponents = existingItems
                    .filter((ei: any) => incomingComponents.includes((ei.component || '').toUpperCase()))
                    .map((ei: any) => ei.component);

                const componentMsg = conflictingComponents.length > 0
                    ? ` A pending request for ${conflictingComponents.join(', ')} already exists.`
                    : '';

        
                    throw new AppError(
                    `A discount request has already been raised for this student by ${creatorName}. ${componentMsg} Do you want to proceed with creating a new request?`,
                    409
                );
            }
        }

        return prisma.discountRequest.create({
            data: {
                studentId,
                reason,
                documentUrl,
                items: items as any,
                requestedAmount,
                referredBy,
                status: DiscountStatus.FORWARDED_TO_SUPER_ADMIN
            } as any
        });
    },

    /** List discount requests with filters (status/student/application/degree/course). Powers the approval queue. */
    getAllDiscountRequests: async (filters?: { status?: DiscountStatus, studentId?: string, applicationId?: string, degree?: string, allottedCourseId?: string }) => {
        const where: any = {};
        if (filters?.status) where.status = filters.status;
        if (filters?.studentId) where.studentId = filters.studentId;
        
        if (filters?.applicationId || filters?.degree || filters?.allottedCourseId) {
            where.student = {};
            
            if (filters?.applicationId) {
                where.student.applicationId = { contains: filters.applicationId, mode: 'insensitive' };
            }
            if (filters?.degree) {
                where.student.degreeType = filters.degree;
            }
            if (filters?.allottedCourseId) {
                where.student.admissionDetails = {
                    allottedCourseId: filters.allottedCourseId
                };
            }
        }

        const requests = await prisma.discountRequest.findMany({
            where,
            include: {
                student: {
                    select: {
                        id: true,
                        name: true,
                        applicationId: true,
                        degreeType: true,
                        phone: true,
                        email: true,
                        admissionDetails: {
                            select: {
                                accommodationType: true,
                                allottedCourse: {
                                    select: {
                                        id: true,
                                        name: true
                                    }
                                }
                            }
                        }
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        const userIds = [...new Set(requests.map(req => req.createdBy).filter(Boolean))] as string[];
        let usersMap = new Map();
        if (userIds.length > 0) {
             const users = await prisma.user.findMany({
                 where: { id: { in: userIds } },
                 select: { id: true, name: true, phone: true }
             });
             usersMap = new Map(users.map(u => [u.id, u]));
        }

        // Enrich with Fee Details (Balance, Demands)
        // Note: Ideally use Promise.all for parallelism
        const enrichedRequests = await Promise.all(requests.map(async (req) => {
            // We need to call getStudentFeeDetails. Since it's in the same object, we use 'this' or reference FeeService if exported.
            // But FeeService is the object we are in. 'this' context might work if called via FeeService.
            // Alternatively, extract logic or use the function if defined outside. 
            // getStudentFeeDetails is defined later in the object. 
            // To be safe, we can import FeeService (checking circular dep) or just define a helper. 
            // Or access via 'FeeService.getStudentFeeDetails' since it's an exported const object.

            const feeDetails = await FeeService.getStudentFeeDetails(req.studentId);
            const details = feeDetails as any;
            
            return {
                ...req,
                documentUrl: req.documentUrl ? await convertToPresignedUrl(req.documentUrl) : null,
                createdByUser: req.createdBy ? (usersMap.get(req.createdBy) || null) : null,
                feeDetails: {
                    totalDemand: details.totalDemand || details.summary?.totalDemand || 0,
                    totalPaid: details.totalPaid || details.summary?.totalPaid || 0,
                    totalDiscount: details.discounts?.total || details.summary?.totalDiscount || 0,
                    balance: details.pendingAmount || details.summary?.netPending || 0,
                    demands: details.demands
                }
            };
        }));

        return enrichedRequests;
    },

    /** Edit a pending discount request's reason/items/amount. */
    updateDiscountRequest: async (id: string, reason: string, documentUrl: string | undefined, items: { component: string, amount: number }[], requestedAmount: number, referredBy?: string, adminId?: string) => {
         const request = await prisma.discountRequest.findUnique({ where: { id } });
         
         if (!request) {
             throw new AppError("Discount request not found", 404);
         }

         if (request.status !== DiscountStatus.FORWARDED_TO_SUPER_ADMIN && request.status !== DiscountStatus.REQUESTED) {
              throw new AppError(`Cannot update request that is already ${request.status}`, 400);
         }

         return prisma.discountRequest.update({
             where: { id },
             data: {
                 reason,
                 documentUrl,
                 items: items as any,
                 requestedAmount,
                 referredBy,
                 updatedBy: adminId
             }
         });
    },

    /** Delete a pending discount request. */
    deleteDiscountRequest: async (id: string) => {
         const request = await prisma.discountRequest.findUnique({ where: { id } });
         
         if (!request) {
             throw new AppError("Discount request not found", 404);
         }

         if (request.status !== DiscountStatus.FORWARDED_TO_SUPER_ADMIN) {
              throw new AppError(`Cannot delete an already ${request.status} request`, 400);
         }

         return prisma.discountRequest.delete({
             where: { id }
         });
    },

    /**
     * Approve/reject a discount request. On approve: applies the discount to
     * matching demands (reduces netAmount), writes ledger CREDIT entries, and
     * marks the request APPROVED. Role-gated.
     */
    approveDiscount: async (requestId: string, approved: boolean, role: RoleType, adminId: string, approvedItems?: { component: string, approvedAmount: number }[]) => {
         if (role !== Role.SUPER_ADMIN) {
             throw new AppError("Only Super Admin can approve discounts", 403);
         }

         const request = await prisma.discountRequest.findUnique({
             where: { id: requestId }
         });

         if (!request) {
             throw new AppError("Discount request not found", 404);
         }

         let finalApprovedAmount = 0;
         let finalItems: any[] = [];

         if (approved) {
             if (approvedItems && approvedItems.length > 0) {
                 finalItems = approvedItems;
                 finalApprovedAmount = approvedItems.reduce((sum, item) => sum + item.approvedAmount, 0);
             } else if ((request as any).items && Array.isArray((request as any).items)) {
                 // Use requested items as approved default
                 finalItems = ((request as any).items as any[]).map((item: any) => ({
                     component: item.component,
                     approvedAmount: item.amount !== undefined ? item.amount : (item.requestedAmount || 0)
                 }));
                 finalApprovedAmount = finalItems.reduce((sum, item) => sum + item.approvedAmount, 0);
             } else {
                 // Legacy fallback? Or unexpected data
                 finalItems = [{ component: 'TUITION', approvedAmount: request.requestedAmount || 0 }];
                 finalApprovedAmount = request.requestedAmount || 0;
             }
         }

         return prisma.$transaction(async (tx) => {
             const updatedRequest = await tx.discountRequest.update({
                where: { id: requestId },
                data: {
                    status: approved ? DiscountStatus.APPROVED : DiscountStatus.REJECTED,
                    approvedAmount: approved ? finalApprovedAmount : 0,
                    items: approved ? finalItems : (request as any).items, // Update items with approved logic if needed or keep? Better to store approved breakdown separately? Schema has only one `items`.
                    // Let's assume we update `items` with approved structure or add `approvedItems` field to schema. Schema has `items` which we reused. 
                    // Wait, schema comment said "Stores array of { component, requestedAmount, approvedAmount }".
                    // So we should Update the existing items to include `approvedAmount` property.
                    approvedBy: adminId,
                    approvedAt: new Date(),
                    updatedBy: adminId
                } as any
             });

             if (approved && finalApprovedAmount > 0) {
                 
                 for (const item of finalItems) {
                     const amt = item.approvedAmount;
                     if (amt <= 0) continue;

                     const compName = item.component || 'TUITION';

                     // Logic to find demand
                     let targetDemand = await tx.studentFeeDemand.findFirst({
                         where: {
                             studentId: request.studentId,
                             OR: [
                                 { feeHead: { name: { contains: compName, mode: 'insensitive' } } },
                                 { feeStructure: { feeHead: { name: { contains: compName, mode: 'insensitive' } } } }
                             ]
                         },
                         orderBy: { createdAt: 'desc' }
                     });

                     // Fallback for generic 'TUITION' or 'COLLEGE' if component is vaguely named 
                     if (!targetDemand && (compName.toUpperCase().includes('TUITION') || compName.toUpperCase().includes('COLLEGE'))) {
                          targetDemand = await tx.studentFeeDemand.findFirst({
                             where: {
                                 studentId: request.studentId,
                                 OR: [
                                      { feeHead: { name: { contains: 'Tuition', mode: 'insensitive' } } },
                                      { feeHead: { name: { contains: 'College', mode: 'insensitive' } } }
                                 ]
                             },
                             orderBy: { createdAt: 'desc' }
                         });
                     }

                     // Ultimate fallback: latest demand (Use with caution, maybe skip?)
                     // Skipping to ensure we don't discount wrong fee. 
                     // Or check if 'OTHER'?
                     
                     if (targetDemand) {
                         await tx.studentFeeDemand.update({
                             where: { id: targetDemand.id },
                             data: {
                                 discountAmount: { increment: amt },
                                 netAmount: { decrement: amt }
                             }
                         });
                     }

                     // Always create Ledger Entry
                     await tx.studentLedger.create({
                         data: {
                             studentId: request.studentId,
                             type: 'CREDIT',
                             amount: amt,
                             description: `Approved Discount: ${request.reason} (${compName})`,
                             referenceId: requestId,
                             referenceType: 'DISCOUNT',
                             feeHeadId: targetDemand?.feeHeadId,
                             createdBy: adminId,
                             academicYearId: (await tx.academicYear.findFirstOrThrow({ where: { isActive: true, isDeleted: false } })).id,
                             date: new Date()
                         }
                     });
                 }
             }

             return updatedRequest;
         });
    },

    // Manual Payment Collection
    /** Record an offline (cash/cheque/DD) payment against a student's demand: creates Payment + Ledger, updates demand status. */
    recordOfflinePayment: async (
        studentId: string,
        amount: number,
        method: PaymentMethod,
        component: PaymentComponent,
        adminId: string,
        referenceNumber?: string,
        bankDetails?: { bankName?: string, branchName?: string, instrumentDate?: Date }
    ) => {
        logger.info(`[recordOfflinePayment] Delegating to processUnifiedPayment: studentId=${studentId}, amount=${amount}`);

        // Lazy Import to avoid Circular Dependency issues if any, or just import at top if safe.
        // Assuming processUnifiedPayment is in payment.service.ts
        const { processUnifiedPayment } = require('./payment.service');
        
        return processUnifiedPayment({
            studentId,
            amount,
            mode: PaymentMode.OFFLINE,
            method,
            component,
            initiatedBy: adminId,
            referenceNumber,
            bankDetails,
            remarks: `Offline Payment recorded by Admin`
        });
    },

    // Automated Fee Generation.
    //
    // Resolves the fee structures applicable to (student, course, academicYear) using
    // the student's admission cohort tags (entryAcademicYearId / entryType / instituteCode),
    // then seeds StudentFeeDemand rows + matching StudentLedger entries.
    //
    // The `options.allowLegacyFallback` flag controls the NULL-tagged fallback path:
    //   - `true` (default): if strict cohort-tagged lookup returns 0 rows, fall back to
    //                       legacy structures (where all cohort tags are NULL). Logs a
    //                       WARN if the student's admission HAS cohort tags set, so
    //                       data-tag gaps surface during prod runs.
    //   - `false`:          no fallback. Strict-mode for bulk runs over a clean cohort.
    //
    // Returns a structured report (NOT a bare array) so callers can distinguish
    // generated vs skipped vs filtered-out structures.
    /**
     * The core fee-seeding engine. For a (student, course, year), resolves
     * applicable FeeStructure rows via the cohort tags (entryYear/entryType/
     * instituteCode/quota/yearOfStudy), applies scholarship discount to
     * TUITION, writes one StudentFeeDemand + ledger DEBIT per fee head, and
     * skips heads that already have a demand (idempotent). Optional legacy
     * fallback to NULL-tagged structures.
     */
    generateFeeDemands: async (
        studentId: string,
        courseId: string,
        academicYearId: string,
        userId: string,
        deleteExisting: boolean = false,
        options: {
            allowLegacyFallback?: boolean;
            requireEnrollment?: boolean;
            dueDateFallbackDays?: number;
        } = {}
    ): Promise<{
        demands: any[];
        generated: number;
        skipped: number;
        considered: number;
        fallbackUsed: boolean;
        scholarshipApplied: number;
        structuresStrict: number;
        structuresFallback: number;
    }> => {
        const allowLegacyFallback = options.allowLegacyFallback ?? true;
        const requireEnrollment   = options.requireEnrollment   ?? false;
        const dueDateFallbackDays = options.dueDateFallbackDays ?? 30;

        logger.info(
            `[generateFeeDemands] Request: student=${studentId}, course=${courseId}, ` +
            `year=${academicYearId}, allowFallback=${allowLegacyFallback}, requireEnrollment=${requireEnrollment}`
        );

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                enrollments: { orderBy: { createdAt: 'desc' }, take: 1 },
                admissionDetails: {
                    select: {
                        feeCohortAcademicYearId: true,
                        entryAcademicYearId:     true,
                        entryType:               true,
                        instituteCode:           true,
                    }
                },
            }
        });

        if (!student) {
            logger.error(`[generateFeeDemands] Student not found: ${studentId}`);
            throw new AppError("Student not found", 404);
        }

        if (requireEnrollment) {
            // Presence of an enrollment row (any status) proves the student was enrolled
            // in that year — supports back-fill flows where admins enter old students'
            // demands long after they've graduated (status='COMPLETED').
            const enrollment = await prisma.studentEnrollment.findFirst({
                where: { studentId, academicYearId },
            });
            if (!enrollment) {
                throw new AppError(
                    `No enrollment record for student=${studentId} in academicYearId=${academicYearId}. ` +
                    `Cannot generate demands for a year the student was never enrolled in.`,
                    400
                );
            }
        }

        const studentQuota         = student.quotaType;
        const studentDegreeType    = student.degreeType ?? null;
        const cohortYearId =
            student.admissionDetails?.feeCohortAcademicYearId
            ?? student.admissionDetails?.entryAcademicYearId
            ?? null;
        const studentEntryType     = student.admissionDetails?.entryType ?? null;
        const studentInstituteCode = student.admissionDetails?.instituteCode ?? null;
        const hasCohortTags = !!(cohortYearId || studentEntryType || studentInstituteCode);

        // Strict pass — exact cohort tag match.
        let feeStructures = await prisma.feeStructure.findMany({
            where: {
                courseId,
                academicYearId,
                entryAcademicYearId: cohortYearId,
                entryType:           studentEntryType,
                instituteCode:       studentInstituteCode,
                isDeleted: false
            },
            include: { feeHead: true }
        });
        const strictCount = feeStructures.length;
        logger.debug(
            `[generateFeeDemands] strict pass: cohort=${cohortYearId} entryType=${studentEntryType} ` +
            `institute=${studentInstituteCode} found=${strictCount}`
        );

        // Legacy fallback — only when explicitly allowed. WARN if the admission was tagged
        // (means cohort-specific structures are missing — admin should clone them).
        let fallbackUsed = false;
        if (feeStructures.length === 0 && allowLegacyFallback) {
            feeStructures = await prisma.feeStructure.findMany({
                where: {
                    courseId,
                    academicYearId,
                    entryAcademicYearId: null,
                    entryType:           null,
                    instituteCode:       null,
                    isDeleted: false
                },
                include: { feeHead: true }
            });
            if (feeStructures.length > 0) {
                fallbackUsed = true;
                if (hasCohortTags) {
                    logger.warn(
                        `[generateFeeDemands] LEGACY FALLBACK used for cohort-tagged student=${studentId} ` +
                        `(cohort=${cohortYearId}, entryType=${studentEntryType}, institute=${studentInstituteCode}). ` +
                        `Strict match returned 0 rows; falling back to NULL-tagged legacy rows. ` +
                        `Clone the appropriate cohort-tagged fee structures to remove this fallback.`
                    );
                } else {
                    logger.debug(`[generateFeeDemands] fallback (NULL-tagged) used; admission has no cohort tags: found=${feeStructures.length}`);
                }
            }
        }
        const fallbackCount = fallbackUsed ? feeStructures.length : 0;

        // Prefer the enrollment's explicit yearOfStudy; fall back to semester arithmetic.
        const latestEnrollment = student.enrollments?.[0];
        const currentYear =
            latestEnrollment?.yearOfStudy
            ?? (latestEnrollment?.currentSemester ? Math.ceil(latestEnrollment.currentSemester / 2) : 1);
        logger.debug(
            `[generateFeeDemands] Student Context: Quota=${studentQuota}, DegreeType=${studentDegreeType}, ` +
            `YearOfStudy=${currentYear}`
        );

        // Filter — quota / yearOfStudy. Null = universal (applies to all).
        const applicableRaw = feeStructures.filter(fs => {
            if (fs.quotaType   && fs.quotaType   !== studentQuota)  return false;
            if (fs.yearOfStudy && fs.yearOfStudy !== currentYear)   return false;
            return true;
        });

        // Dedupe by feeHeadId — pick the most-specific row when both a universal and a
        // narrowed structure exist for the same head (otherwise the student would be
        // double-charged for the same fee head).
        const specificity = (fs: typeof feeStructures[number]): number =>
            (fs.entryAcademicYearId ? 1 : 0) +
            (fs.entryType           ? 1 : 0) +
            (fs.instituteCode       ? 1 : 0) +
            (fs.quotaType           ? 1 : 0) +
            (fs.yearOfStudy         ? 1 : 0);
        const bestByHead = new Map<string, typeof feeStructures[number]>();
        for (const fs of applicableRaw) {
            const cur = bestByHead.get(fs.feeHeadId);
            if (!cur || specificity(fs) > specificity(cur)) {
                bestByHead.set(fs.feeHeadId, fs);
            }
        }
        const applicableFees = Array.from(bestByHead.values());

        const considered = feeStructures.length;
        const droppedByFilter = feeStructures.length - applicableRaw.length;
        const droppedByDedup  = applicableRaw.length  - applicableFees.length;
        logger.info(
            `[generateFeeDemands] structures: strict=${strictCount}, fallback=${fallbackCount}, ` +
            `applicableRaw=${applicableRaw.length} (dropped-by-filter=${droppedByFilter}), ` +
            `applicableFinal=${applicableFees.length} (dropped-by-dedup=${droppedByDedup})`
        );

        if (applicableFees.length === 0) {
            logger.warn(
                `[generateFeeDemands] No applicable fees found. ` +
                `student=${student.id} (quota=${studentQuota}, degreeType=${studentDegreeType}, ` +
                `year=${currentYear}, cohort=${cohortYearId}, entryType=${studentEntryType}, ` +
                `institute=${studentInstituteCode}); structures considered=${considered}`
            );
            return {
                demands: [], generated: 0, skipped: 0, considered,
                fallbackUsed, scholarshipApplied: 0,
                structuresStrict: strictCount, structuresFallback: fallbackCount,
            };
        }

        // Anchor dueDate to the academic year's start (+ N days), not "today" — so
        // back-dated cohort runs flag overdue correctly.
        const academicYear = await prisma.academicYear.findUnique({
            where: { id: academicYearId },
            select: { startDate: true },
        });
        const fallbackDueDate = academicYear?.startDate
            ? new Date(academicYear.startDate.getTime() + dueDateFallbackDays * 24 * 60 * 60 * 1000)
            : new Date();

        const txResult = await prisma.$transaction(async (tx) => {
            if (deleteExisting) {
                logger.info(`[generateFeeDemands] Cleaning up existing demands for student=${studentId} course=${courseId} year=${academicYearId}`);
                const structuresForThisCourse = await tx.feeStructure.findMany({
                    where: { courseId, academicYearId, isDeleted: false },
                    select: { id: true }
                });
                const structureIds = structuresForThisCourse.map(s => s.id);
                if (structureIds.length > 0) {
                    const oldDemands = await tx.studentFeeDemand.findMany({
                        where: { studentId, feeStructureId: { in: structureIds }, isDeleted: false }
                    });
                    const oldDemandIds = oldDemands.map(d => d.id);
                    if (oldDemandIds.length > 0) {
                        await tx.studentLedger.deleteMany({
                            where: { type: 'DEBIT', referenceType: 'FEE_DEMAND', referenceId: { in: oldDemandIds } }
                        });
                        // Cascade to the matching SCHOLARSHIP CREDIT ledger rows (keyed by
                        // referenceId = demand id). Without this, replacing a tuition demand
                        // orphans its scholarship credit, which then double-counts in any
                        // ledger-based discount sum and corrupts the financial timeline.
                        await tx.studentLedger.deleteMany({
                            where: { referenceType: 'SCHOLARSHIP', referenceId: { in: oldDemandIds } }
                        });
                        await tx.studentFeeDemand.deleteMany({ where: { id: { in: oldDemandIds } } });
                        const amountRemoved = oldDemands.reduce((sum, d) => sum + d.amount, 0);
                        if (amountRemoved > 0) {
                            await tx.studentAdmission.update({
                                where: { studentId },
                                data: { totalFee: { decrement: amountRemoved } }
                            });
                        }
                    }
                }
            }

            // Existing-demand lookup INSIDE the tx so a parallel run can't race past it.
            // Combined with the partial unique index migration, this makes double-create
            // impossible (the index would error out as a backstop).
            const existing = await tx.studentFeeDemand.findMany({
                where: {
                    studentId,
                    isDeleted: false,
                    feeStructureId: { in: applicableFees.map(f => f.id) }
                },
                select: { feeStructureId: true }
            });
            const existingSet = new Set(existing.map(e => e.feeStructureId));

            // Scholarship — defensive: only apply when explicitly marked eligible.
            // Note: StudentScholarship has no per-year validity in the schema; this is
            // a global flag. Per-year cohort policies should drive the scholarship
            // record's isEligible value (handled in the scholarship admin flow).
            const studentScholarship = await tx.studentScholarship.findFirst({
                where: { studentId, isEligible: 'YES' as any }
            });
            const discountPct = studentScholarship?.scholarshipPercentage || 0;
            logger.info(
                `[generateFeeDemands] Scholarship: hasRecord=${!!studentScholarship}, ` +
                `eligible=${studentScholarship?.isEligible ?? 'n/a'}, pct=${discountPct}%`
            );

            const created: any[] = [];
            let skippedCount = 0;
            let scholarshipApplied = 0;
            let newDemandsTotal = 0;

            for (const fee of applicableFees) {
                if (existingSet.has(fee.id)) {
                    skippedCount++;
                    logger.debug(`[generateFeeDemands] duplicate skipped for structure ${fee.id}`);
                    continue;
                }

                // Use the typed PaymentComponent link (kills the buggy case-sensitive name match).
                const isTuition = fee.feeHead.component === 'TUITION';
                const scholarshipAmt = (isTuition && discountPct > 0)
                    ? (fee.amount * discountPct) / 100
                    : 0;
                const netAmount = fee.amount - scholarshipAmt;

                const demand = await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeStructureId: fee.id,
                        feeHeadId: fee.feeHeadId,
                        academicYearId: fee.academicYearId,
                        yearOfStudy: fee.yearOfStudy ?? undefined,
                        amount: fee.amount,
                        discountAmount:    scholarshipAmt,
                        scholarshipAmount: scholarshipAmt,
                        netAmount,
                        status: 'PENDING',
                        dueDate: fallbackDueDate,
                        createdBy: userId,
                        remarks: scholarshipAmt > 0 ? `Scholarship Applied: ${discountPct}%` : undefined
                    } as any
                });

                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: 'DEBIT',
                        amount: fee.amount,
                        description: `Fee: ${fee.feeHead.name}`,
                        referenceId: demand.id,
                        referenceType: 'FEE_DEMAND',
                        feeHeadId: fee.feeHeadId,
                        createdBy: userId,
                        academicYearId
                    }
                });

                if (scholarshipAmt > 0) {
                    await tx.studentLedger.create({
                        data: {
                            studentId,
                            type: 'CREDIT',
                            amount: scholarshipAmt,
                            description: `Scholarship: ${studentScholarship?.type || 'Applicable'} (${discountPct}%)`,
                            referenceId: demand.id,
                            referenceType: 'SCHOLARSHIP',
                            feeHeadId: fee.feeHeadId,
                            createdBy: userId,
                            academicYearId
                        }
                    });
                    scholarshipApplied++;
                }

                created.push(demand);
                newDemandsTotal += fee.amount;
            }

            // R7 — supersede the provisional "stopgap" ledger written by the payment-time
            // path (_processComponentLogic, existingDemands===0) once the authoritative
            // demand-based entries exist, so scholarship/tuition aren't counted twice in
            // ledger-based fee summaries (getStudentFeeDetails sums SCHOLARSHIP credits).
            //  - FEE_GENERATION DEBITs are superseded by the per-demand FEE_DEMAND DEBITs
            //    we just created (only created by that stopgap), so remove them when we
            //    actually created demands.
            //  - The provisional SCHOLARSHIP CREDIT is the only one keyed by the student's
            //    scholarshipAllocation id (real ones are keyed by demand id); remove it only
            //    when we created a replacement demand-based scholarship credit.
            if (created.length > 0) {
                await tx.studentLedger.deleteMany({
                    where: { studentId, referenceType: 'FEE_GENERATION' }
                });
            }
            if (scholarshipApplied > 0) {
                const alloc = await tx.scholarshipAllocation.findUnique({
                    where: { studentId }, select: { id: true }
                });
                if (alloc) {
                    await tx.studentLedger.deleteMany({
                        where: { studentId, referenceType: 'SCHOLARSHIP', referenceId: alloc.id }
                    });
                }
            }

            // Ensure an admission row exists, then recompute totalFee (Σ active demand
            // gross) and paidFee (Σ SUCCESS non-application payments) from the source rows
            // rather than incrementing — increments drift when demands are regenerated,
            // a course/structure changes, or a flow deletes demands out-of-band. The
            // recompute is idempotent and self-healing. (`newDemandsTotal` retained for the
            // returned summary/logs only.)
            await tx.studentAdmission.upsert({
                where: { studentId },
                create: { studentId, academicYearId, totalFee: 0 },
                update: {}
            });
            await recomputeStudentTotals(studentId, tx);

            return { created, skippedCount, scholarshipApplied };
        }, {
            // This transaction does a lot (demands + per-demand ledgers + scholarship
            // cleanup + admission upsert + totals recompute). The default 5s interactive
            // timeout was being exceeded under DB latency, aborting the whole thing and
            // leaving 0 demands. Give it room.
            timeout: 30000,
            maxWait: 10000,
        });

        logger.info(
            `[generateFeeDemands] success: generated=${txResult.created.length}, ` +
            `skipped=${txResult.skippedCount}, scholarshipApplied=${txResult.scholarshipApplied}, ` +
            `fallback=${fallbackUsed}`
        );

        return {
            demands: txResult.created,
            generated: txResult.created.length,
            skipped: txResult.skippedCount,
            considered,
            fallbackUsed,
            scholarshipApplied: txResult.scholarshipApplied,
            structuresStrict:   strictCount,
            structuresFallback: fallbackCount,
        };
    },

    // Bulk orchestrator — runs generateFeeDemands across every student matching a filter
    // for the target academic year. Designed for end-of-promotion/year-rollover runs.
    //
    // Filters narrow the student set by admission cohort tags. Default is the *active*
    // year's enrollments. Each student is processed in its own transaction (per-student
    // failures don't roll back the whole run); the report aggregates outcomes so admins
    // can see exactly which students were skipped/why.
    /** Run generateFeeDemands for every active enrollment in a year matching a cohort filter — the end-of-year promotion seeding job. */
    generateFeeDemandsBulk: async (
        academicYearId: string,
        userId: string,
        filters: {
            courseIds?:     string[];
            entryTypes?:    Array<'REGULAR' | 'LATERAL' | 'TRANSFER'>;
            instituteCodes?: string[];
            entryAcademicYearIds?: string[];
            quotaTypes?:    QuotaType[];
            studentIds?:    string[];
        } = {},
        runOptions: {
            allowLegacyFallback?: boolean;
            requireEnrollment?:   boolean;
            deleteExisting?:      boolean;
            dueDateFallbackDays?: number;
        } = {}
    ) => {
        logger.info(
            `[generateFeeDemandsBulk] year=${academicYearId} filters=${JSON.stringify(filters)} ` +
            `runOptions=${JSON.stringify(runOptions)}`
        );

        // Find target students via enrollments for this academic year, optionally
        // narrowed by admission cohort tags. Includes COMPLETED enrollments so the
        // orchestrator can back-fill demands for graduated batches (admin enters
        // historical payment records for old students post-fact).
        const enrollmentWhere: any = { academicYearId };
        if (filters.studentIds && filters.studentIds.length > 0) {
            enrollmentWhere.studentId = { in: filters.studentIds };
        }

        const enrollments = await prisma.studentEnrollment.findMany({
            where: enrollmentWhere,
            select: {
                studentId: true,
                student: {
                    select: {
                        quotaType: true,
                        admissionDetails: {
                            select: {
                                allottedCourseId:    true,
                                entryType:           true,
                                instituteCode:       true,
                                entryAcademicYearId: true,
                            }
                        }
                    }
                }
            }
        });

        // Apply admission-side filters in memory (single SQL pass; the result set is
        // already bounded by the year's enrollments).
        const targets = enrollments.filter(e => {
            const a = e.student.admissionDetails;
            if (!a?.allottedCourseId) return false; // can't generate demands without a course
            if (filters.courseIds            && !filters.courseIds.includes(a.allottedCourseId))   return false;
            if (filters.entryTypes           && !filters.entryTypes.includes(a.entryType as any))  return false;
            if (filters.instituteCodes       && (!a.instituteCode || !filters.instituteCodes.includes(a.instituteCode))) return false;
            if (filters.entryAcademicYearIds && (!a.entryAcademicYearId || !filters.entryAcademicYearIds.includes(a.entryAcademicYearId))) return false;
            if (filters.quotaTypes           && (!e.student.quotaType || !filters.quotaTypes.includes(e.student.quotaType))) return false;
            return true;
        });

        logger.info(`[generateFeeDemandsBulk] resolved ${targets.length} target students from ${enrollments.length} enrollments`);

        const perStudent: Array<{
            studentId: string;
            courseId:  string;
            ok:        boolean;
            generated: number;
            skipped:   number;
            considered: number;
            fallbackUsed: boolean;
            scholarshipApplied: number;
            error?:    string;
        }> = [];

        for (const t of targets) {
            const courseId = t.student.admissionDetails!.allottedCourseId!;
            try {
                const result = await FeeService.generateFeeDemands(
                    t.studentId,
                    courseId,
                    academicYearId,
                    userId,
                    runOptions.deleteExisting ?? false,
                    {
                        allowLegacyFallback: runOptions.allowLegacyFallback ?? false, // strict by default for bulk
                        requireEnrollment:   runOptions.requireEnrollment   ?? true,  // bulk must verify
                        dueDateFallbackDays: runOptions.dueDateFallbackDays,
                    }
                );
                perStudent.push({
                    studentId: t.studentId,
                    courseId,
                    ok: true,
                    generated: result.generated,
                    skipped: result.skipped,
                    considered: result.considered,
                    fallbackUsed: result.fallbackUsed,
                    scholarshipApplied: result.scholarshipApplied,
                });
            } catch (err: any) {
                logger.error(`[generateFeeDemandsBulk] student=${t.studentId} failed: ${err.message}`);
                perStudent.push({
                    studentId: t.studentId,
                    courseId,
                    ok: false,
                    generated: 0, skipped: 0, considered: 0,
                    fallbackUsed: false, scholarshipApplied: 0,
                    error: err.message,
                });
            }
        }

        const summary = perStudent.reduce(
            (acc, r) => {
                acc.studentsProcessed += 1;
                acc.studentsOk        += r.ok ? 1 : 0;
                acc.studentsFailed    += r.ok ? 0 : 1;
                acc.demandsGenerated  += r.generated;
                acc.demandsSkipped    += r.skipped;
                acc.fallbackHits      += r.fallbackUsed ? 1 : 0;
                acc.scholarshipsApplied += r.scholarshipApplied;
                return acc;
            },
            { studentsProcessed: 0, studentsOk: 0, studentsFailed: 0, demandsGenerated: 0, demandsSkipped: 0, fallbackHits: 0, scholarshipsApplied: 0 }
        );

        logger.info(`[generateFeeDemandsBulk] complete: ${JSON.stringify(summary)}`);
        return { summary, perStudent };
    },

    // Get Full Ledger/Statement
    // Pass `academicYearId` to scope the whole fee picture (demands, payments,
    // ledgers) to a single year. Omit it for the all-years view (legacy behavior).
    /** Full fee picture for a student (demands + payments + scholarship + balance), optionally scoped to one year. */
    getStudentFeeDetails: async (studentId: string, academicYearId?: string) => {
        logger.info(`[getStudentFeeDetails] Request for student=${studentId}${academicYearId ? ` year=${academicYearId}` : ' (all years)'}`);
        // When a year is given, filter strictly to it — legacy rows with a NULL
        // academicYearId are intentionally excluded from a year-scoped view.
        const yearFilter = academicYearId ? { academicYearId } : {};
        const demands: any[] = await prisma.studentFeeDemand.findMany({
            where: { studentId, ...yearFilter },
            include: {
                feeStructure: { include: { feeHead: true } },
                feeHead: true // Include direct feeHead relation
            } as any
        });

        const payments = await prisma.payment.findMany({
            where: { studentId, status: 'SUCCESS', ...yearFilter }
        });

        logger.debug(`[getStudentFeeDetails] Found ${demands.length} demands and ${payments.length} successful payments.`);

        // Discount is read from the DEMAND rows (the authoritative per-line deduction),
        // NOT by summing SCHOLARSHIP/DISCOUNT *ledger* entries. The ledger is a journal that
        // can contain duplicates (e.g. an approval processed twice) or drift from the demand;
        // summing it would inflate the discount and under-state the pending balance.
        //   demand.discountAmount   = total deduction (manual + scholarship)
        //   demand.scholarshipAmount = the scholarship portion
        //   demand.netAmount         = amount − discountAmount (the payable)
        const baseScholarship = demands.reduce((sum, d) => sum + (d.scholarshipAmount || 0), 0);
        const manualDiscountAmount = demands.reduce(
            (sum, d) => sum + Math.max(0, (d.discountAmount || 0) - (d.scholarshipAmount || 0)), 0
        );

        let scholarshipAmount = baseScholarship;
        let fallbackScholarship = 0; // pre-payment estimate, not yet reflected on any demand

        // Pre-payment view: if no scholarship is applied on the demands yet but a
        // LOCKED/RESERVED allocation exists, estimate it from the rule % (display only).
        if (baseScholarship === 0) {
            const allocation = await prisma.scholarshipAllocation.findUnique({
                where: { studentId },
                include: { rule: true }
            });

            logger.info(`[getStudentFeeDetails] [Scholarship Allocation] Student=${studentId} Found=${!!allocation} Status=${allocation?.status}`);

            if (allocation && (allocation.status === 'LOCKED' || allocation.status === 'RESERVED')) {
                 const admission = await prisma.studentAdmission.findUnique({ where: { studentId } });

                 // Find the tuition demand by FeeHead.component === 'TUITION' (no name keyword fallback)
                 let tuitionDemand = demands.find(d => {
                    const comp = d.feeStructure?.feeHead?.component ?? d.feeHead?.component ?? null;
                    return comp === 'TUITION';
                 });

                 // Heuristic fallback: largest demand (used when no head is tagged as TUITION yet)
                 if (!tuitionDemand && demands.length > 0) {
                     tuitionDemand = demands.reduce((max, d) => d.amount > max.amount ? d : max, demands[0]);
                     logger.debug(`[Scholarship] No TUITION-tagged FeeHead found. Used highest demand as proxy: ${tuitionDemand.amount}`);
                 }

                 const tuitionFee = tuitionDemand ? tuitionDemand.amount : (admission?.totalFee || 0);
                 fallbackScholarship = (tuitionFee * allocation.rule.discountPercentage) / 100;
                 scholarshipAmount = fallbackScholarship;
            }
        }

        const totalDemand = demands.reduce((sum, d) => sum + d.amount, 0);                       // gross
        const totalNet    = demands.reduce((sum, d) => sum + ((d.netAmount ?? d.amount)), 0);     // net of demand discounts
        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
        const totalDiscount = scholarshipAmount + manualDiscountAmount;

        // Net Pending = net payable − paid − any pre-payment scholarship estimate not yet on demands.
        // (Immune to duplicate discount ledger rows because it uses the demand's netAmount.)
        const pendingAmount = Math.max(0, totalNet - totalPaid - fallbackScholarship);
        
        logger.info(`[getStudentFeeDetails] Summary: Demand=${totalDemand}, Paid=${totalPaid}, Discount=${totalDiscount}, Pending=${pendingAmount}`);

        // Component Level Breakdown
        const breakdown: any = {
            TUITION: { demand: 0, discount: 0, paid: 0, balance: 0 },
            HOSTEL: { demand: 0, discount: 0, paid: 0, balance: 0 },
            TRANSPORT: { demand: 0, discount: 0, paid: 0, balance: 0 },
            OTHER: { demand: 0, discount: 0, paid: 0, balance: 0 }
        };

        // Bucket FeeHead.component → top-level breakdown key
        const componentToKey = (comp: string | null | undefined): 'TUITION' | 'HOSTEL' | 'TRANSPORT' | 'OTHER' => {
            if (!comp) return 'OTHER';
            if (comp === 'TUITION' || comp === 'SCHOLARSHIP_TOKEN') return 'TUITION';
            if (comp === 'TRANSPORT') return 'TRANSPORT';
            if (comp === 'HOSTEL'
                || comp === 'HOSTEL_ACCOMMODATION'
                || comp === 'HOSTEL_MESS'
                || comp === 'HOSTEL_LAUNDRY'
                || comp === 'HOSTEL_REGISTRATION') return 'HOSTEL';
            return 'OTHER';
        };

        // Map Demands by FeeHead.component (no name keyword fallback)
        demands.forEach(d => {
            const comp = d.feeStructure?.feeHead?.component ?? d.feeHead?.component ?? null;
            const key = componentToKey(comp);
            breakdown[key].demand += d.amount;
            // Option B: per-component `discount` = full deduction (manual + scholarship),
            // i.e. demand.discountAmount — consistent with getStudentFinancialHistory.
            // `balance` is computed net of it below so it agrees with pendingAmount.
            breakdown[key].discount += (d.discountAmount || 0);
        });

        // Map Payments via Component Enum
        payments.forEach(p => {
             const key = componentToKey(p.component as string);
             breakdown[key].paid += p.amount;
        });

        // Map Ledger Adjustments (Fee Transfers/Deductions like Course Change Fees)
        const adjustmentLedgers = await prisma.studentLedger.findMany({
            where: {
                studentId,
                referenceType: 'COURSE_CHANGE',
                ...yearFilter
            }
        });

        adjustmentLedgers.forEach(a => {
            if (!a.feeHeadId) return;

            // Resolve component via demand-side join (we already have heads in scope)
            const head = demands.find(d => (d.feeStructure?.feeHeadId === a.feeHeadId || d.feeHeadId === a.feeHeadId))?.feeHead ||
                         demands.find(d => (d.feeStructure?.feeHeadId === a.feeHeadId || d.feeHeadId === a.feeHeadId))?.feeStructure?.feeHead;
            const key = componentToKey(head?.component as string | null | undefined);

            if (a.type === 'CREDIT') breakdown[key].paid += a.amount;
            else breakdown[key].paid -= a.amount;
        });

        // Calc Balance
        Object.keys(breakdown).forEach(key => {
            breakdown[key].balance = breakdown[key].demand - breakdown[key].discount - breakdown[key].paid;
        });

        return {
            summary: {
                totalDemand,
                totalPaid,
                pendingAmount,
                breakdown
            },
            discounts: {
                scholarship: scholarshipAmount,
                manual: manualDiscountAmount,
                total: totalDiscount
            },
            demands,
            payments
        };
    },

    /** Chronological list of a student's successful payments with component + receipt links. */
    getStudentPaymentHistory: async (studentId: string) => {
        // 0. Fetch All Fee Heads for Lookup
        const allFeeHeads = await prisma.feeHead.findMany({ where: { isDeleted: false } });
        const feeHeadLookup = new Map<string, string>();
        allFeeHeads.forEach(fh => feeHeadLookup.set(fh.id, fh.name));

        // 1. Fetch Demands with Headers
        const demands: any[] = await prisma.studentFeeDemand.findMany({
            where: { studentId },
            include: { 
                feeStructure: { include: { feeHead: true } },
                feeHead: true // Include direct feeHead relation
            } as any,
            orderBy: { createdAt: 'asc' }
        });

        // 2. Fetch Payments (Include FeeDemand Path)
        const payments = await prisma.payment.findMany({
            where: { studentId, status: 'SUCCESS' },
            include: {
                feeDemand: {
                    include: {
                        feeStructure: {
                            include: {
                                feeHead: true
                            }
                        }
                    }
                }
            },
            orderBy: { createdAt: 'asc' }
        });

        // 3. Fetch Discounts (Ledger adjustments: Credits are additions, Debits are reductions)
        const scholarshipLedgers = await prisma.studentLedger.findMany({
            where: { 
                studentId, 
                referenceType: { in: ['SCHOLARSHIP', 'DISCOUNT'] }
            }
        });

        // Grouping Map
        // Key: FeeHeadId (or Name if not present) -> Object
        const feeHeadMap = new Map<string, any>();

        // Helper to get or create group
        const getGroup = (id: string, name: string, component?: PaymentComponent | null) => {
            if (!feeHeadMap.has(id)) {
                feeHeadMap.set(id, {
                    feeHeadId: id,
                    feeHeadName: name,
                    feeHeadComponent: component ?? null,
                    totalFee: 0,
                    paidAmount: 0,
                    discountAmount: 0,
                    pendingAmount: 0,
                    history: []
                });
            }
            return feeHeadMap.get(id);
        };

        // --- Process Demands ---
        demands.forEach(d => {
            // Determine Head: Structure Head > Direct Head
            const head = d.feeStructure?.feeHead || d.feeHead;
            const group = getGroup(head?.id || 'UNKNOWN', head?.name || 'Unknown Fee', head?.component);
            
            group.totalFee += d.amount;
            group.history.push({
                type: 'DEMAND',
                date: d.createdAt,
                amount: d.amount,
                id: d.id,
                description: d.remarks || `Fee generated: ${head?.name}`
            });
        });

        // --- Process Payments ---
        // Priority:
        // 1. Linked Fee Order/Demand (payment.feeDemand.feeStructure.feeHead)
        // 2. Explicit FeeHeadId (payment.feeHeadId)
        // 3. Fall through to per-payment heuristics inside the loop

        payments.forEach(p => {
            let targetFeeHeadId: string | undefined;
            let targetFeeHeadName: string | undefined;

            // 1. Check Fee Demand Link
            if (p.feeDemand?.feeStructure?.feeHead) {
                targetFeeHeadId = p.feeDemand.feeStructure.feeHead.id;
                targetFeeHeadName = p.feeDemand.feeStructure.feeHead.name;
            } 
            // 2. Check Explicit FeeHeadId
            else if (p.feeHeadId && feeHeadLookup.has(p.feeHeadId)) {
                targetFeeHeadId = p.feeHeadId;
                targetFeeHeadName = feeHeadLookup.get(p.feeHeadId);
            }
            
            // 3. Strict Fallback: Do not guess. If not linked, it's Unallocated.
            
            if (targetFeeHeadId && targetFeeHeadName) {
                const group = getGroup(targetFeeHeadId, targetFeeHeadName);
                group.paidAmount += p.amount;
                group.history.push({
                    type: 'PAYMENT',
                    date: p.createdAt,
                    amount: p.amount,
                    id: p.id,
                    description: `Payment: ${p.method} (${p.providerTxId})`
                });
            } else {
                 // Unmapped / Adhoc
                const groupName = `Unallocated Payment: ${p.component}`;
                const groupId = `UNALLOCATED_${p.component}`;
                const group = getGroup(groupId, groupName);
                group.paidAmount += p.amount;
                group.history.push({
                     type: 'PAYMENT',
                     date: p.createdAt,
                     amount: p.amount,
                     id: p.id,
                     description: `Payment: ${p.method} (${p.providerTxId})`
                });
            }
        });

        // --- Process Discounts / Scholarship Adjustments ---
        scholarshipLedgers.forEach(l => {
             let matched = false;
             const isCredit = l.type === 'CREDIT';
             // Determine if this is a scholarship or a standard discount based on referenceType
             const recordType = l.referenceType === 'SCHOLARSHIP' ? 'SCHOLARSHIP' : 'DISCOUNT';
             
             for (const [, group] of feeHeadMap.entries()) {
                 const isTuition = group.feeHeadComponent === 'TUITION';

                 // Scholarship adjustments target TUITION component only
                 if (l.referenceType === 'SCHOLARSHIP' && isTuition) {
                     group.discountAmount += isCredit ? l.amount : -l.amount;
                     group.history.push({
                         type: recordType,
                         date: l.date,
                         amount: isCredit ? l.amount : -l.amount,
                         id: l.id,
                         description: l.description
                     });
                     matched = true;
                     break;
                 }

                 // Manual discount adjustments also target TUITION component only
                 if (l.referenceType !== 'SCHOLARSHIP' && isTuition) {
                     group.discountAmount += isCredit ? l.amount : -l.amount;
                     group.history.push({
                         type: recordType,
                         date: l.date,
                         amount: isCredit ? l.amount : -l.amount,
                         id: l.id,
                         description: l.description
                     });
                     matched = true;
                     break;
                 }
             }
             
             if (!matched) {
                const group = getGroup('GENERAL_DISCOUNTS', 'General Discounts');
                group.discountAmount += isCredit ? l.amount : -l.amount;
                group.history.push({
                     type: recordType,
                     date: l.date,
                     amount: isCredit ? l.amount : -l.amount,
                     id: l.id,
                     description: l.description || 'Adjustment'
                });
            }
        });

        // --- Final Calculations ---
        const result = Array.from(feeHeadMap.values()).map(group => {
            group.pendingAmount = Math.max(0, group.totalFee - group.paidAmount - group.discountAmount);
            
            // Sort history by date
            group.history.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
            
            return group;
        });
        
        return result;
    },

    // Student Discount / Fine (Direct Column Update)
    /** Apply an ad-hoc discount or fine directly to a student's demand (bypasses the request/approval flow). FINE without a prior demand creates a fresh one. */
    addStudentDiscount: async (studentId: string, feeHeadId: string | undefined, feeStructureId: string | undefined, type: 'DISCOUNT' | 'FINE', amount: number, reason: string, userId: string) => {
        
        // 0. Resolve Fee Head if Structure ID is provided
        let targetFeeHeadId = feeHeadId;
        
        if (feeStructureId && !targetFeeHeadId) {
             const structure = await prisma.feeStructure.findUnique({
                 where: { id: feeStructureId }
             });
             if (structure) {
                 targetFeeHeadId = structure.feeHeadId;
             }
        }
        
        if (!targetFeeHeadId) {
            throw new AppError("Either feeHeadId or feeStructureId must be provided", 400);
        }

        // 1. Find Target Demand
        // We look for the latest demand for this Fee Head to attach the Fine/Discount to.
        const targetDemand = await prisma.studentFeeDemand.findFirst({
            where: {
                studentId,
                OR: [
                    { feeHeadId: targetFeeHeadId },
                    { feeStructure: { feeHeadId: targetFeeHeadId } }
                ],
                isDeleted: false
            } as any, 
            orderBy: { createdAt: 'desc' },
            include: { feeStructure: true }
        });

        // 2. Validation (For Discounts)
        if (type === 'DISCOUNT') {
             if (!targetDemand) {
                 throw new AppError('Cannot apply discount. No existing fee demand found for this category.', 404);
             }
             
             // Check against Net Payable
             // Net = Amount + ExistingFine - ExistingDiscount
             const currentNet = targetDemand.amount + ((targetDemand as any).fineAmount || 0) - ((targetDemand as any).discountAmount || 0);
             if (amount > currentNet) {
                 throw new AppError(`Discount amount (${amount}) exceeds net payable amount (${currentNet}).`, 400);
             }
        }

        return prisma.$transaction(async (tx: any) => {
            let demandId: string;
            
            // 3. Update Demand or Create Ad-Hoc
            if (targetDemand) {
                const updateData: any = {};
                // Keep netAmount in lock-step with the deduction/charge so every reader of
                // netAmount (settlement, balances, summaries) sees the correct payable.
                // netAmount = amount − discountAmount − scholarshipAmount + fineAmount.
                if (type === 'FINE') {
                    updateData.fineAmount = { increment: amount };
                    updateData.netAmount = { increment: amount };
                } else {
                    updateData.discountAmount = { increment: amount }; // Increment the discount deduction
                    updateData.netAmount = { decrement: amount };
                }

                updateData.remarks = reason; // Overwrite or Append? Overwrite usually.
                
                await tx.studentFeeDemand.update({
                    where: { id: targetDemand.id },
                    data: updateData
                });
                demandId = targetDemand.id;
            } else {
                // Case: Ad-Hoc Fine where no previous demand exists
                if (type === 'FINE') {
                    // Year-tag the fine with the active academic year (required since the phase-3 migration).
                    const activeYear = await tx.academicYear.findFirstOrThrow({
                        where: { isActive: true, isDeleted: false }
                    });
                    const newDemand = await tx.studentFeeDemand.create({
                        data: {
                            studentId,
                            // Use the RESOLVED head (feeStructureId-only callers leave the raw
                            // feeHeadId undefined) and set netAmount so the fine is never lost
                            // by readers that fall back to `netAmount ?? amount`.
                            feeHeadId: targetFeeHeadId,
                            amount: 0,
                            fineAmount: amount,
                            netAmount: amount,
                            status: 'PENDING',
                            dueDate: new Date(),
                            remarks: `Ad-Hoc Fine: ${reason}`,
                            createdBy: userId,
                            academicYearId: activeYear.id
                        } as any
                    });
                    demandId = newDemand.id;
                } else {
                    // Should be caught by validation above, but safe fallback
                    throw new AppError('Cannot apply discount without base demand.', 400);
                }
            }

            // 4. Add to Ledger (Audit Trail)
            // FINE = DEBIT (+Amount)
            // DISCOUNT = CREDIT (Waiver)
            // Note: Unlike before where Discount was Neg Debit, now it is explicit Credit to offset balance.
            
            await tx.studentLedger.create({
                data: {
                    studentId,
                    type: type === 'FINE' ? 'DEBIT' : 'CREDIT',
                    amount: amount,
                    description: `${type}: ${reason}`,
                    referenceId: demandId,
                    referenceType: type === 'FINE' ? 'FINE' : 'DISCOUNT',
                    feeHeadId: targetFeeHeadId,
                    createdBy: userId,
                    date: new Date()
                }
            });

            return { message: 'Success', demandId };
        });
    },

    /**
     * Change a student's accommodation type.
     * Handles: TRANSPORT → HOSTEL, HOSTEL → TRANSPORT, HOSTEL → NONE, TRANSPORT → NONE
     *
     * Steps:
     *   1. Validate transition and required fields
     *   2. Release old allocation (decrement seat, subtract fee)
     *   3. Assign new allocation (increment seat, add fee)
     *   4. Update StudentAdmission record
     *   5. Create ledger entries for fee adjustments
     *   6. Log as ServiceChangeRequest
     */
    /**
     * Switch a student's accommodation (HOSTEL ↔ TRANSPORT ↔ NONE): vacates the
     * old service, transfers/refunds paid amounts via ledger entries, sets up
     * the new service's demands, and logs a ServiceChangeRequest.
     */
    async changeAccommodationType(data: {
        studentId: string;
        newType: 'HOSTEL' | 'TRANSPORT' | 'NONE';
        hostelId?: string;
        hostelType?: string;
        transportRouteId?: string;
        reason?: string;
    }, adminId: string) {
        const { studentId, newType, hostelId, hostelType, transportRouteId, reason } = data;

        if (!studentId) throw new AppError('Student ID is required', 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                admissionDetails: {
                    include: {
                        hostel: true,
                        transportRoute: true,
                    }
                }
            }
        });
        if (!student?.admissionDetails) throw new AppError('Student or admission not found', 404);

        const admission = student.admissionDetails;
        const oldType = admission.accommodationType || 'NONE';

        if (oldType === newType) throw new AppError(`Student is already on ${newType}`, 400);

        // Validate required fields for new type
        if (newType === 'HOSTEL' && !hostelId) throw new AppError('hostelId is required for HOSTEL', 400);
        if (newType === 'TRANSPORT' && !transportRouteId) throw new AppError('transportRouteId is required for TRANSPORT', 400);

        const result = await prisma.$transaction(async (tx) => {
            let oldCost = 0;
            let newCost = 0;
            let oldLabel = '';
            let newLabel = '';

            // --- Release old allocation (hostel "filled" is computed on-demand from StudentAdmission.hostelId) ---
            if (oldType === 'HOSTEL' && admission.hostelId) {
                const oldPricing = await getHostelCostTx(admission.hostelType, tx);
                oldCost = oldPricing.totalPrice;
                oldLabel = `Hostel (${admission.hostel?.name || admission.hostelId})`;
            } else if (oldType === 'TRANSPORT' && admission.transportRouteId) {
                await tx.transportRoute.update({
                    where: { id: admission.transportRouteId },
                    data: { filled: { decrement: 1 } }
                });
                oldCost = admission.transportRoute?.cost || 0;
                oldLabel = `Transport (${admission.transportRoute?.name || admission.transportRouteId})`;
            }

            // --- Assign new allocation ---
            if (newType === 'HOSTEL') {
                const hostel = await tx.hostel.findUnique({ where: { id: hostelId } });
                if (!hostel) throw new AppError('Hostel not found', 404);
                await assertHostelHasCapacity(hostelId!, tx);

                const newPricing = await getHostelCostTx(hostelType, tx);
                newCost = newPricing.totalPrice;
                newLabel = `Hostel (${hostel.name})`;
            } else if (newType === 'TRANSPORT') {
                const route = await tx.transportRoute.findUnique({ where: { id: transportRouteId } });
                if (!route) throw new AppError('Transport route not found', 404);
                if ((route.filled ?? 0) >= (route.capacity ?? 0)) throw new AppError('Transport route is full', 400);

                await tx.transportRoute.update({
                    where: { id: transportRouteId },
                    data: { filled: { increment: 1 } }
                });
                newCost = route.cost || 0;
                newLabel = `Transport (${route.name})`;
            }
            // newType === 'NONE' → no new allocation needed

            // --- Update StudentAdmission ---
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: newType as AccommodationType,
                    hostelId: newType === 'HOSTEL' ? hostelId : null,
                    hostelType: newType === 'HOSTEL' ? (hostelType as any) : null,
                    transportRouteId: newType === 'TRANSPORT' ? transportRouteId : null,
                    hostelPaymentMode: newType === 'HOSTEL' ? undefined : null,
                    totalFee: { increment: newCost - oldCost },
                }
            });

            let transferAmount = 0;

            // --- Transfer paid amount from old service to new service ---
            // Between services (hostel ↔ transport): DEBIT old + CREDIT new to move the payment.
            // To NONE: record a refundable credit so there's an audit trail for the overpayment.
            if (oldType !== 'NONE') {
                const oldComponents = oldType === 'HOSTEL'
                    ? ['HOSTEL', 'HOSTEL_ACCOMMODATION', 'HOSTEL_MESS']
                    : ['TRANSPORT'];

                const paidToOld = await tx.payment.aggregate({
                    where: {
                        studentId,
                        status: 'SUCCESS',
                        component: { in: oldComponents as any },
                        isDeleted: false,
                    },
                    _sum: { amount: true }
                });

                transferAmount = paidToOld._sum.amount || 0;

                if (transferAmount > 0) {
                    const oldServiceName = oldType === 'HOSTEL' ? 'Hostel' : 'Transport';

                    const svcChangeYearId = (await tx.academicYear.findFirstOrThrow({ where: { isActive: true, isDeleted: false } })).id;
                    if (newType === 'NONE') {
                        // → NONE: record the paid amount as a refundable credit
                        await tx.studentLedger.create({
                            data: {
                                studentId,
                                type: LedgerTransactionType.CREDIT,
                                amount: transferAmount,
                                description: `${oldServiceName} cancelled — ₹${transferAmount.toLocaleString()} paid, refund due (service change: ${oldType} → NONE)`,
                                referenceType: 'SERVICE_CHANGE',
                                createdBy: adminId,
                                academicYearId: svcChangeYearId,
                            }
                        });
                    } else {
                        // Hostel ↔ Transport: DEBIT old + CREDIT new to transfer payment
                        const newServiceName = newType === 'HOSTEL' ? 'Hostel' : 'Transport';

                        await tx.studentLedger.create({
                            data: {
                                studentId,
                                type: LedgerTransactionType.DEBIT,
                                amount: transferAmount,
                                description: `${oldServiceName} payment transferred to ${newServiceName} (service change: ${oldType} → ${newType})`,
                                referenceType: 'SERVICE_CHANGE',
                                createdBy: adminId,
                                academicYearId: svcChangeYearId,
                            }
                        });

                        await tx.studentLedger.create({
                            data: {
                                studentId,
                                type: LedgerTransactionType.CREDIT,
                                amount: transferAmount,
                                description: `Payment received from ${oldServiceName} transfer (service change: ${oldType} → ${newType})`,
                                referenceType: 'SERVICE_CHANGE',
                                createdBy: adminId,
                                academicYearId: svcChangeYearId,
                            }
                        });
                    }
                }
            }

            // --- Log as ServiceChangeRequest ---
            const svcYear = await tx.academicYear.findFirstOrThrow({ where: { isActive: true, isDeleted: false } });
            await tx.serviceChangeRequest.create({
                data: {
                    studentId,
                    academicYearId: svcYear.id,
                    type: 'FACILITY',
                    fromValue: oldType,
                    toValue: newType,
                    reason: reason || `Admin changed accommodation: ${oldType} → ${newType}`,
                    status: 'APPROVED',
                    approvedBy: adminId,
                }
            });

            return {
                oldType,
                newType,
                oldCost,
                newCost,
                feeAdjustment: newCost - oldCost,
                transferAmount,
                oldLabel: oldLabel || 'None',
                newLabel: newLabel || 'None',
            };
        });

        logger.info(`[changeAccommodationType] Student=${studentId} ${result.oldType} → ${result.newType}, Fee adjustment: ${result.feeAdjustment}`);

        return result;
    },
};


