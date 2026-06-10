import prisma from '../../config/prisma';
import { AdmissionStatus, PaymentStatus, PaymentComponent, StudentDocumentStatus, ApplicationMode, QuotaType, AccommodationType, Prisma } from '@prisma/client';

const getDateCondition = (range?: string, startDate?: string, endDate?: string) => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    let start: Date | undefined;
    let end: Date | undefined;

    if (range && range !== 'custom') {
        switch (range) {
            case 'today':
                start = todayStart;
                end = todayEnd;
                break;
            case 'yesterday':
                const yesterday = new Date(todayStart);
                yesterday.setDate(yesterday.getDate() - 1);
                start = yesterday;
                const yesterdayEnd = new Date(yesterday);
                yesterdayEnd.setHours(23, 59, 59, 999);
                end = yesterdayEnd;
                break;
            case '7d':
            case '7days':
                start = new Date(todayStart);
                start.setDate(start.getDate() - 7);
                end = todayEnd;
                break;
            case '15d':
            case '15days':
                start = new Date(todayStart);
                start.setDate(start.getDate() - 15);
                end = todayEnd;
                break;
            case '30d':
            case '30days':
                start = new Date(todayStart);
                start.setDate(start.getDate() - 30);
                end = todayEnd;
                break;
        }
    } else {

        if (startDate) start = new Date(startDate);
        if (endDate) {
            end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
        }
    }

    if (!start && !end) return undefined;

    const dateQuery: any = {};
    if (start) dateQuery.gte = start;
    if (end) dateQuery.lte = end;
    
    return dateQuery;
};

export const DashboardService = {

    async getApplicationStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);
        const whereDate = dateFilter ? { createdAt: dateFilter } : {};

        const [
            totalApplications,
            totalPaidApplications,
            totalOnlineApplications,
            totalOfflineApplications
        ] = await Promise.all([
            prisma.student.count({ where: whereDate }),
            prisma.student.count({
                where: {
                    ...whereDate,
                    payments: {
                        some: {
                            component: PaymentComponent.APPLICATION_FEE,
                            status: PaymentStatus.SUCCESS
                        }
                    }
                }
            }),
            prisma.student.count({
                where: {
                    ...whereDate,
                    applicationMode: ApplicationMode.ONLINE,
                    isOffline: false
                }
            }),
            prisma.student.count({
                where: {
                    ...whereDate,
                    OR: [
                        { applicationMode: ApplicationMode.OFFLINE },
                        { isOffline: true }
                    ]
                }
            })
        ]);

        return {
            totalApplications,
            totalPaidApplications,
            totalOnlineApplications,
            totalOfflineApplications
        };
    },

    async getFinancialStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);
        const whereDate = dateFilter ? { createdAt: dateFilter } : {};

        const [
            totalApplicationFeeCollected,
            totalCollegeAmountReceived,
            totalScholarshipAmountGiven
        ] = await Promise.all([
            prisma.payment.aggregate({
                where: { 
                    ...whereDate,
                    status: PaymentStatus.SUCCESS,
                    component: PaymentComponent.APPLICATION_FEE
                },
                _sum: { amount: true }
            }),
            prisma.payment.aggregate({
                where: {
                    ...whereDate,
                    status: PaymentStatus.SUCCESS,
                    component: { not: PaymentComponent.APPLICATION_FEE }
                },
                _sum: { amount: true }
            }),
            prisma.studentFeeDemand.aggregate({
                where: { ...whereDate, isDeleted: false },
                _sum: { scholarshipAmount: true }
            })
        ]);

        return {
            totalApplicationFeeCollected: totalApplicationFeeCollected._sum.amount || 0,
            totalCollegeAmountReceived: totalCollegeAmountReceived._sum.amount || 0,
            totalScholarshipAmountGiven: totalScholarshipAmountGiven._sum.scholarshipAmount || 0
        };
    },

    async getAdmissionStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);

        const [
            totalSeatAllocated,
            totalManagementQuota,
            totalConvenorQuota,
            totalHostelSelected,
            totalTransportSelected,
            totalScholarshipEligible,
            totalScholarshipNotEligible,
            discountStats,
            totalSeatCancellationsApproved,
            totalBranchChangeApproved
        ] = await Promise.all([
            prisma.student.count({
                where: {
                    admissionDetails: { status: { not: 'CANCELLED' } },
                    payments: {
                        some: {
                            component: PaymentComponent.TUITION,
                            status: PaymentStatus.SUCCESS,
                            ...(dateFilter ? { createdAt: dateFilter } : {})
                        }
                    }
                }
            }),
            prisma.student.count({
                where: {
                    quotaType: QuotaType.MANAGEMENT,
                    admissionDetails: {
                        allottedCourseId: { not: null },
                        status: { not: 'CANCELLED' },
                        ...(dateFilter ? { seatAllottedAt: dateFilter } : {})
                    }
                }
            }),
            prisma.student.count({
                where: {
                    quotaType: QuotaType.CONVENOR,
                    admissionDetails: {
                        allottedCourseId: { not: null },
                        status: { not: 'CANCELLED' },
                        ...(dateFilter ? { seatAllottedAt: dateFilter } : {})
                    }
                }
            }),
            prisma.student.count({
                where: {
                    admissionDetails: { accommodationType: AccommodationType.HOSTEL },
                    payments: {
                        some: {
                            component: { in: ['HOSTEL', 'HOSTEL_ACCOMMODATION', 'HOSTEL_MESS'] as any },
                            status: 'SUCCESS',
                            ...(dateFilter ? { createdAt: dateFilter } : {})
                        }
                    }
                }
            }),
            prisma.student.count({
                where: {
                    admissionDetails: { accommodationType: AccommodationType.TRANSPORT },
                    payments: {
                        some: {
                            component: 'TRANSPORT' as any,
                            status: 'SUCCESS',
                            ...(dateFilter ? { createdAt: dateFilter } : {})
                        }
                    }
                }
            }),
            prisma.student.count({
                where: {
                    studentScholarship: {
                        isEligible: 'YES',
                        ...(dateFilter ? { updatedAt: dateFilter } : {})
                    },
                    admissionDetails: { allottedCourseId: { not: null }, status: { not: 'CANCELLED' } }
                }
            }),
            prisma.student.count({
                where: {
                    studentScholarship: {
                        isEligible: 'NO',
                        ...(dateFilter ? { updatedAt: dateFilter } : {})
                    },
                    admissionDetails: { allottedCourseId: { not: null }, status: { not: 'CANCELLED' } }
                }
            }),
            prisma.discountRequest.aggregate({
                where: {
                    status: 'APPROVED',
                    ...(dateFilter ? { approvedAt: dateFilter } : {})
                },
                _sum: { approvedAmount: true }
            }),
            prisma.cancellationRequest.count({
                where: {
                    status: 'APPROVED',
                    ...(dateFilter ? { approvedAt: dateFilter } : {})
                }
            }),
            prisma.$queryRaw<{ count: bigint }[]>`
                SELECT COUNT(*)::bigint AS count
                FROM "CourseChangeRequest"
                WHERE "status" = 'APPROVED'
                  AND "fromDegree" IS NOT NULL
                  AND "toDegree" IS NOT NULL
                  AND UPPER(TRIM("fromDegree")) = UPPER(TRIM("toDegree"))
                  ${dateFilter?.gte ? Prisma.sql`AND "actionedAt" >= ${dateFilter.gte}` : Prisma.empty}
                  ${dateFilter?.lte ? Prisma.sql`AND "actionedAt" <= ${dateFilter.lte}` : Prisma.empty}
            `
        ]);

        const approvedDiscountStudents = await prisma.discountRequest.findMany({
            where: {
                status: 'APPROVED',
                ...(dateFilter ? { approvedAt: dateFilter } : {})
            },
            select: { studentId: true },
            distinct: ['studentId']
        });

        return {
            totalSeatAllocated,
            totalManagementQuota,
            totalConvenorQuota,
            totalHostelSelected,
            totalTransportSelected,
            totalScholarshipEligible,
            totalScholarshipNotEligible,
            totalApprovedDiscountStudents: approvedDiscountStudents.length,
            totalApprovedDiscountAmount: discountStats._sum.approvedAmount || 0,
            totalSeatCancellationsApproved,
            totalBranchChangeApproved: Number(totalBranchChangeApproved?.[0]?.count ?? 0)
        };
    },

    async getScholarshipStats(
        range?: string,
        startDate?: string,
        endDate?: string,
        degreeType?: string
    ) {
        const dateFilter = getDateCondition(range, startDate, endDate);
        const degreeWhere = degreeType ? { degreeType } : {};
        const scholarshipDateFilter = dateFilter ? { updatedAt: dateFilter } : {};

        const [totalEligible, totalNotEligible, totalApplicants, percentageGroups] = await Promise.all([
            prisma.student.count({
                where: {
                    ...degreeWhere,
                    studentScholarship: { isEligible: 'YES', ...scholarshipDateFilter },
                    admissionDetails: {
                        allottedCourseId: { not: null },
                        status: { not: 'CANCELLED' }
                    }
                }
            }),
            prisma.student.count({
                where: {
                    ...degreeWhere,
                    studentScholarship: { isEligible: 'NO', ...scholarshipDateFilter },
                    admissionDetails: {
                        allottedCourseId: { not: null },
                        status: { not: 'CANCELLED' }
                    }
                }
            }),
            prisma.student.count({
                where: {
                    ...degreeWhere,
                    studentScholarship: { isEligible: { in: ['YES', 'NO'] }, ...scholarshipDateFilter },
                    admissionDetails: {
                        allottedCourseId: { not: null },
                        status: { not: 'CANCELLED' }
                    }
                }
            }),
            prisma.studentScholarship.groupBy({
                by: ['scholarshipPercentage'],
                where: {
                    scholarshipPercentage: { gt: 0 },
                    ...scholarshipDateFilter,
                    ...(degreeType ? { degreeType } : {}),
                    student: {
                        admissionDetails: {
                            allottedCourseId: { not: null },
                            status: { not: 'CANCELLED' }
                        }
                    }
                },
                _count: { studentId: true },
                orderBy: { scholarshipPercentage: 'desc' }
            })
        ]);

        const percentageBreakdown = percentageGroups.map(g => ({
            percentage: g.scholarshipPercentage ?? 0,
            count: g._count.studentId
        }));

        return {
            degreeType: degreeType || 'ALL',
            totalScholarshipApplicants: totalApplicants,
            totalScholarshipEligible: totalEligible,
            totalScholarshipNotEligible: totalNotEligible,
            percentageBreakdown
        };
    },

    async getExamStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);
        const whereDate = dateFilter ? { createdAt: dateFilter } : {};

        const [totalExamRegistered, totalExamAttended] = await Promise.all([
            prisma.studentExam.count({ where: whereDate }),
            prisma.studentExam.count({ where: { ...whereDate, examAttended: true } })
        ]);

        return {
            totalExamRegistered,
            totalExamAttended
        };
    },

    async getVerificationStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);

        const [totalQualificationVerified, totalDocumentsVerified] = await Promise.all([

            prisma.student.count({
                where: {
                    academicQualifications: {
                        some: {
                            verificationStatus: 'APPROVED',
                            ...(dateFilter ? { updatedAt: dateFilter } : {})
                        }
                    }
                }
            }),

            prisma.student.count({
                where: {
                    documents: {
                        some: {
                            status: StudentDocumentStatus.APPROVED,
                            documentKey: { not: 'ALLOTMENT_ORDER' },
                            ...(dateFilter ? { updatedAt: dateFilter } : {})
                        }
                    }
                }
            })
        ]);

        return {
            totalQualificationVerified,
            totalDocumentsVerified
        };
    },

    async getDegreeSeatAllocatedStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);

        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            select: { id: true },
        });

        const [studentStats, capacityRows] = await Promise.all([

            prisma.student.groupBy({
                by: ['degreeType'],
                where: {
                    admissionDetails: {
                        allottedCourseId: { not: null },
                        status: { not: 'CANCELLED' },
                        ...(activeYear ? { batchAcademicYearId: activeYear.id } : {}),
                        ...(dateFilter ? { seatAllottedAt: dateFilter } : {})
                    }
                },
                _count: {
                    id: true
                }
            }),

            activeYear
                ? prisma.courseCapacity.findMany({
                    where: { academicYearId: activeYear.id },
                    select: { totalSeats: true, course: { select: { degree: true, isDeleted: true } } },
                })
                : Promise.resolve([] as Array<{ totalSeats: number; course: { degree: string | null; isDeleted: boolean | null } }>),
        ]);

        const stats: Record<string, { total: number, filled: number }> = {};

        if (capacityRows.length > 0) {
            capacityRows.forEach(row => {
                if (row.course.isDeleted) return;
                const degree = row.course.degree;
                if (!degree) return;
                if (!stats[degree]) stats[degree] = { total: 0, filled: 0 };
                stats[degree].total += row.totalSeats;
            });
        }

        studentStats.forEach(s => {
            if (s.degreeType) {
                if (!stats[s.degreeType]) {
                    stats[s.degreeType] = { total: 0, filled: 0 };
                }
                stats[s.degreeType].filled = s._count.id;
            }
        });

        return stats;
    },

    async getGenderSeatAllocatedStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);

        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            select: { id: true },
        });

        const result = await prisma.student.groupBy({
            by: ['gender'],
            where: {
                admissionDetails: {
                    allottedCourseId: { not: null },
                    status: { not: 'CANCELLED' },
                    ...(activeYear ? { batchAcademicYearId: activeYear.id } : {}),
                    ...(dateFilter ? { seatAllottedAt: dateFilter } : {})
                }
            },
            _count: {
                id: true
            }
        });

        const stats: Record<string, number> = {};
        result.forEach(item => {
            if (item.gender) {
                stats[item.gender] = item._count.id;
            }
        });

        return stats;
    },

    async getRegistrationTrends(rangeType: string) {
        let dateLimit = new Date();
        
        switch(rangeType) {
            case '7d':
                dateLimit.setDate(dateLimit.getDate() - 7);
                break;
            case '10d':
                dateLimit.setDate(dateLimit.getDate() - 10);
                break;
            case '1m':
                dateLimit.setMonth(dateLimit.getMonth() - 1);
                break;
            case '3m':
                dateLimit.setMonth(dateLimit.getMonth() - 3);
                break;
            default:
                dateLimit.setDate(dateLimit.getDate() - 7);
        }

        const rawStudents = await prisma.student.findMany({
            where: { createdAt: { gte: dateLimit } },
            select: { createdAt: true }
        });

        const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
        const istDateStr = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().split('T')[0];

        const trendMap: Record<string, number> = {};

        rawStudents.forEach(s => {
            const dateStr = istDateStr(s.createdAt ?? new Date());
            trendMap[dateStr] = (trendMap[dateStr] || 0) + 1;
        });

        const result = [];
        const today = new Date();
        for (let d = new Date(dateLimit); d <= today; d.setDate(d.getDate() + 1)) {
            const dateStr = istDateStr(d);
            result.push({
                date: dateStr,
                count: trendMap[dateStr] || 0
            });
        }

        return {
            trends: result,
            totalForRange: rawStudents.length
        };
    },

    async getRecentStudents(rangeType: string) {
        let dateLimit = new Date();
        
        switch(rangeType) {
            case '7d':
                dateLimit.setDate(dateLimit.getDate() - 7);
                break;
            case '10d':
                dateLimit.setDate(dateLimit.getDate() - 10);
                break;
            case '1m':
                dateLimit.setMonth(dateLimit.getMonth() - 1);
                break;
            case '3m':
                dateLimit.setMonth(dateLimit.getMonth() - 3);
                break;
            default:
                dateLimit.setDate(dateLimit.getDate() - 7);
        }

        return prisma.student.findMany({
            where: {
                createdAt: {
                    gte: dateLimit
                }
            },
            select: {
                id: true,
                name: true,
                applicationId: true,
                email: true,
                phone: true,
                createdAt: true,
                degreeType: true,
                admissionDetails: {
                    select: {
                        status: true
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            }
        });
    },

    async getSeatAllocationStats(type: string, page: number = 1, limit: number = 10, search?: string) {
        const skip = (page - 1) * limit;

        const searchCondition: any = search ? {
            OR: [
                { applicationId: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search, mode: 'insensitive' } },
                {
                    admissionDetails: {
                        allottedCourse: {
                            OR: [
                                { name: { contains: search, mode: 'insensitive' } },
                                { code: { contains: search, mode: 'insensitive' } }
                            ]
                        }
                    }
                }
            ]
        } : {};

        let typeCondition: any = {};

        const notAllocatedAdmissionFilter = {
            academicQualifications: {
                some: { verificationStatus: 'APPROVED' }
            },
            OR: [
                { admissionDetails: null },
                {
                    admissionDetails: {
                        allottedCourseId: null,
                        OR: [
                            { status: null },
                            { status: { notIn: [AdmissionStatus.CANCELLED, AdmissionStatus.ENROLLED] } }
                        ]
                    }
                }
            ]
        };

        const allocatedAdmissionFilter = {
            admissionDetails: {
                allottedCourseId: { not: null },
                OR: [
                    { status: null },
                    { status: { notIn: [AdmissionStatus.CANCELLED, AdmissionStatus.ENROLLED] } }
                ]
            }
        };

        if (type === 'not_allocated') {
            typeCondition = {
                ...notAllocatedAdmissionFilter,
                studentScholarship: { isNot: null }
            };
        } else if (type === 'allocated') {
            typeCondition = allocatedAdmissionFilter;
        } else if (type === 'not_allocated_eligible') {
            typeCondition = {
                ...notAllocatedAdmissionFilter,
                studentScholarship: { isEligible: 'YES' }
            };
        } else if (type === 'not_allocated_not_eligible') {
            typeCondition = {
                ...notAllocatedAdmissionFilter,
                studentScholarship: { isEligible: 'NO' }
            };
        } else if (type === 'allocated_eligible') {
            typeCondition = {
                ...allocatedAdmissionFilter,
                studentScholarship: { isEligible: 'YES' }
            };
        } else if (type === 'allocated_not_eligible') {
            typeCondition = {
                ...allocatedAdmissionFilter,
                studentScholarship: { isEligible: 'NO' }
            };
        } else if (type === 'all') {
            typeCondition = {
                studentScholarship: { isNot: null },
                OR: [
                    { admissionDetails: null },
                    {
                        admissionDetails: {
                            OR: [
                                { status: null },
                                { status: { notIn: [AdmissionStatus.CANCELLED, AdmissionStatus.ENROLLED] } }
                            ]
                        }
                    }
                ]
            };
        }

        const where: any = search
            ? { AND: [searchCondition, typeCondition] }
            : typeCondition;

        const [total, students] = await Promise.all([
            prisma.student.count({ where }),
            prisma.student.findMany({
                where,
                skip,
                take: limit,
                select: {
                    id: true,
                    userId: true,
                    name: true,
                    fatherName: true,
                    gender: true,
                    phone: true,
                    applicationId: true,
                    email: true,
                    degreeType: true,
                    admissionDetails: {
                        select: {
                            studentId: true,
                            status: true,
                            totalFee: true,
                            paidFee: true,
                            allottedCourseId: true,
                            allottedCourse: { select: { name: true, code: true } }
                        }
                    },
                    studentScholarship: {
                        select: {
                            scholarshipPercentage: true,
                            isEligible: true,
                            type: true
                        }
                    },
                    proId: true,
                    pro: { select: { proNumber: true } },

                    waitingListEntries: {
                        take: 1,
                        orderBy: { createdAt: 'desc' },
                        select: { id: true, category: true, waitingNumber: true, status: true, courseId: true, academicYearId: true },
                    }
                },
                orderBy: { createdAt: 'desc' }
            })
        ]);

        const data = students.map((s: any) => {
            const { waitingListEntries, ...rest } = s;

            const waitingEntry = waitingListEntries?.[0] ?? null;
            return {
                ...rest,
                isInWaitingList: !!waitingEntry,
                waitingListCategory: waitingEntry?.category ?? null,
                waitingList: waitingEntry,
            };
        });

        return {
            total,
            page,
            totalPages: Math.ceil(total / limit),
            data
        };
    },

    async getCourseCodes() {
        return await prisma.course.findMany({
            select: {
                id: true,
                name: true,
                code: true
            },
            orderBy: { name: 'asc' }
        });
    },

    async getSeatAllocationCounts(filter?: string) {
        const result: any = {};

        if (!filter || filter === 'not_allocated') {
            result.notAllocated = await prisma.student.count({
                where: {
                    academicQualifications: {
                        some: { verificationStatus: 'APPROVED' }
                    },
                    OR: [
                        { admissionDetails: null },
                        {
                            admissionDetails: {
                                allottedCourseId: null,
                                OR: [
                                    { status: null },
                                    { status: { notIn: [AdmissionStatus.CANCELLED, AdmissionStatus.ENROLLED] } }
                                ]
                            }
                        }
                    ],
                    studentScholarship: { isNot: null }
                }
            });
        }

        if (!filter || filter === 'allocated') {
             const allocatedCondition = {
                admissionDetails: {
                    allottedCourseId: { not: null },
                    OR: [
                        { status: null },
                        { status: { notIn: [AdmissionStatus.CANCELLED, AdmissionStatus.ENROLLED] } }
                    ]
                }
            };

            const [eligible, notEligible] = await Promise.all([
                prisma.student.count({
                    where: {
                        ...allocatedCondition,
                        studentScholarship: { isEligible: 'YES' }
                    }
                }),
                prisma.student.count({
                    where: {
                        ...allocatedCondition,
                        studentScholarship: { isEligible: 'NO' }
                    }
                })
            ]);

            result.scholarshipApprovedwithSeat = eligible;
            result.scholarshipNotApprovedwithSeat = notEligible;
        }

        return result;
    },

    async getCourseSeatStats() {
        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            select: { id: true },
        });

        const courses = await prisma.course.findMany({
            where: { isDeleted: false },
            select: {
                id: true,
                code: true,
                name: true,
                capacities: activeYear
                    ? { where: { academicYearId: activeYear.id }, select: { totalSeats: true } }
                    : undefined,
                _count: {
                    select: {
                        allottedStudents: {
                            where: {
                                allottedCourseId: { not: null },
                                OR: [
                                    { status: null },
                                    { status: { not: 'CANCELLED' } }
                                ],
                                ...(activeYear ? { batchAcademicYearId: activeYear.id } : {}),
                            }
                        }
                    }
                }
            },
            orderBy: { name: 'asc' }
        });

        return courses.map(c => {
            const filled = c._count.allottedStudents;
            const total  = c.capacities?.[0]?.totalSeats ?? 0;
            return {
                id: c.id,
                code: c.code,
                name: c.name,
                totalSeats: total,
                filledSeats: filled,
                remainingSeats: Math.max(0, total - filled)
            };
        });
    }
};
