import prisma from '../../config/prisma';
import { AdmissionStatus, PaymentStatus, PaymentComponent, StudentDocumentStatus, Payment } from '@prisma/client';

export const DashboardService = {
    /**
     * Get Comprehensive Dashboard Statistics
     * Aggregates key metrics for the admin dashboard
     */
    async getGlobalStats() {
        const [
            totalApplications,
            totalAmountPaid,
            pendingPaymentsCount,
            totalEntranceFeeCollected,
            totalSeatsAllotted,
            totalDocumentsVerified,
            totalDocumentsPending
        ] = await Promise.all([
            // 1. Total Applications
            prisma.student.count(),
            
            // 2. Total Amount Paid (Sum of all successful payments)
            prisma.payment.aggregate({
                where: { status: PaymentStatus.SUCCESS },
                _sum: { amount: true }
            }),

            // 3. Pending Payments (Count of students registered but not yet paid entrance fee)
            prisma.studentAdmission.count({
                where: { status: AdmissionStatus.REGISTERED }
            }),

            // 4. Total Entrance Fee Collected
            prisma.payment.aggregate({
                where: { 
                    status: PaymentStatus.SUCCESS,
                    component: PaymentComponent.APPLICATION_FEE
                },
                _sum: { amount: true }
            }),

            // 5. Total Seats Allotted
            prisma.studentAdmission.count({
                where: { status: AdmissionStatus.SEAT_ALLOTTED }
            }),

            // 6. Total Documents Verified (Students with ALL docs verified or Admission verified status)
            // Simplified: Counting students in DOCUMENTS_VERIFIED status
            prisma.studentAdmission.count({
                where: { status: AdmissionStatus.DOCUMENTS_VERIFIED }
            }),

            // 7. Documents Pending (Students in DOCUMENTS_PENDING or SUBMITTED status)
            prisma.studentAdmission.count({
                where: { status: { in: [AdmissionStatus.DOCUMENTS_PENDING, AdmissionStatus.DOCUMENTS_SUBMITTED] } }
            })
        ]);

        return {
            totalApplications,
            totalAmountPaid: totalAmountPaid._sum.amount || 0,
            pendingPaymentsCount,
            totalEntranceFeeCollected: totalEntranceFeeCollected._sum.amount || 0,
            totalSeatsAllotted,
            totalDocumentsVerified,
            totalDocumentsPending
        };
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
        let where: any = {};

        // === SEARCH LOGIC ===
        if (search) {
            where.OR = [
                { applicationId: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search, mode: 'insensitive' } },
                // Add Course Search
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
            ];
        }

        // === FILTER LOGIC ===
        // 1. Not Allocated (Only with Scholarship Allocation)
        if (type === 'not_allocated') {
            const notAllocatedCondition = {
                OR: [
                    { admissionDetails: null },
                    { admissionDetails: { allottedCourseId: null } }
                ]
            };
            where = { 
                ...where, 
                ...notAllocatedCondition,
                studentScholarship: { isNot: null }
            };
        } 
        // 2. Allocated (Any Scholarship Status)
        else if (type === 'allocated') {
            where = { ...where, admissionDetails: { allottedCourseId: { not: null } } };
        }
        // 3. Not Allocated AND Eligible (Scholarship YES)
        else if (type === 'not_allocated_eligible') {
            const notAllocatedCondition = {
                OR: [
                    { admissionDetails: null },
                    { admissionDetails: { allottedCourseId: null } }
                ]
            };
            where = { 
                ...where, 
                ...notAllocatedCondition,
                studentScholarship: { isEligible: 'YES' }
            };
        }
        // 3a. Not Allocated AND Not Eligible (Scholarship NO)
        else if (type === 'not_allocated_not_eligible') {
            const notAllocatedCondition = {
                OR: [
                    { admissionDetails: null },
                    { admissionDetails: { allottedCourseId: null } }
                ]
            };
            where = { 
                ...where, 
                ...notAllocatedCondition,
                studentScholarship: { isEligible: 'NO' }
            };
        }
        // 4. Allocated AND Eligible (Scholarship YES)
        else if (type === 'allocated_eligible') {
             where = { 
                ...where, 
                admissionDetails: { allottedCourseId: { not: null } },
                studentScholarship: { isEligible: 'YES' }
            };
        }
        // 4. Allocated AND Not Eligible (Scholarship NO)
        else if (type === 'allocated_not_eligible') {
             where = { 
                ...where, 
                admissionDetails: { allottedCourseId: { not: null } },
                studentScholarship: { isEligible: 'NO' }
            };
        }
        // 5. All Students (Only with Scholarship Record)
        else if (type === 'all') {
             where = { 
                ...where,
                studentScholarship: { isNot: null }
            };
        }

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
                    }
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
        // 1. Not Allocated
        if (!filter || filter === 'not_allocated') {
            result.notAllocated = await prisma.student.count({
                where: {
                    OR: [
                        { admissionDetails: null },
                        { admissionDetails: { allottedCourseId: null } }
                    ],
                    studentScholarship: { isNot: null }
                }
            });
        }

        // 2. Allocated - Breakdown by Eligibility
        if (!filter || filter === 'allocated') {
             const allocatedCondition = {
                admissionDetails: { allottedCourseId: { not: null } }
            };

            const [eligible, notEligible] = await Promise.all([
                // Eligible: YES
                prisma.student.count({
                    where: {
                        ...allocatedCondition,
                        studentScholarship: { isEligible: 'YES' }
                    }
                }),
                // Eligible: NO
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
        // Fetch courses with their allotted student count
        // We use the relation 'allottedStudents' in Course model
        const courses = await prisma.course.findMany({
            where: { isDeleted: false },
            select: {
                id: true,
                code: true,
                name: true,
                totalSeats: true,
                filledSeats: true, // This field exists but might not be auto-synced, good to double check via relation count if needed
                _count: {
                    select: { allottedStudents: true }
                }
            },
            orderBy: { name: 'asc' }
        });

        // Map to simpler format and ensure 'filled' is accurate based on actual count if preferred, 
        // or strictly follow existing logic. Ideally, we trust the DB count of relations.
        return courses.map(c => {
            const actualFilled = c._count.allottedStudents;
            const total = c.totalSeats || 0;
            return {
                id: c.id,
                code: c.code,
                name: c.name,
                totalSeats: total,
                filledSeats: actualFilled,
                remainingSeats: Math.max(0, total - actualFilled)
            };
        });
    }
};
