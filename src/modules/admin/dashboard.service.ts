import prisma from '../../config/prisma';
import { AdmissionStatus, PaymentStatus, PaymentComponent, StudentDocumentStatus, Payment, ApplicationMode, QuotaType, AccommodationType, Prisma } from '@prisma/client';

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
        // Custom dates or no range specified
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
    /**
     * 1. Application Statistics
     */
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

    /**
     * 2. Financial Statistics
     */
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
                where: whereDate,
                _sum: { scholarshipAmount: true }
            })
        ]);

        return {
            totalApplicationFeeCollected: totalApplicationFeeCollected._sum.amount || 0,
            totalCollegeAmountReceived: totalCollegeAmountReceived._sum.amount || 0,
            totalScholarshipAmountGiven: totalScholarshipAmountGiven._sum.scholarshipAmount || 0
        };
    },

    /**
     * 3. Admission & Infrastructure Statistics
     */
    async getAdmissionStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);
        const whereDate = dateFilter ? { createdAt: dateFilter } : {};

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
            prisma.student.count({ where: { ...whereDate, quotaType: QuotaType.MANAGEMENT } }),
            prisma.student.count({ where: { ...whereDate, quotaType: QuotaType.CONVENOR } }),
            prisma.student.count({ 
            where: { 
                ...whereDate, 
                admissionDetails: { accommodationType: AccommodationType.HOSTEL },
                payments: {
                    some: {
                        component: { in: ['HOSTEL', 'HOSTEL_ACCOMMODATION', 'HOSTEL_MESS'] },
                        status: 'SUCCESS'
                    }
                }
            } 
        }),
        prisma.student.count({ 
            where: { 
                ...whereDate, 
                admissionDetails: { accommodationType: AccommodationType.TRANSPORT },
                payments: {
                    some: {
                        component: 'TRANSPORT',
                        status: 'SUCCESS'
                    }
                }
            } 
        }),
            prisma.student.count({ 
                where: { 
                    ...whereDate, 
                    studentScholarship: { isEligible: 'YES' },
                    admissionDetails: { allottedCourseId: { not: null } }
                } 
            }),
            prisma.student.count({
                where: {
                    ...whereDate,
                    studentScholarship: { isEligible: 'NO' }
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

        // Unique approved discount students
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

    /**
     * Scholarship Statistics — with optional degreeType filter
     */
    async getScholarshipStats(
        range?: string,
        startDate?: string,
        endDate?: string,
        degreeType?: string
    ) {
        const dateFilter = getDateCondition(range, startDate, endDate);
        const whereDate = dateFilter ? { createdAt: dateFilter } : {};
        const degreeWhere = degreeType ? { degreeType } : {};

        const baseWhere = { ...whereDate, ...degreeWhere };

        const [totalEligible, totalNotEligible, totalApplicants, percentageGroups] = await Promise.all([
            prisma.student.count({
                where: {
                    ...baseWhere,
                    studentScholarship: { isEligible: 'YES' },
                    admissionDetails: {
                        allottedCourseId: { not: null },
                        status: { not: 'CANCELLED' }
                    }
                }
            }),
            prisma.student.count({
                where: {
                    ...baseWhere,
                    studentScholarship: { isEligible: 'NO' },
                    admissionDetails: {
                        allottedCourseId: { not: null },
                        status: { not: 'CANCELLED' }
                    }
                }
            }),
            prisma.student.count({
                where: {
                    ...baseWhere,
                    studentScholarship: { isEligible: { in: ['YES', 'NO'] } },
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

    /**
     * 4. Exam Statistics
     */
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

    /**
     * Get Verification Statistics
     * Counts unique students with at least one approved qualification/document.
     */
    async getVerificationStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);
        const whereDate = dateFilter ? { createdAt: dateFilter } : {};

        const [totalQualificationVerified, totalDocumentsVerified] = await Promise.all([
            // Count students with ANY approved qualification
            prisma.student.count({
                where: {
                    ...whereDate,
                    academicQualifications: {
                        some: {
                            verificationStatus: 'APPROVED'
                        }
                    }
                }
            }),

            // Count students with ANY approved document (excluding ALLOTMENT_ORDER)
            prisma.student.count({
                where: {
                    ...whereDate,
                    documents: {
                        some: {
                            status: StudentDocumentStatus.APPROVED,
                            documentKey: { not: 'ALLOTMENT_ORDER' }
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

    /**
     * Get Allocated Seats Count by Degree Type
     */
    async getDegreeSeatAllocatedStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);
        const whereDate = dateFilter ? { createdAt: dateFilter } : {};

        const [studentStats, courseStats] = await Promise.all([
            // 1. Count actual students with allotted seats (Filled Count)
            prisma.student.groupBy({
                by: ['degreeType'],
                where: {
                    ...whereDate,
                    admissionDetails: {
                        allottedCourseId: { not: null }
                    }
                },
                _count: {
                    id: true
                }
            }),

            // 2. Sum total seats from Courses (Total Capacity - Master Data)
            // Use isDeleted: { not: true } to include nulls if any, though default is false.
            prisma.course.groupBy({
                by: ['degree'],
                _sum: {
                    totalSeats: true
                },
                where: {
                    isDeleted: { not: true }
                }
            })
        ]);

        // Merge results
        const stats: Record<string, { total: number, filled: number }> = {};

        // Process Course Capacity first - Ensure all available degrees are listed
        courseStats.forEach(c => {
            if (c.degree) {
                stats[c.degree] = { 
                    total: c._sum.totalSeats || 0, 
                    filled: 0 
                };
            }
        });

        // Overlay Student Filled Counts
        studentStats.forEach(s => {
            if (s.degreeType) {
                if (!stats[s.degreeType]) {
                    // This happens if a student has a degreeType that isn't in Courses (or mismatched spelling)
                    stats[s.degreeType] = { total: 0, filled: 0 };
                }
                stats[s.degreeType].filled = s._count.id;
            }
        });

        return stats;
    },

    /**
     * Get Allocated Seats Count by Gender
     */
    async getGenderSeatAllocatedStats(range?: string, startDate?: string, endDate?: string) {
        const dateFilter = getDateCondition(range, startDate, endDate);
        const whereDate = dateFilter ? { createdAt: dateFilter } : {};

        const result = await prisma.student.groupBy({
            by: ['gender'],
            where: {
                ...whereDate,
                admissionDetails: {
                    allottedCourseId: { not: null }
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

    /**
     * Get Student Trends for specific time ranges
     * @param rangeType '7d' | '10d' | '1m' | '3m'
     */
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
                dateLimit.setDate(dateLimit.getDate() - 7); // Default 7 days
        }

        // Get daily counts
        const students = await prisma.student.groupBy({
            by: ['createdAt'],
            where: {
                createdAt: {
                    gte: dateLimit
                }
            },
            _count: {
                id: true
            }
        });

        // Group by Date String (YYYY-MM-DD) manually since Prisma groupBy on Date includes time
        // Better approach: Fetch raw records and aggregate in JS for flexibility or use raw query if perf needed
        // For simplicity and standard usage:
        const rawStudents = await prisma.student.findMany({
            where: { createdAt: { gte: dateLimit } },
            select: { createdAt: true }
        });

        const trendMap: Record<string, number> = {};
        
        rawStudents.forEach(s => {
            const dateStr = (s.createdAt ?? new Date()).toISOString().split('T')[0];
            trendMap[dateStr] = (trendMap[dateStr] || 0) + 1;
        });

        // Fill missing dates with 0
        const result = [];
        const today = new Date();
        for (let d = new Date(dateLimit); d <= today; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
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

    /**
     * Get Students Registered in a specific time range
     * @param rangeType '7d' | '10d' | '1m' | '3m'
     */
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

        // === SEARCH CONDITION ===
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

        // === TYPE FILTER CONDITION ===
        let typeCondition: any = {};

        // "Not allocated" — allottedCourseId null AND status NOT in (CANCELLED, ENROLLED)
        // AND student must have at least one APPROVED academic qualification
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

        // "Allocated" — allottedCourseId not null AND status NOT in (CANCELLED, ENROLLED)
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

        // === COMBINE: use AND so search OR and type OR never collide ===
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
                    scholarshipAllocation: {
                        select: {
                            rule: {
                                select: {
                                    discountPercentage: true,
                                    name: true
                                }
                            }
                        }
                    },
                    proId: true,
                    pro: { select: { proNumber: true } }
                },
                orderBy: { createdAt: 'desc' }
            })
        ]);

        return {
            total,
            page,
            totalPages: Math.ceil(total / limit),
            data: students
        };
    },


    /**
     * Get All Course Codes
     */
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

    /**
     * Get summary counts for Seat Allocation Stats
     */
    async getSeatAllocationCounts(filter?: string) {
        const result: any = {};
        // 1. Not Allocated (exclude CANCELLED + ENROLLED admissions, require APPROVED qualification)
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

        // 2. Allocated - Breakdown by Eligibility (exclude CANCELLED + ENROLLED, allow null status)
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


    /**
     * Get Course Statistics (Seats Filled vs Total)
     */
    async getCourseSeatStats() {
        // Compute filled seats dynamically from StudentAdmission, excluding CANCELLED students
        const courses = await prisma.course.findMany({
            where: { isDeleted: false },
            select: {
                id: true,
                code: true,
                name: true,
                totalSeats: true,
                _count: {
                    select: {
                        allottedStudents: {
                            where: {
                                allottedCourseId: { not: null },
                                OR: [
                                    { status: null },
                                    { status: { not: 'CANCELLED' } }
                                ]
                            }
                        }
                    }
                }
            },
            orderBy: { name: 'asc' }
        });

        return courses.map(c => {
            const filled = c._count.allottedStudents;
            const total = c.totalSeats || 0;
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
