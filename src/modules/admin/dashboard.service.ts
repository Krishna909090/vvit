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
            const dateStr = s.createdAt.toISOString().split('T')[0];
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
    }
};
