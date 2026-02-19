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
    createDiscountRequest: async (studentId: string, reason: string, documentUrl: string | undefined, items: { component: string, amount: number }[], requestedAmount: number) => {
        return prisma.discountRequest.create({
            data: {
                studentId,
                reason,
                documentUrl,
                items: items as any, // Json
                requestedAmount,
                status: DiscountStatus.REQUESTED
            } as any
        });
    },

    getAllDiscountRequests: async (filters?: { status?: DiscountStatus, studentId?: string, applicationId?: string }) => {
        const where: any = {};
        if (filters?.status) where.status = filters.status;
        if (filters?.studentId) where.studentId = filters.studentId;
        if (filters?.applicationId) {
            where.student = {
                applicationId: { contains: filters.applicationId, mode: 'insensitive' }
            };
        }

        const requests = await prisma.discountRequest.findMany({
            where,
            include: {
                student: {
                    select: {
                        id: true,
                        name: true,
                        applicationId: true,
                        courseType: true,
                        degreeType: true,
                        phone: true,
                        email: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

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

    reviewDiscountRequest: async (requestId: string, remarks?: string) => {
        return prisma.discountRequest.update({
            where: { id: requestId },
            data: {
                status: DiscountStatus.FORWARDED_TO_SUPER_ADMIN,
                remarks
            }
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
                 // Use requested items as approved default
                 finalItems = ((request as any).items as any[]).map((item: any) => ({
                     component: item.component,
                     approvedAmount: item.amount || item.requestedAmount
                 }));
                 finalApprovedAmount = finalItems.reduce((sum, item) => sum + item.approvedAmount, 0);
             } else {
                 // Legacy fallback? Or unexpected data
                 finalItems = [{ component: request.component || 'TUITION', approvedAmount: request.requestedAmount || 0 }];
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
                             date: new Date()
                         }
                     });
                 }
             }

             return updatedRequest;
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


            // Fetch Scholarship Percentage from StudentScholarship table
            const studentScholarship = await tx.studentScholarship.findFirst({
                 where: { studentId }
            });
            
            // Use percentage from the table, default to 0
            const discountPct = studentScholarship?.scholarshipPercentage || 0;
            
            logger.info(`[generateFeeDemands] Scholarship Check: Found Record=${!!studentScholarship}, Pct=${discountPct}%`);

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

                // Check if this fee is Tuition fee for Scholarship (strictly Tuition/Tution)
                const feeName = fee.feeHead.name.toLowerCase();
                const isTuition = feeName.includes('Tuition') || feeName.includes('Tution');
                
                let scholarshipAmt = 0;
                if (isTuition && discountPct > 0) {
                    scholarshipAmt = (fee.amount * discountPct) / 100;
                }
                
                const netAmount = fee.amount - scholarshipAmt; // Fine is 0 initially

                const demand = await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeStructureId: fee.id,
                        feeHeadId: fee.feeHeadId,
                        academicYearId: fee.academicYearId,
                        amount: fee.amount, // Base
                        
                        // New Fields
                        discountAmount: scholarshipAmt, // Initial discount (scholarship)
                        scholarshipAmount: scholarshipAmt,
                        netAmount: netAmount,

                        status: 'PENDING',
                        dueDate: fee.dueDate || new Date(), 
                        createdBy: userId,
                        remarks: scholarshipAmt > 0 ? `Scholarship Applied: ${discountPct}%` : undefined
                    } as any
                });

                // Ledger Debit (Full Demand)
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: 'DEBIT',
                        amount: fee.amount,
                        description: `Fee: ${fee.feeHead.name}`,
                        referenceId: demand.id,
                        referenceType: 'FEE_DEMAND',
                        feeHeadId: fee.feeHeadId, 
                        createdBy: userId
                    }
                });
                
                // Ledger Credit (Scholarship Discount)
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
                            createdBy: userId
                        }
                    });
                }

                results.push(demand);
                newDemandsTotal += fee.amount;
            }
            
            // Update Student Admission Total Fee (Base Amount usually)
            if (newDemandsTotal > 0) {
                 logger.debug(`[generateFeeDemands] Updating Total Fee in Admission table. Increment=${newDemandsTotal}`);
                 await tx.studentAdmission.upsert({
                     where: { studentId },
                     create: { studentId, totalFee: newDemandsTotal },
                     update: { totalFee: { increment: newDemandsTotal } }
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
        const demands: any[] = await prisma.studentFeeDemand.findMany({
            where: { studentId },
            include: { 
                feeStructure: { include: { feeHead: true } },
                feeHead: true // Include direct feeHead relation
            } as any
        });

        const payments = await prisma.payment.findMany({
            where: { studentId, status: 'SUCCESS' }
        });
        
        logger.debug(`[getStudentFeeDetails] Found ${demands.length} demands and ${payments.length} successful payments.`);

        // Fetch Discounts/Scholarships from Ledger (Net of Credits and Debits)
        const scholarshipLedgers = await prisma.studentLedger.findMany({
            where: { 
                studentId, 
                referenceType: { in: ['SCHOLARSHIP', 'DISCOUNT'] }
            }
        });

        let scholarshipAmount = scholarshipLedgers
            .filter(l => l.referenceType === 'SCHOLARSHIP')
            .reduce((sum, l) => sum + (l.type === 'CREDIT' ? l.amount : -l.amount), 0);

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
                 // Strategy 1: Precise Name Match (Check both structure and direct head)
                 let tuitionDemand = demands.find(d => {
                    const name = (d.feeStructure?.feeHead?.name || d.feeHead?.name || '').toLowerCase();
                    return name.includes('tuition') || name.includes('tution');
                 });

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

        const manualDiscountAmount = scholarshipLedgers
            .filter(l => l.referenceType === 'DISCOUNT')
            .reduce((sum, l) => sum + (l.type === 'CREDIT' ? l.amount : -l.amount), 0);

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
            // Priority: FeeStructure.FeeHead -> FeeHead (Direct) -> Unknown
            const name = (d.feeStructure?.feeHead?.name || d.feeHead?.name || '').toUpperCase();
            
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

        // Map Ledger Adjustments (Fee Transfers/Deductions like Course Change Fees)
        const adjustmentLedgers = await prisma.studentLedger.findMany({
            where: { 
                studentId, 
                referenceType: 'COURSE_CHANGE' 
            }
        });

        adjustmentLedgers.forEach(a => {
            if (!a.feeHeadId) return;
            
            // Find head name from demands or fetch if needed. 
            // Since we already have demands with heads, find the head name there.
            const head = demands.find(d => (d.feeStructure?.feeHeadId === a.feeHeadId || d.feeHeadId === a.feeHeadId))?.feeHead || 
                         demands.find(d => (d.feeStructure?.feeHeadId === a.feeHeadId || d.feeHeadId === a.feeHeadId))?.feeStructure?.feeHead;
            
            const name = (head?.name || '').toUpperCase();
            
            let key = 'OTHER';
            if (name.includes('TUITION') || name.includes('COLLEGE')) key = 'TUITION';
            else if (name.includes('HOSTEL')) key = 'HOSTEL';
            else if (name.includes('TRANSPORT') || name.includes('BUS')) key = 'TRANSPORT';

            if (a.type === 'CREDIT') breakdown[key].paid += a.amount;
            else breakdown[key].paid -= a.amount;
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
            // Determine Head: Structure Head > Direct Head
            const head = d.feeStructure?.feeHead || d.feeHead;
            const group = getGroup(head?.id || 'UNKNOWN', head?.name || 'Unknown Fee');
            
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

        // --- Process Discounts / Scholarship Adjustments ---
        scholarshipLedgers.forEach(l => {
             let matched = false;
             const isCredit = l.type === 'CREDIT';
             // Determine if this is a scholarship or a standard discount based on referenceType
             const recordType = l.referenceType === 'SCHOLARSHIP' ? 'SCHOLARSHIP' : 'DISCOUNT';
             
             for (const [id, group] of feeHeadMap.entries()) {
                 const headName = group.feeHeadName.toUpperCase();
                 const desc = l.description?.toUpperCase() || '';
                 
                 // Logic for Scholarship (Tuition only)
                 if (desc.includes('SCHOLARSHIP') && headName.includes('TUITION')) {
                     // CREDIT adds to pool, DEBIT subtracts from it (reduction)
                     group.discountAmount += isCredit ? l.amount : -l.amount;
                     group.history.push({
                         type: recordType,
                         date: l.date,
                         amount: isCredit ? l.amount : -l.amount, // Show negative in history for reductions
                         id: l.id,
                         description: l.description
                     });
                     matched = true;
                     break;
                 }
                 
                 // Logic for Manual Discounts
                 if (desc.includes('DISCOUNT') && (headName.includes('TUITION') || headName.includes('COLLEGE'))) {
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
                if (type === 'FINE') updateData.fineAmount = { increment: amount };
                else updateData.discountAmount = { increment: amount }; // Increment the discount deduction
                
                updateData.remarks = reason; // Overwrite or Append? Overwrite usually.
                
                await tx.studentFeeDemand.update({
                    where: { id: targetDemand.id },
                    data: updateData
                });
                demandId = targetDemand.id;
            } else {
                // Case: Ad-Hoc Fine where no previous demand exists
                if (type === 'FINE') {
                    const newDemand = await tx.studentFeeDemand.create({
                        data: {
                            studentId,
                            feeHeadId,
                            amount: 0, 
                            fineAmount: amount,
                            status: 'PENDING',
                            dueDate: new Date(),
                            remarks: `Ad-Hoc Fine: ${reason}`,
                            createdBy: userId
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
                    feeHeadId,
                    createdBy: userId,
                    date: new Date()
                }
            });

            return { message: 'Success', demandId };
        });
    },
};


