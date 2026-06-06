import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { SystemSetting, DiscountStatus, PaymentMethod, PaymentComponent, PaymentMode, QuotaType, AccommodationType, LedgerTransactionType, AdmissionEntryType, FeeCorrectionType, FeeStatus, PaymentStatus, Prisma } from '@prisma/client';
import { Role, RoleType } from '../../constants/roles';
import logger from '../../utils/logger';
import { convertToPresignedUrl } from '../../utils/s3Utils';
import { getHostelCostTx } from '../../utils/hostelPricing';
import { assertHostelHasCapacity } from '../accommodation/hostel/hostel.service';
import { recomputeStudentTotals, assertAcademicYearWritable, getStudentYearOfStudy } from '../../utils/studentContext';

const APP_FEE_KEY = 'APPLICATION_FEE_AMOUNT';
const DEFAULT_APP_FEE = '500';

export const getApplicationFeeAmount = async (): Promise<number> => {
    const setting = await prisma.systemSetting.findUnique({
        where: { key: APP_FEE_KEY }
    });
    return parseInt(setting?.value || DEFAULT_APP_FEE, 10);
};

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

    createFeeHead: async (name: string, description: string, userId: string, component?: PaymentComponent) => {
        return prisma.feeHead.create({
            data: { name, description, component: component ?? null, createdBy: userId, updatedBy: userId }
        });
    },

    getFeeHeads: async () => {
        return prisma.feeHead.findMany({ where: { isDeleted: false } });
    },

    getCourseFeeHeads: async (courseId: string, academicYearId?: string, entryType?: AdmissionEntryType, instituteCode?: string) => {
        const where: any = { isDeleted: false, courseId };
        if (academicYearId) where.academicYearId = academicYearId;
        if (entryType) where.entryType = entryType;
        if (instituteCode) where.instituteCode = instituteCode;

        const feeStructures = await prisma.feeStructure.findMany({
            where,
            include: {
                feeHead: true,
                academicYear: true
            }
        });

        const course = await prisma.course.findUnique({ where: { id: courseId } });
        if (!course) throw new AppError('Course not found', 404);

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

        const yearsById = new Map<string, { id: string; code: string }>();
        feeStructures.forEach((fs: any) => {
            if (fs.academicYear) yearsById.set(fs.academicYear.id, { id: fs.academicYear.id, code: fs.academicYear.code });
        });
        const distinctYears = Array.from(yearsById.values());
        const resolvedYear = academicYearId
            ? (yearsById.get(academicYearId) ?? null)
            : (distinctYears.length === 1 ? distinctYears[0] : null);

        return {
            courseName: course.name,
            academicYearId: academicYearId ?? resolvedYear?.id ?? null,
            academicYear: resolvedYear,
            summary: { totalDemanded },
            breakdown
        };
    },

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

    deleteFeeHead: async (id: string) => {
        return prisma.feeHead.update({
            where: { id },
            data: { isDeleted: true }
        });
    },

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

    createFeeStructureForDegree: async (degree: string, feeHeadId: string, amount: number, academicYearId: string, userId: string, quotaType?: QuotaType, yearOfStudy?: number) => {

        const courses = await prisma.course.findMany({
            where: { degree, isDeleted: false }
        });

        if (courses.length === 0) {
            throw new AppError(`No courses found for degree: ${degree}`, 404);
        }

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

    createFeeStructuresForCombination: async (params: {
        courseId:            string;
        academicYearId:      string;
        entryAcademicYearId?: string;
        entryType?:          'REGULAR' | 'LATERAL' | 'TRANSFER';
        instituteCode?:      'MGMT' | 'VVITU' | 'VVITPU';
        quotaType?:          QuotaType;
        yearOfStudy?:        number;
        feeHeads:            Array<{ feeHeadId: string; amount: number }>;
        userId:              string;
    }) => {

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

        const course = await prisma.course.findUnique({ where: { id: params.courseId } });
        if (!course || course.isDeleted) throw new AppError('Course not found', 404);

        const ay = await prisma.academicYear.findUnique({ where: { id: params.academicYearId } });
        if (!ay || ay.isDeleted) throw new AppError('Academic year not found', 404);

        if (params.entryAcademicYearId && params.entryAcademicYearId !== params.academicYearId) {
            const entryAy = await prisma.academicYear.findUnique({ where: { id: params.entryAcademicYearId } });
            if (!entryAy || entryAy.isDeleted) throw new AppError('Entry academic year not found', 404);
        }

        const headIds = params.feeHeads.map(h => h.feeHeadId);
        const heads = await prisma.feeHead.findMany({
            where: { id: { in: headIds }, isDeleted: false },
            select: { id: true, name: true },
        });
        const validHeadIds = new Set(heads.map(h => h.id));
        const missing = headIds.filter(id => !validHeadIds.has(id));
        if (missing.length) throw new AppError(`FeeHead(s) not found: ${missing.join(', ')}`, 404);
        const headNameById = new Map(heads.map(h => [h.id, h.name]));

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

    getFeeStructures: async (filters?: {
        courseId?:            string;
        academicYearId?:      string;
        feeHeadId?:           string;
        entryAcademicYearId?: string;
        entryType?:           'REGULAR' | 'LATERAL' | 'TRANSFER';
        instituteCode?:       'MGMT' | 'VVITU' | 'VVITPU';
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

        if (!filters?.includeDeleted) where.isDeleted = false;

        if (filters?.courseId)            where.courseId            = filters.courseId;
        if (filters?.academicYearId)      where.academicYearId      = filters.academicYearId;
        if (filters?.feeHeadId)           where.feeHeadId           = filters.feeHeadId;
        if (filters?.entryAcademicYearId) where.entryAcademicYearId = filters.entryAcademicYearId;
        if (filters?.entryType)           where.entryType           = filters.entryType;
        if (filters?.instituteCode)       where.instituteCode       = filters.instituteCode;
        if (filters?.quotaType)           where.quotaType           = filters.quotaType;
        if (filters?.yearOfStudy !== undefined) where.yearOfStudy   = filters.yearOfStudy;

        if (filters?.minAmount !== undefined || filters?.maxAmount !== undefined) {
            where.amount = {};
            if (filters.minAmount !== undefined) where.amount.gte = filters.minAmount;
            if (filters.maxAmount !== undefined) where.amount.lte = filters.maxAmount;
        }

        if (filters?.search) {
            where.OR = [
                { course:  { name: { contains: filters.search, mode: 'insensitive' } } },
                { course:  { code: { contains: filters.search, mode: 'insensitive' } } },
                { feeHead: { name: { contains: filters.search, mode: 'insensitive' } } },
            ];
        }

        const page  = Math.max(1, Number(filters?.page  ?? 1));
        const limit = Math.min(200, Math.max(1, Number(filters?.limit ?? 50)));
        const skip  = (page - 1) * limit;

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

    updateFeeStructure: async (id: string, courseId: string, feeHeadId: string, amount: number, academicYearId: string, userId: string, quotaType?: QuotaType, yearOfStudy?: number) => {
        if (typeof amount === 'number' && amount <= 0) {
            throw new AppError('Fee structure amount must be greater than zero', 400);
        }
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

    deleteFeeStructure: async (id: string) => {
        return prisma.feeStructure.update({
            where: { id },
            data: { isDeleted: true }
        });
    },

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

    createDiscountRequest: async (studentId: string, reason: string, documentUrl: string | undefined, items: { component: string, amount: number }[], requestedAmount: number, referredBy?: string, forceCreate: boolean = false) => {

        const effectiveForceCreate = Boolean(forceCreate);
        console.log('forceCreate received in service:', forceCreate, '=> effectiveForceCreate:', effectiveForceCreate);
        if (!effectiveForceCreate) {

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

        const admission = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { academicYearId: true },
        });
        let academicYearId = admission?.academicYearId ?? null;
        if (!academicYearId) {
            const activeYear = await prisma.academicYear.findFirst({
                where: { isActive: true, isDeleted: false },
                select: { id: true },
            });
            academicYearId = activeYear?.id ?? null;
        }
        if (!academicYearId) {
            throw new AppError('Cannot create discount request: no academic year found for the student or active year configured.', 400);
        }

        return prisma.discountRequest.create({
            data: {
                studentId,
                academicYearId,
                reason,
                documentUrl,
                items: items as any,
                requestedAmount,
                referredBy,
                status: DiscountStatus.FORWARDED_TO_SUPER_ADMIN
            } as any
        });
    },

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

        const enrichedRequests = await Promise.all(requests.map(async (req) => {

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

                 finalItems = ((request as any).items as any[]).map((item: any) => ({
                     component: item.component,
                     approvedAmount: item.amount !== undefined ? item.amount : (item.requestedAmount || 0)
                 }));
                 finalApprovedAmount = finalItems.reduce((sum, item) => sum + item.approvedAmount, 0);
             } else {

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
                    items: approved ? finalItems : (request as any).items,

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

                     if (targetDemand) {

                         const currentDemand = await tx.studentFeeDemand.findUnique({
                             where: { id: targetDemand.id },
                             select: { netAmount: true }
                         });
                         const currentNetAmount = currentDemand?.netAmount ?? 0;
                         const cappedAmt = amt > currentNetAmount ? currentNetAmount : amt;

                         if (cappedAmt > 0) {
                             await tx.studentFeeDemand.update({
                                 where: { id: targetDemand.id },
                                 data: {
                                     discountAmount: { increment: cappedAmt },
                                     netAmount: { decrement: cappedAmt }
                                 }
                             });
                         }
                     }

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
                             yearOfStudy: targetDemand?.yearOfStudy ?? undefined,
                             date: new Date()
                         }
                     });
                 }
             }

             return updatedRequest;
         });
    },

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
                        entryYearOfStudy:        true,
                    }
                },
            }
        });

        if (!student) {
            logger.error(`[generateFeeDemands] Student not found: ${studentId}`);
            throw new AppError("Student not found", 404);
        }

        const isLateralEntry = student.admissionDetails?.entryType === AdmissionEntryType.LATERAL;
        if (requireEnrollment && !isLateralEntry) {

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

        const latestEnrollment = student.enrollments?.[0];
        const currentYear =
            latestEnrollment?.yearOfStudy
            ?? (latestEnrollment?.currentSemester ? Math.ceil(latestEnrollment.currentSemester / 2) : undefined)
            ?? student.admissionDetails?.entryYearOfStudy
            ?? 1;
        logger.debug(
            `[generateFeeDemands] Student Context: Quota=${studentQuota}, DegreeType=${studentDegreeType}, ` +
            `YearOfStudy=${currentYear}`
        );

        const ACCOMMODATION_DISPATCHED_COMPONENTS: ReadonlySet<string> = new Set([
            'HOSTEL',
            'HOSTEL_ACCOMMODATION',
            'HOSTEL_MESS',
            'HOSTEL_LAUNDRY',
            'HOSTEL_REGISTRATION',
            'TRANSPORT',
        ]);

        const applicableRaw = feeStructures.filter(fs => {
            if (fs.quotaType   && fs.quotaType   !== studentQuota)  return false;
            if (fs.yearOfStudy && fs.yearOfStudy !== currentYear)   return false;
            const comp = (fs.feeHead as any)?.component as string | null | undefined;
            if (comp && ACCOMMODATION_DISPATCHED_COMPONENTS.has(comp)) return false;
            return true;
        });

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

            const existing = await tx.studentFeeDemand.findMany({
                where: {
                    studentId,
                    isDeleted: false,
                    feeStructureId: { in: applicableFees.map(f => f.id) }
                },
                select: { feeStructureId: true }
            });
            const existingSet = new Set(existing.map(e => e.feeStructureId));

            const studentScholarship = await tx.studentScholarship.findFirst({
                where: {
                    studentId,
                    scholarshipPercentage: { gt: 0 },
                    NOT: { isEligible: 'NO' as any },
                } as any,
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

                const isTuition = fee.feeHead.component === 'TUITION';
                const scholarshipAmt = (isTuition && discountPct > 0)
                    ? (fee.amount * discountPct) / 100
                    : 0;
                const netAmount = fee.amount - scholarshipAmt;

                const demandYear = fee.yearOfStudy ?? currentYear;

                const demand = await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeStructureId: fee.id,
                        feeHeadId: fee.feeHeadId,
                        academicYearId: fee.academicYearId,
                        yearOfStudy: demandYear,
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
                        academicYearId,
                        yearOfStudy: demandYear
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
                            academicYearId,
                            yearOfStudy: demandYear
                        }
                    });
                    scholarshipApplied++;
                }

                created.push(demand);
                newDemandsTotal += fee.amount;
            }

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

            await tx.studentAdmission.upsert({
                where: { studentId },
                create: { studentId, academicYearId, totalFee: 0 },
                update: {}
            });
            await recomputeStudentTotals(studentId, tx);

            return { created, skippedCount, scholarshipApplied };
        }, {

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

        const targets = enrollments.filter(e => {
            const a = e.student.admissionDetails;
            if (!a?.allottedCourseId) return false;
            if (filters.courseIds            && !filters.courseIds.includes(a.allottedCourseId))   return false;
            if (filters.entryTypes           && !filters.entryTypes.includes(a.entryType as any))  return false;
            if (filters.instituteCodes       && (!a.instituteCode || !filters.instituteCodes.includes(a.instituteCode))) return false;
            if (filters.entryAcademicYearIds && (!a.entryAcademicYearId || !filters.entryAcademicYearIds.includes(a.entryAcademicYearId))) return false;
            if (filters.quotaTypes           && (!e.student.quotaType || !filters.quotaTypes.includes(e.student.quotaType))) return false;
            return true;
        });

        const enrolledIds = new Set(enrollments.map(e => e.studentId));
        const lateralExcludedByFilter = !!(filters.entryTypes && !filters.entryTypes.includes('LATERAL'));
        const lateralAdmissions = lateralExcludedByFilter
            ? []
            : await prisma.studentAdmission.findMany({
                where: {
                    entryType: AdmissionEntryType.LATERAL,
                    allottedCourseId: { not: null },

                    OR: [
                        { feeCohortAcademicYearId: academicYearId },
                        { feeCohortAcademicYearId: null, entryAcademicYearId: academicYearId },
                    ],
                    ...(filters.studentIds && filters.studentIds.length > 0
                        ? { studentId: { in: filters.studentIds } } : {}),
                },
                select: {
                    studentId: true, allottedCourseId: true, instituteCode: true, entryAcademicYearId: true,
                    student: { select: { quotaType: true } },
                },
            });

        const lateralTargets = lateralAdmissions.filter(a => {
            if (enrolledIds.has(a.studentId)) return false;
            if (filters.courseIds            && !filters.courseIds.includes(a.allottedCourseId!))   return false;
            if (filters.instituteCodes       && (!a.instituteCode || !filters.instituteCodes.includes(a.instituteCode))) return false;
            if (filters.entryAcademicYearIds && (!a.entryAcademicYearId || !filters.entryAcademicYearIds.includes(a.entryAcademicYearId))) return false;
            if (filters.quotaTypes           && (!a.student.quotaType || !filters.quotaTypes.includes(a.student.quotaType))) return false;
            return true;
        });

        const resolvedTargets: Array<{ studentId: string; courseId: string }> = [
            ...targets.map(t => ({ studentId: t.studentId, courseId: t.student.admissionDetails!.allottedCourseId! })),
            ...lateralTargets.map(a => ({ studentId: a.studentId, courseId: a.allottedCourseId! })),
        ];

        logger.info(
            `[generateFeeDemandsBulk] resolved ${resolvedTargets.length} target students ` +
            `(${targets.length} enrolled + ${lateralTargets.length} lateral-no-enrollment) from ${enrollments.length} enrollments`
        );

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

        for (const t of resolvedTargets) {
            const courseId = t.courseId;
            try {
                const result = await FeeService.generateFeeDemands(
                    t.studentId,
                    courseId,
                    academicYearId,
                    userId,
                    runOptions.deleteExisting ?? false,
                    {
                        allowLegacyFallback: runOptions.allowLegacyFallback ?? false,
                        requireEnrollment:   runOptions.requireEnrollment   ?? true,
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

    getStudentFeeDetails: async (studentId: string, academicYearId?: string) => {
        logger.info(`[getStudentFeeDetails] Request for student=${studentId}${academicYearId ? ` year=${academicYearId}` : ' (all years)'}`);

        const yearFilter = academicYearId ? { academicYearId } : {};
        const demands: any[] = await prisma.studentFeeDemand.findMany({
            where: { studentId, ...yearFilter },
            include: {
                feeStructure: { include: { feeHead: true } },
                feeHead: true
            } as any
        });

        const payments = await prisma.payment.findMany({
            where: { studentId, status: 'SUCCESS', ...yearFilter }
        });

        logger.debug(`[getStudentFeeDetails] Found ${demands.length} demands and ${payments.length} successful payments.`);

        const baseScholarship = demands.reduce((sum, d) => sum + (d.scholarshipAmount || 0), 0);
        const manualDiscountAmount = demands.reduce(
            (sum, d) => sum + Math.max(0, (d.discountAmount || 0) - (d.scholarshipAmount || 0)), 0
        );

        let scholarshipAmount = baseScholarship;
        let fallbackScholarship = 0;

        if (baseScholarship === 0) {
            const allocation = await prisma.scholarshipAllocation.findUnique({
                where: { studentId },
                include: { rule: true }
            });

            logger.info(`[getStudentFeeDetails] [Scholarship Allocation] Student=${studentId} Found=${!!allocation} Status=${allocation?.status}`);

            if (allocation && (allocation.status === 'LOCKED' || allocation.status === 'RESERVED')) {
                 const admission = await prisma.studentAdmission.findUnique({ where: { studentId } });

                 let tuitionDemand = demands.find(d => {
                    const comp = d.feeStructure?.feeHead?.component ?? d.feeHead?.component ?? null;
                    return comp === 'TUITION';
                 });

                 if (!tuitionDemand && demands.length > 0) {
                     tuitionDemand = demands.reduce((max, d) => d.amount > max.amount ? d : max, demands[0]);
                     logger.debug(`[Scholarship] No TUITION-tagged FeeHead found. Used highest demand as proxy: ${tuitionDemand.amount}`);
                 }

                 const tuitionFee = tuitionDemand ? tuitionDemand.amount : (admission?.totalFee || 0);
                 fallbackScholarship = (tuitionFee * allocation.rule.discountPercentage) / 100;
                 scholarshipAmount = fallbackScholarship;
            }
        }

        const totalDemand = demands.reduce((sum, d) => sum + d.amount, 0);
        const totalNet    = demands.reduce((sum, d) => sum + ((d.netAmount ?? d.amount)), 0);
        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
        const totalDiscount = scholarshipAmount + manualDiscountAmount;

        const pendingAmount = Math.max(0, totalNet - totalPaid - fallbackScholarship);
        
        logger.info(`[getStudentFeeDetails] Summary: Demand=${totalDemand}, Paid=${totalPaid}, Discount=${totalDiscount}, Pending=${pendingAmount}`);

        const breakdown: any = {
            TUITION: { demand: 0, discount: 0, paid: 0, balance: 0 },
            HOSTEL: { demand: 0, discount: 0, paid: 0, balance: 0 },
            TRANSPORT: { demand: 0, discount: 0, paid: 0, balance: 0 },
            OTHER: { demand: 0, discount: 0, paid: 0, balance: 0 }
        };

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

        demands.forEach(d => {
            const comp = d.feeStructure?.feeHead?.component ?? d.feeHead?.component ?? null;
            const key = componentToKey(comp);
            breakdown[key].demand += d.amount;

            breakdown[key].discount += (d.discountAmount || 0);
        });

        payments.forEach(p => {
             const key = componentToKey(p.component as string);
             breakdown[key].paid += p.amount;
        });

        const adjustmentLedgers = await prisma.studentLedger.findMany({
            where: {
                studentId,
                referenceType: 'COURSE_CHANGE',
                ...yearFilter
            }
        });

        adjustmentLedgers.forEach(a => {
            if (!a.feeHeadId) return;

            const head = demands.find(d => (d.feeStructure?.feeHeadId === a.feeHeadId || d.feeHeadId === a.feeHeadId))?.feeHead ||
                         demands.find(d => (d.feeStructure?.feeHeadId === a.feeHeadId || d.feeHeadId === a.feeHeadId))?.feeStructure?.feeHead;
            const key = componentToKey(head?.component as string | null | undefined);

            if (a.type === 'CREDIT') breakdown[key].paid += a.amount;
            else breakdown[key].paid -= a.amount;
        });

        const admissionForOverride = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { accommodationType: true },
        });
        if (admissionForOverride) {
            const accType = admissionForOverride.accommodationType;
            if (accType !== 'HOSTEL') {
                breakdown.HOSTEL.demand = 0;
                breakdown.HOSTEL.discount = 0;
                breakdown.HOSTEL.paid = 0;
            }
            if (accType !== 'TRANSPORT') {
                breakdown.TRANSPORT.demand = 0;
                breakdown.TRANSPORT.discount = 0;
                breakdown.TRANSPORT.paid = 0;
            }
        }

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

    getStudentPaymentHistory: async (studentId: string) => {

        const allFeeHeads = await prisma.feeHead.findMany({ where: { isDeleted: false } });
        const feeHeadLookup = new Map<string, string>();
        allFeeHeads.forEach(fh => feeHeadLookup.set(fh.id, fh.name));

        const demands: any[] = await prisma.studentFeeDemand.findMany({
            where: { studentId },
            include: { 
                feeStructure: { include: { feeHead: true } },
                feeHead: true
            } as any,
            orderBy: { createdAt: 'asc' }
        });

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

        const scholarshipLedgers = await prisma.studentLedger.findMany({
            where: { 
                studentId, 
                referenceType: { in: ['SCHOLARSHIP', 'DISCOUNT'] }
            }
        });

        const feeHeadMap = new Map<string, any>();

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

        demands.forEach(d => {

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

        payments.forEach(p => {
            let targetFeeHeadId: string | undefined;
            let targetFeeHeadName: string | undefined;

            if (p.feeDemand?.feeStructure?.feeHead) {
                targetFeeHeadId = p.feeDemand.feeStructure.feeHead.id;
                targetFeeHeadName = p.feeDemand.feeStructure.feeHead.name;
            } 

            else if (p.feeHeadId && feeHeadLookup.has(p.feeHeadId)) {
                targetFeeHeadId = p.feeHeadId;
                targetFeeHeadName = feeHeadLookup.get(p.feeHeadId);
            }

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

        scholarshipLedgers.forEach(l => {
             let matched = false;
             const isCredit = l.type === 'CREDIT';

             const recordType = l.referenceType === 'SCHOLARSHIP' ? 'SCHOLARSHIP' : 'DISCOUNT';
             
             for (const [, group] of feeHeadMap.entries()) {
                 const isTuition = group.feeHeadComponent === 'TUITION';

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

        const result = Array.from(feeHeadMap.values()).map(group => {
            group.pendingAmount = Math.max(0, group.totalFee - group.paidAmount - group.discountAmount);

            group.history.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
            
            return group;
        });
        
        return result;
    },

    addStudentDiscount: async (studentId: string, feeHeadId: string | undefined, feeStructureId: string | undefined, type: 'DISCOUNT' | 'FINE', amount: number, reason: string, userId: string) => {

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

        if (type === 'DISCOUNT') {
             if (!targetDemand) {
                 throw new AppError('Cannot apply discount. No existing fee demand found for this category.', 404);
             }

             const currentNet = targetDemand.amount + ((targetDemand as any).fineAmount || 0) - ((targetDemand as any).discountAmount || 0);
             if (amount > currentNet) {
                 throw new AppError(`Discount amount (${amount}) exceeds net payable amount (${currentNet}).`, 400);
             }
        }

        return prisma.$transaction(async (tx: any) => {
            let demandId: string;
            const activeYear = await tx.academicYear.findFirstOrThrow({ where: { isActive: true, isDeleted: false } });

            if (targetDemand) {
                const updateData: any = {};

                if (type === 'FINE') {
                    updateData.fineAmount = { increment: amount };
                    updateData.netAmount = { increment: amount };
                } else {
                    updateData.discountAmount = { increment: amount };
                    updateData.netAmount = { decrement: amount };
                }

                updateData.remarks = reason;
                
                await tx.studentFeeDemand.update({
                    where: { id: targetDemand.id },
                    data: updateData
                });
                demandId = targetDemand.id;
            } else {

                if (type === 'FINE') {
                    const newDemand = await tx.studentFeeDemand.create({
                        data: {
                            studentId,

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

                    throw new AppError('Cannot apply discount without base demand.', 400);
                }
            }

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
                    academicYearId: activeYear.id,
                    yearOfStudy: (targetDemand?.yearOfStudy) ?? undefined,
                    date: new Date()
                }
            });

            return { message: 'Success', demandId };
        });
    },

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

        if (newType === 'HOSTEL' && !hostelId) throw new AppError('hostelId is required for HOSTEL', 400);
        if (newType === 'TRANSPORT' && !transportRouteId) throw new AppError('transportRouteId is required for TRANSPORT', 400);

        const result = await prisma.$transaction(async (tx) => {
            let oldCost = 0;
            let newCost = 0;
            let oldLabel = '';
            let newLabel = '';

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

                    const svcChangeYear = await tx.academicYear.findFirstOrThrow({ where: { isActive: true, isDeleted: false } });
                    const svcChangeYearId = svcChangeYear.id;
                    const svcYearOfStudy = await getStudentYearOfStudy(studentId, tx);
                    if (newType === 'NONE') {

                        await tx.studentLedger.create({
                            data: {
                                studentId,
                                type: LedgerTransactionType.CREDIT,
                                amount: transferAmount,
                                description: `${oldServiceName} cancelled — ₹${transferAmount.toLocaleString()} paid, refund due (service change: ${oldType} → NONE)`,
                                referenceType: 'SERVICE_CHANGE',
                                createdBy: adminId,
                                academicYearId: svcChangeYearId,
                                yearOfStudy: svcYearOfStudy,
                            }
                        });
                    } else {

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
                                yearOfStudy: svcYearOfStudy,
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
                                yearOfStudy: svcYearOfStudy,
                            }
                        });
                    }
                }
            }

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

    getFeeCorrections: async (filters: {
        studentId?:       string;
        academicYearId?:  string;
        type?:            FeeCorrectionType;
        isSettled?:       boolean;
        carryForward?:    boolean;
        referenceType?:   string;
        applicationId?:   string;
        page?:            number;
        limit?:           number;
    } = {}) => {
        const where: any = {};
        if (filters.studentId)             where.studentId      = filters.studentId;
        if (filters.academicYearId)        where.academicYearId = filters.academicYearId;
        if (filters.type)                  where.type           = filters.type;
        if (filters.isSettled !== undefined)    where.isSettled    = filters.isSettled;
        if (filters.carryForward !== undefined) where.carryForward = filters.carryForward;
        if (filters.referenceType)         where.referenceType  = filters.referenceType;
        if (filters.applicationId) {
            where.student = { applicationId: { contains: filters.applicationId, mode: 'insensitive' } };
        }

        const page  = Math.max(1, Number(filters.page  ?? 1));
        const limit = Math.min(200, Math.max(1, Number(filters.limit ?? 50)));
        const skip  = (page - 1) * limit;

        const [rows, total] = await Promise.all([
            prisma.feeCorrection.findMany({
                where, skip, take: limit, orderBy: { createdAt: 'desc' },
                include: {
                    student:      { select: { id: true, name: true, applicationId: true } },
                    academicYear: { select: { id: true, code: true } },
                },
            }),
            prisma.feeCorrection.count({ where }),
        ]);

        const ids = rows.map(r => r.id);
        const appliedByCorrection = new Map<string, number>();
        if (ids.length > 0) {
            const studentIds = Array.from(new Set(rows.map((r: any) => r.studentId)));
            const transfers = await prisma.payment.findMany({
                where: {
                    studentId: { in: studentIds },
                    status: PaymentStatus.SUCCESS,
                    isDeleted: false,
                    metadata: { path: ['kind'], equals: 'FEE_CORRECTION_TRANSFER' },
                },
                select: { amount: true, metadata: true },
            });
            const idSet = new Set(ids);
            for (const t of transfers) {
                const cid = (t.metadata as any)?.feeCorrectionId;
                if (cid && idSet.has(cid)) {
                    appliedByCorrection.set(cid, (appliedByCorrection.get(cid) ?? 0) + (t.amount ?? 0));
                }
            }
        }

        const items = rows.map((r: any) => {
            const applied   = appliedByCorrection.get(r.id) ?? 0;
            const remaining = Math.max(0, r.amount - applied);
            return { ...r, applied, remaining };
        });

        return {
            items,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    },

    applyFeeCorrection: async (
        feeCorrectionId: string,
        args: { feeDemandId: string; amount: number; remarks?: string },
        adminId?: string
    ) => {
        const amount = Number(args.amount);
        if (!feeCorrectionId)   throw new AppError('feeCorrectionId is required', 400);
        if (!args.feeDemandId)  throw new AppError('feeDemandId is required', 400);
        if (!(amount > 0))      throw new AppError('amount must be greater than 0', 400);

        return prisma.$transaction(async (tx) => {
            const correction = await tx.feeCorrection.findUnique({ where: { id: feeCorrectionId } });
            if (!correction) throw new AppError('Fee correction not found', 404);

            const priorTransfers = await tx.payment.findMany({
                where: {
                    studentId: correction.studentId, status: PaymentStatus.SUCCESS, isDeleted: false,
                    metadata: { path: ['feeCorrectionId'], equals: feeCorrectionId },
                },
                select: { amount: true },
            });
            const applied   = priorTransfers.reduce((s, p) => s + (p.amount ?? 0), 0);
            const remaining = Math.max(0, correction.amount - applied);
            if (remaining <= 0)      throw new AppError('This fee correction has no remaining credit to transfer.', 400);
            if (amount > remaining)  throw new AppError(`Amount (${amount}) exceeds the correction's remaining credit (${remaining}).`, 400);

            const demand = await tx.studentFeeDemand.findUnique({ where: { id: args.feeDemandId } });
            if (!demand || demand.isDeleted)           throw new AppError('Fee demand not found', 404);
            if (demand.studentId !== correction.studentId) throw new AppError('Fee demand belongs to a different student than the correction.', 400);
            if (demand.status === FeeStatus.FULL)       throw new AppError('Fee demand is already fully paid.', 400);
            if (demand.academicYearId) await assertAcademicYearWritable(demand.academicYearId);

            const paidAgg = await tx.payment.aggregate({
                where: { feeDemandId: demand.id, status: PaymentStatus.SUCCESS, isDeleted: false },
                _sum: { amount: true },
            });
            const target      = demand.netAmount ?? demand.amount;
            const demandPaid  = paidAgg._sum.amount ?? 0;
            const outstanding = Math.max(0, target - demandPaid);
            if (outstanding <= 0)     throw new AppError("Fee demand has no outstanding balance.", 400);
            if (amount > outstanding) throw new AppError(`Amount (${amount}) exceeds the demand's outstanding balance (${outstanding}).`, 400);

            let component: PaymentComponent = PaymentComponent.OTHER;
            if (demand.feeHeadId) {
                const head = await tx.feeHead.findUnique({ where: { id: demand.feeHeadId }, select: { component: true } });
                if (head?.component) component = head.component as PaymentComponent;
            }

            const payment = await (tx.payment as any).create({
                data: {
                    studentId: correction.studentId,
                    amount,
                    status: PaymentStatus.SUCCESS,
                    mode: PaymentMode.OFFLINE,
                    component,
                    feeHeadId: demand.feeHeadId ?? undefined,
                    feeDemandId: demand.id,
                    academicYearId: demand.academicYearId,
                    yearOfStudy: demand.yearOfStudy ?? undefined,
                    collectedBy: adminId,
                    createdBy: adminId,
                    idempotencyKey: `fctxfer-${feeCorrectionId}-${demand.id}-${Date.now()}`,
                    metadata: { kind: 'FEE_CORRECTION_TRANSFER', feeCorrectionId, remarks: args.remarks ?? null, appliedBy: adminId ?? null },
                },
            });

            const newDemandPaid = demandPaid + amount;
            const newStatus = newDemandPaid >= target ? FeeStatus.FULL : FeeStatus.PARTIAL;
            await tx.studentFeeDemand.update({ where: { id: demand.id }, data: { status: newStatus, updatedBy: adminId } });

            const newApplied     = applied + amount;
            const fullyConsumed  = newApplied >= correction.amount;
            if (fullyConsumed && !correction.isSettled) {
                await tx.feeCorrection.update({
                    where: { id: feeCorrectionId },
                    data: { isSettled: true, settledAt: new Date(), settledBy: adminId, updatedBy: adminId },
                });
            }

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'FEE_CORRECTION_TRANSFERRED',
                    entity: 'FeeCorrection',
                    entityId: feeCorrectionId,
                    details: {
                        feeDemandId: demand.id, amount, component,
                        correctionAmount: correction.amount, priorApplied: applied, newApplied,
                        remainingAfter: Math.max(0, correction.amount - newApplied),
                        demandTarget: target, demandPaidAfter: newDemandPaid, demandStatus: newStatus,
                        paymentId: payment.id, remarks: args.remarks ?? null,
                    },
                },
            });

            await recomputeStudentTotals(correction.studentId, tx);

            return {
                feeCorrectionId,
                transferred: amount,
                correction: {
                    amount: correction.amount,
                    applied: newApplied,
                    remaining: Math.max(0, correction.amount - newApplied),
                    isSettled: fullyConsumed || !!correction.isSettled,
                },
                demand: { id: demand.id, target, paid: newDemandPaid, status: newStatus },
                paymentId: payment.id,
            };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    },

    getCancellationMetrics: async (filters: {
        academicYearId?: string;
        from?:           string;
        to?:             string;
        referenceType?:  string;
    } = {}) => {
        const where: any = {};
        if (filters.academicYearId) where.academicYearId = filters.academicYearId;
        if (filters.referenceType)  where.referenceType  = filters.referenceType;
        if (filters.from || filters.to) {
            where.createdAt = {};
            if (filters.from) where.createdAt.gte = new Date(filters.from);
            if (filters.to)   where.createdAt.lte = new Date(filters.to);
        }

        const [grouped, yearGrouped] = await Promise.all([
            prisma.feeCorrection.groupBy({
                by: ['referenceType'],
                where,
                _sum: { retainedAmount: true, amount: true },
                _count: { _all: true },
            }),
            prisma.feeCorrection.groupBy({
                by: ['academicYearId'],
                where,
                _sum: { retainedAmount: true, amount: true },
                _count: { _all: true },
            }),
        ]);

        const yearIds = yearGrouped.map(y => y.academicYearId).filter(Boolean) as string[];
        const years = yearIds.length
            ? await prisma.academicYear.findMany({ where: { id: { in: yearIds } }, select: { id: true, code: true } })
            : [];
        const codeById = new Map(years.map(y => [y.id, y.code]));
        const byAcademicYear = yearGrouped
            .map(y => ({
                academicYearId: y.academicYearId,
                academicYear:   codeById.get(y.academicYearId) ?? null,
                retained:       y._sum.retainedAmount ?? 0,
                refunded:       y._sum.amount ?? 0,
                events:         y._count._all,
            }))
            .sort((a, b) => (b.academicYear ?? '').localeCompare(a.academicYear ?? ''));

        const accommodationOf = (refType: string | null): 'hostel' | 'transport' | 'other' => {
            if (!refType) return 'other';
            if (refType.startsWith('HOSTEL')) return 'hostel';
            if (refType.startsWith('TRANSPORT')) return 'transport';
            return 'other';
        };

        const byType: Record<string, { retained: number; refunded: number; events: number }> = {};
        const byAccommodation = {
            hostel:    { retained: 0, refunded: 0, events: 0 },
            transport: { retained: 0, refunded: 0, events: 0 },
            other:     { retained: 0, refunded: 0, events: 0 },
        };
        let totalRetained = 0, totalRefunded = 0, totalEvents = 0;
        for (const g of grouped) {
            const key      = g.referenceType ?? 'UNKNOWN';
            const retained = g._sum.retainedAmount ?? 0;
            const refunded = g._sum.amount ?? 0;
            const events   = g._count._all;
            byType[key] = { retained, refunded, events };

            const bucket = byAccommodation[accommodationOf(g.referenceType)];
            bucket.retained += retained;
            bucket.refunded += refunded;
            bucket.events   += events;

            totalRetained += retained;
            totalRefunded += refunded;
            totalEvents   += events;
        }

        return { totalRetained, totalRefunded, totalEvents, byAcademicYear, byAccommodation, byType };
    },
};

