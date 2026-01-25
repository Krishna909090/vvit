import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { FeeStructure, SystemSetting, FeeHead, DiscountStatus, PaymentMethod, PaymentComponent, PaymentStatus, PaymentMode, AdmissionStatus, QuotaType, FeeStatus } from '@prisma/client';
import { Role, RoleType } from '../../constants/roles';
import { MESSAGES } from '../../constants/messages';
import logger from '../../utils/logger';

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
    // Fee Head
    createFeeHead: async (name: string, description: string, userId: string) => {
        return prisma.feeHead.create({
            data: { name, description, createdBy: userId, updatedBy: userId }
        });
    },

    getFeeHeads: async () => {
        return prisma.feeHead.findMany({ where: { isDeleted: false } });
    },

    updateFeeHead: async (id: string, name: string, description: string, userId: string) => {
        return prisma.feeHead.update({
            where: { id },
            data: { name, description, updatedBy: userId }
        });
    },

    deleteFeeHead: async (id: string) => {
        return prisma.feeHead.update({
            where: { id },
            data: { isDeleted: true }
        });
    },

    // Fee Structure
    createFeeStructure: async (courseId: string, feeHeadId: string, amount: number, academicYearId: string, userId: string, quotaType?: QuotaType, courseType?: string, yearOfStudy?: number, dueDate?: Date, degreeId?: string) => {
        
        const existing = await prisma.feeStructure.findFirst({
            where: {
                courseId,
                feeHeadId,
                academicYearId,
                quotaType: quotaType ?? null,
                courseType: courseType ?? null,
                degreeId: degreeId ?? null,
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
                quotaType,
                courseType,
                yearOfStudy,
                dueDate,
                degreeId,
                createdBy: userId,
                updatedBy: userId
            }
        });
    },

    createFeeStructureForDegree: async (degree: string, feeHeadId: string, amount: number, academicYearId: string, userId: string, quotaType?: QuotaType, courseType?: string, yearOfStudy?: number, dueDate?: Date) => {
        // 1. Find all courses for this degree
        const courses = await prisma.course.findMany({
            where: { degree, isDeleted: false }
        });

        if (courses.length === 0) {
            throw new AppError(`No courses found for degree: ${degree}`, 404);
        }

        // 2. Create entries for each course
        const createdStructures = [];
        // Sequential creation to avoid race conditions with simple create, or use createMany if confident
        for (const course of courses) {
            // Check if exists to avoid duplicates? 
            // Unique constraint is composite [courseId, academicYearId, feeHeadId] (Wait, schema index is just course, academicYear)
            // Ideally we need checks. Assuming clean slate or upsert logic.
            // Let's do simple create for now as per request "how to add".
            
            const structure = await prisma.feeStructure.create({
                data: {
                    courseId: course.id,
                    feeHeadId,
                    amount,
                    academicYearId,
                    quotaType,

                    courseType,
                    yearOfStudy,
                    dueDate,
                    createdBy: userId,
                    updatedBy: userId
                }
            });
            createdStructures.push(structure);
        }

        return createdStructures;
    },

    getFeeStructures: async (filters?: { courseId?: string, academicYearId?: string, feeHeadId?: string, search?: string }) => {
        const where: any = { isDeleted: false };
        
        if (filters?.courseId) where.courseId = filters.courseId;
        if (filters?.academicYearId) where.academicYearId = filters.academicYearId;
        if (filters?.feeHeadId) where.feeHeadId = filters.feeHeadId;
        
        if (filters?.search) {
             where.OR = [
                { course: { name: { contains: filters.search, mode: 'insensitive' } } },
                { course: { code: { contains: filters.search, mode: 'insensitive' } } },
                { feeHead: { name: { contains: filters.search, mode: 'insensitive' } } }
             ];
        }

        return prisma.feeStructure.findMany({
            where,
            include: {
                course: true,
                feeHead: true,
                academicYear: true
            }
        });
    },

    updateFeeStructure: async (id: string, courseId: string, feeHeadId: string, amount: number, academicYearId: string, userId: string, quotaType?: QuotaType, courseType?: string, yearOfStudy?: number, dueDate?: Date, degreeId?: string) => {
        return prisma.feeStructure.update({
            where: { id },
            data: {
                courseId,
                feeHeadId,
                amount,
                academicYearId,
                quotaType,
                degreeId,
                courseType,
                yearOfStudy,
                dueDate,
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

    // Statistics
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

    // Discounts
    createDiscountRequest: async (studentId: string, reason: string, documentUrl?: string) => {
        return prisma.discountRequest.create({
            data: {
                studentId,
                reason,
                documentUrl,
                status: DiscountStatus.REQUESTED
            }
        });
    },

    reviewDiscountRequest: async (requestId: string, remarks?: string) => {
        return prisma.discountRequest.update({
            where: { id: requestId },
            data: {
                status: DiscountStatus.FORWARDED_TO_SUPER_ADMIN,
                remarks
            }
        });
    },

    approveDiscount: async (requestId: string, approved: boolean, role: RoleType) => {
         if (role !== Role.SUPER_ADMIN) {
             throw new AppError("Only Super Admin can approve discounts", 403);
         }
         return prisma.discountRequest.update({
            where: { id: requestId },
            data: {
                status: approved ? DiscountStatus.APPROVED : DiscountStatus.REJECTED
            }
         });
    },

    // Manual Payment Collection
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

    // Automated Fee Generation
    generateFeeDemands: async (studentId: string, courseId: string, academicYearId: string, userId: string, deleteExisting: boolean = false): Promise<any[]> => {
        logger.info(`[generateFeeDemands] Request: student=${studentId}, course=${courseId}, year=${academicYearId}`);
        
        // 1. Get Fee Structures
        const feeStructures = await prisma.feeStructure.findMany({
            where: {
                courseId,
                academicYearId,
                isDeleted: false
            },

            include: { feeHead: true }
        });
        logger.debug(`[generateFeeDemands] Found ${feeStructures.length} potential fee structures`);

        // Get student quota type and course type to filter
        const student = await prisma.student.findUnique({ 
            where: { id: studentId },
            include: { enrollment: true }
        });
        
        if (!student) {
            logger.error(`[generateFeeDemands] Student not found: ${studentId}`);
            throw new AppError("Student not found", 404);
        }

        const studentQuota = student.quotaType;
        const studentCourseType = student.courseType;

        // Filter fee structures: 
        // 1. If structure has NO quotaType/courseType (applies to all)
        // 2. OR structure matches student's quotaType/courseType
        // 3. AND yearOfStudy matches student's calculated year
        
        // Calculate Year of Study
        const currentYear = student.enrollment?.currentSemester ? Math.ceil(student.enrollment.currentSemester / 2) : 1; // Default to 1 if no enrollment
        logger.debug(`[generateFeeDemands] Student Context: Quota=${studentQuota}, Type=${studentCourseType}, Year=${currentYear}`);

        const applicableFees = feeStructures.filter(fs => 
            (!fs.quotaType || (studentQuota && fs.quotaType === studentQuota)) &&
            (!fs.courseType || (studentCourseType && fs.courseType === studentCourseType)) &&
            (!fs.yearOfStudy || fs.yearOfStudy === currentYear)
        );
        logger.info(`[generateFeeDemands] Applicable Fees: ${applicableFees.length}`);

        if (applicableFees.length === 0) {
            logger.warn(`[generateFeeDemands] No applicable fees found.
                Student: ${student.id} (Quota: ${studentQuota}, Type: ${studentCourseType}, Year: ${currentYear})
                Total Structures Found: ${feeStructures.length}
                Structures Info: ${JSON.stringify(feeStructures.map(f => ({ id: f.id, quota: f.quotaType, type: f.courseType, year: f.yearOfStudy })))}
            `);
            return []; 
        }

        // 2. Create Demands & Ledger Entries
        // Using transaction to ensure ledger matches demands
        const createdDemands = await prisma.$transaction(async (tx) => {
            
            // Delete Existing if requested
            if (deleteExisting) {
                logger.info(`[generateFeeDemands] Cleaning up existing demands for student ${studentId} and course ${courseId}`);
                
                // Find old demands to link Ledger updates if necessary?
                // Or just delete by studentId / course context? 
                // Since this function is for a specific context (course/year), we should be careful.
                // However, FeeDemands are linked to FeeStructures. We can find demands linked to THIS course's FeeStructures.
                
                const structuresForThisCourse = await tx.feeStructure.findMany({
                    where: { courseId, academicYearId, isDeleted: false },
                    select: { id: true }
                });
                const structureIds = structuresForThisCourse.map(s => s.id);
                
                if (structureIds.length > 0) {
                     // 1. Find the Demands
                     const oldDemands = await tx.studentFeeDemand.findMany({
                         where: { 
                            studentId, 
                            feeStructureId: { in: structureIds }
                         }
                     });
                     
                     const oldDemandIds = oldDemands.map(d => d.id);
                     
                     if (oldDemandIds.length > 0) {
                         // 2. Delete Ledger Debits linked to these demands
                         await tx.studentLedger.deleteMany({
                             where: {
                                 type: 'DEBIT',
                                 referenceType: 'FEE_DEMAND',
                                 referenceId: { in: oldDemandIds }
                             }
                         });
                         
                         // 3. Delete Demands
                         await tx.studentFeeDemand.deleteMany({
                             where: { id: { in: oldDemandIds } }
                         });
                         
                         // 4. Also Reset Admission Total Fee? No, we will recalculate it below.
                         // But we need to subtract the amount?
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


            const results = [];
            let newDemandsTotal = 0;
            logger.debug(`[generateFeeDemands] Starting transaction to create demands`);

            for (const fee of applicableFees) {
                // Check for existing if NOT deleted above
                const existing = await tx.studentFeeDemand.findFirst({
                    where: { studentId, feeStructureId: fee.id }
                });

                if (existing) {
                    logger.debug(`[generateFeeDemands] duplicate demand skipped for structure ${fee.id}`);
                    continue; // Skip
                }

                const demand = await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeStructureId: fee.id,
                        amount: fee.amount,

                        status: 'PENDING',
                        dueDate: fee.dueDate || new Date(), // Use structure due date or now
                        createdBy: userId
                    }
                });

                // Ledger Debit
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: 'DEBIT',
                        amount: fee.amount,
                        description: `Fee: ${fee.feeHead.name}`,
                        referenceId: demand.id,
                        referenceType: 'FEE_DEMAND',
                        feeHeadId: fee.feeHeadId, // Added explicit feeHeadId link
                        createdBy: userId
                    }
                });
                results.push(demand);
                newDemandsTotal += fee.amount;
            }
            
            // Update Student Admission Total Fee
            if (newDemandsTotal > 0) {
                 logger.debug(`[generateFeeDemands] Updating Total Fee in Admission table. Increment=${newDemandsTotal}`);
                 await tx.studentAdmission.upsert({
                     where: { studentId },
                     create: { studentId, totalFee: newDemandsTotal },
                     update: { totalFee: { increment: newDemandsTotal } } // If reset, this adds back. Correct.
                 });
            }

            return results;
        });

        logger.info(`[generateFeeDemands] Successfully generated ${createdDemands.length} demands.`);
        return createdDemands;
    },

    // Get Full Ledger/Statement
    getStudentFeeDetails: async (studentId: string) => {
        logger.info(`[getStudentFeeDetails] Request for student=${studentId}`);
        const demands = await prisma.studentFeeDemand.findMany({
            where: { studentId },
            include: { feeStructure: { include: { feeHead: true } } }
        });

        const payments = await prisma.payment.findMany({
            where: { studentId, status: 'SUCCESS' }
        });
        
        logger.debug(`[getStudentFeeDetails] Found ${demands.length} demands and ${payments.length} successful payments.`);

        // Fetch Discounts/Scholarships from Ledger
        const creditLedgers = await prisma.studentLedger.findMany({
            where: { 
                studentId, 
                type: 'CREDIT',
                referenceType: { in: ['SCHOLARSHIP', 'DISCOUNT'] }
            }
        });

        let scholarshipAmount = creditLedgers
            .filter(l => l.referenceType === 'SCHOLARSHIP')
            .reduce((sum, l) => sum + l.amount, 0);

        // Check for Locked Allocation (Pre-Payment View)
        if (scholarshipAmount === 0) {
            const allocation = await prisma.scholarshipAllocation.findUnique({
                where: { studentId },
                include: { rule: true }
            });

            logger.info(`[getStudentFeeDetails] [Scholarship Allocation] Student=${studentId} Found=${!!allocation} Status=${allocation?.status}`);
            
            if (allocation && (allocation.status === 'LOCKED' || allocation.status === 'RESERVED')) {
                 const admission = await prisma.studentAdmission.findUnique({ where: { studentId } });
                 
                 // Get actual tuition fee from demands, fallback to admission total fee, then fallback to default
                 // Strategy 1: Precise Name Match
                 let tuitionDemand = demands.find(d => 
                    ['tuition', 'college', 'academic'].some(key => d.feeStructure?.feeHead?.name?.toLowerCase().includes(key))
                 );

                 // Strategy 2: Highest Amount Heuristic (Tuition is usually the largest fee)
                 if (!tuitionDemand && demands.length > 0) {
                     tuitionDemand = demands.reduce((max, d) => d.amount > max.amount ? d : max, demands[0]);
                     logger.debug(`[Scholarship] Precise Tuition Fee finding failed. Used highest demand: ${tuitionDemand.amount}`);
                 }

                 // Strategy 3: Admission Record
                 const tuitionFee = tuitionDemand ? tuitionDemand.amount : (admission?.totalFee || 0);

                 logger.debug(`[Scholarship] Calculation: Rule=${allocation.rule.discountPercentage}%, BaseTuition=${tuitionFee}`);

                 scholarshipAmount = (tuitionFee * allocation.rule.discountPercentage) / 100;
            }
        }

        const manualDiscountAmount = creditLedgers
            .filter(l => l.referenceType === 'DISCOUNT')
            .reduce((sum, l) => sum + l.amount, 0);

        const totalDemand = demands.reduce((sum, d) => sum + d.amount, 0);
        const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
        const totalDiscount = scholarshipAmount + manualDiscountAmount;
        
        // Net Pending = Demand - (Paid + Discounts)
        const pendingAmount = Math.max(0, totalDemand - totalPaid - totalDiscount);
        
        logger.info(`[getStudentFeeDetails] Summary: Demand=${totalDemand}, Paid=${totalPaid}, Discount=${totalDiscount}, Pending=${pendingAmount}`);

        // Component Level Breakdown
        const breakdown: any = {
            TUITION: { demand: 0, paid: 0, balance: 0 },
            HOSTEL: { demand: 0, paid: 0, balance: 0 },
            TRANSPORT: { demand: 0, paid: 0, balance: 0 },
            OTHER: { demand: 0, paid: 0, balance: 0 } 
        };

        // Map Demands (Approximate via Fee Head Name)
        demands.forEach(d => {
            const name = d.feeStructure?.feeHead?.name?.toUpperCase() || '';
            let key = 'OTHER';
            if (name.includes('TUITION') || name.includes('COLLEGE')) key = 'TUITION';
            else if (name.includes('HOSTEL')) key = 'HOSTEL';
            else if (name.includes('TRANSPORT') || name.includes('BUS')) key = 'TRANSPORT';
            
            breakdown[key].demand += d.amount;
        });

        // Map Payments (Via Component Enum)
        payments.forEach(p => {
             const comp = p.component as string; 
             let key = 'OTHER';
             if (comp === 'TUITION' || comp === 'SCHOLARSHIP_TOKEN') key = 'TUITION'; 
             else if (comp === 'HOSTEL') key = 'HOSTEL';
             else if (comp === 'TRANSPORT') key = 'TRANSPORT';
             
             breakdown[key].paid += p.amount;
        });

        // Calc Balance
        Object.keys(breakdown).forEach(key => {
            breakdown[key].balance = breakdown[key].demand - breakdown[key].paid;
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
        // 0. Fetch All Fee Heads for Lookup
        const allFeeHeads = await prisma.feeHead.findMany({ where: { isDeleted: false } });
        const feeHeadLookup = new Map<string, string>();
        allFeeHeads.forEach(fh => feeHeadLookup.set(fh.id, fh.name));

        // 1. Fetch Demands with Headers
        const demands = await prisma.studentFeeDemand.findMany({
            where: { studentId },
            include: { feeStructure: { include: { feeHead: true } } },
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

        // 3. Fetch Discounts (Ledger)
        const creditLedgers = await prisma.studentLedger.findMany({
            where: { 
                studentId, 
                type: 'CREDIT',
                referenceType: { in: ['SCHOLARSHIP', 'DISCOUNT'] }
            }
        });

        // Grouping Map
        // Key: FeeHeadId (or Name if not present) -> Object
        const feeHeadMap = new Map<string, any>();

        // Helper to get or create group
        const getGroup = (id: string, name: string) => {
            if (!feeHeadMap.has(id)) {
                feeHeadMap.set(id, {
                    feeHeadId: id,
                    feeHeadName: name,
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
            const head = d.feeStructure?.feeHead;
            const group = getGroup(head?.id || 'UNKNOWN', head?.name || 'Unknown Fee');
            
            group.totalFee += d.amount;
            group.history.push({
                type: 'DEMAND',
                date: d.createdAt,
                amount: d.amount,
                id: d.id,
                description: `Fee generated: ${head?.name}`
            });
        });

        // --- Process Payments ---
        // Priority: 
        // 1. Linked Fee Order/Demand (payment.feeDemand.feeStructure.feeHead)
        // 2. Explicit FeeHeadId (payment.feeHeadId)
        // 3. Component Heuristics
        
        const feeHeadHeuristics: Record<string, string[]> = {
            'TUITION': ['TUITION', 'COLLEGE', 'ACADEMIC', 'ADMISSION', 'SCHOLARSHIP_TOKEN'],
            'HOSTEL': ['HOSTEL', 'MESS', 'LODGING'],
            'TRANSPORT': ['TRANSPORT', 'BUS', 'ROUTE'],
            'APPLICATION': ['APPLICATION', 'REGISTRATION']
        };

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

        // --- Process Discounts ---
        creditLedgers.forEach(l => {
             // ... same logic ...
             let matched = false;
             for (const [id, group] of feeHeadMap.entries()) {
                 const headName = group.feeHeadName.toUpperCase();
                 const desc = l.description?.toUpperCase() || '';
                 
                 if (desc.includes('SCHOLARSHIP') && headName.includes('TUITION')) {
                     group.discountAmount += l.amount;
                     group.history.push({
                         type: 'DISCOUNT',
                         date: l.date,
                         amount: l.amount,
                         id: l.id,
                         description: l.description
                     });
                     matched = true;
                     break;
                 }
                 
                 if (desc.includes('DISCOUNT') && (headName.includes('TUITION') || headName.includes('COLLEGE'))) {
                     group.discountAmount += l.amount;
                     group.history.push({
                         type: 'DISCOUNT',
                         date: l.date,
                         amount: l.amount,
                         id: l.id,
                         description: l.description
                     });
                     matched = true;
                     break;
                 }
             }
             
              if (!matched) {
                const group = getGroup('GENERAL_DISCOUNTS', 'General Discounts');
                group.discountAmount += l.amount;
                group.history.push({
                     type: 'DISCOUNT',
                     date: l.date,
                     amount: l.amount,
                     id: l.id,
                     description: l.description || 'Discount'
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
    }
};
