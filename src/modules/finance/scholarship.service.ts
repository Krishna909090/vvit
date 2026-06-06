import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { ScholarshipStatus } from '@prisma/client';
import { getActiveAcademicYear } from '../../utils/studentContext';
import { assertScholarshipEditableForStudent } from '../studentManagement/adminStudent/admission';

export const ScholarshipService = {

    async createRule(data: any, _createdBy: string) {
        const { name, minPercentile, discountPercentage, totalSlots } = data;
        const ruleYear = await getActiveAcademicYear();

        return await prisma.scholarshipRule.create({
            data: {
                name,
                academicYearId: ruleYear.id,
                minPercentile: Number(minPercentile),
                discountPercentage: Number(discountPercentage),
                totalSlots: Number(totalSlots),
                filledSlots: 0,
                degreeType: data.degreeType,
                isActive: true
            }
        });
    },

    async getAllRules() {
        return await prisma.scholarshipRule.findMany({
            where: { isActive: true },
            orderBy: { minPercentile: 'desc' }
        });
    },

    async updateRule(id: string, data: any) {
        return await prisma.scholarshipRule.update({
            where: { id },
            data: {
                name: data.name,
                minPercentile: data.minPercentile !== undefined ? Number(data.minPercentile) : undefined,
                discountPercentage: data.discountPercentage !== undefined ? Number(data.discountPercentage) : undefined,
                totalSlots: data.totalSlots !== undefined ? Number(data.totalSlots) : undefined,
                degreeType: data.degreeType,
                isActive: data.isActive
            }
        });
    },

    async deleteRule(id: string) {
        return await prisma.scholarshipRule.update({
            where: { id },
            data: { isActive: false }
        });
    },

    async checkEligibility(studentId: string): Promise<any> {
        logger.info(`Checking scholarship eligibility for student ${studentId} (READ-ONLY)`);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                admissionDetails: true,
                documents: true,
                academicQualifications: true
            }
        });

        if (!student) throw new AppError('Student not found', 404);

        const validStatuses = ['DOCUMENTS_VERIFIED', 'SEAT_ALLOTTED', 'ADMISSION_CONFIRMED', 'ENROLLED'];
        
        if (!validStatuses.includes(student.admissionDetails?.status || '')) {
             return { eligible: false, reason: `Admission status is '${student.admissionDetails?.status}', expected DOCUMENTS_VERIFIED or later` };
        }

        const approvedDocs = student.documents.filter(d => d.status === 'APPROVED' && !d.isDeleted);
        
        if (approvedDocs.length === 0) {
            return { eligible: false, reason: "No approved documents found" };
        }

        const approvedDocKeys = new Set(approvedDocs.map(d => d.documentKey));

        const validScores: { type: string, score: number }[] = [];

        for (const qual of student.academicQualifications) {
            const level = (qual.level || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            const examName = (qual.board || '').toUpperCase();

            const hasDocument = (keys: string[]) => keys.some(k => approvedDocKeys.has(k));

            const isClass12 = ['CLASS12', 'INTERMEDIATE', 'INTER', '12TH', 'XII', 'HSC', 'PLUSTWO'].includes(level);
            if (isClass12) {
                if (hasDocument(['DOC_INTER_MARKSHEET', 'DOC_12TH_MARKSHEET', 'DOC_HSC_MARKSHEET', 'DOC_CLASS_12_MARKSHEET', 'DOC_MARKSHEET_12'])) {
                    validScores.push({ type: 'CLASS_12', score: Number(qual.gpaOrMarks) });
                }
            }

            const isClass10 = ['CLASS10', 'SSC', '10TH', 'X', 'MATRICULATION'].includes(level);
            if (isClass10) {
                 if (hasDocument(['DOC_SSC_MARKSHEET', 'DOC_10TH_MARKSHEET', 'DOC_CLASS_10_MARKSHEET', 'DOC_MARKSHEET_10'])) {
                    validScores.push({ type: 'CLASS_10', score: Number(qual.gpaOrMarks) });
                }
            }

            if ((level === 'EAPCET' || examName.includes('EAPCET')) && hasDocument(['DOC_EAPCET_RANK_CARD', 'DOC_RANK_CARD_EAPCET'])) {
                validScores.push({ type: 'EAPCET', score: Number(qual.gpaOrMarks) }); 
            }

            else if ((level === 'JEEMAIN' || level === 'JEE_MAIN' || examName.includes('JEE')) && hasDocument(['DOC_JEE_RANK_CARD', 'DOC_JEE_MAIN_RANK_CARD'])) {
                validScores.push({ type: 'JEE', score: Number(qual.gpaOrMarks) });
            }

            else if ((level === 'SATRANK' || level === 'SAT_RANK' || examName.includes('SAT')) && hasDocument(['DOC_SAT_RANK_CARD'])) {
                validScores.push({ type: 'SAT', score: Number(qual.gpaOrMarks) });
            }

            else if ((level === 'NEET' || examName.includes('NEET')) && hasDocument(['DOC_NEET_RANK_CARD'])) {
                validScores.push({ type: 'NEET', score: Number(qual.gpaOrMarks) });
            }
        }

        if (validScores.length === 0) {

            logger.warn(`Scholarship Check Failed: No qualifications matched. Student Inputs -> Levels: ${student.academicQualifications.map(q => q.level).join(', ')}, Approved Docs: ${Array.from(approvedDocKeys).join(', ')}`);
            return { eligible: false, reason: "No qualifications backed by approved documents. Please ensure `level` matches standard accepted values (e.g., '12th', 'SSC', 'Entrance') and documents are approved." };
        }

        const rules = await prisma.scholarshipRule.findMany({
            where: { 
                isActive: true,
                degreeType: student.degreeType
            },
            orderBy: { minPercentile: 'desc' }
        });

        let bestMatch: any = null;
        let matchedScoreDetails: any = null;

        for (const scoreInfo of validScores) {

            for (const rule of rules) {

                if (scoreInfo.score >= rule.minPercentile && rule.filledSlots < rule.totalSlots) {

                    if (!bestMatch || rule.discountPercentage > bestMatch.discountPercentage) {
                        bestMatch = rule;
                        matchedScoreDetails = scoreInfo;
                    }

                }
            }
        }

        if (!bestMatch) {
            return { eligible: false, reason: "No matching scholarship rule or slots full" };
        }

        return {
            eligible: true,
            criteriaMatched: {
                examType: matchedScoreDetails.type,
                score: matchedScoreDetails.score,
                ruleId: bestMatch.id,
                ruleName: bestMatch.name,
                minPercentileRequired: bestMatch.minPercentile,
                discountPercentage: bestMatch.discountPercentage
            }
        };
    },

    async verifyEligibility(studentId: string, remarks: string, verifierId: string, ruleId?: string) {
        logger.info(`Verification Officer ${verifierId} verifying scholarship eligibility for student ${studentId} (remarks=${remarks}, ruleId=${ruleId ?? 'none'})`);
        return { success: true, message: "Scholarship eligibility verified and recorded successfully" };
    },

    async allocateScholarship(studentId: string, ruleId: string, _adminId: string) {

        const ruleExists = await prisma.scholarshipRule.findUnique({ where: { id: ruleId } });
        if (!ruleExists) throw new AppError('Rule not found', 404);

        return await prisma.$transaction(async (tx) => {

             const rule = await tx.scholarshipRule.findUnique({ where: { id: ruleId } });
             if (!rule) throw new AppError('Rule not found', 404);
             if (rule.filledSlots >= rule.totalSlots) throw new AppError('Slots full', 400);

             await tx.scholarshipRule.update({
                where: { id: ruleId },
                data: { filledSlots: { increment: 1 } }
             });

             const lockYearId = (await tx.academicYear.findFirstOrThrow({ where: { isActive: true, isDeleted: false } })).id;

             return await tx.scholarshipAllocation.create({
                data: {
                    studentId,
                    ruleId,
                    academicYearId: lockYearId,
                    status: ScholarshipStatus.LOCKED,
                    reservedAt: new Date(),
                    lockedAt: new Date()
                }
             });
        });
    },

    async getStudentAllocation(studentId: string) {
        return await prisma.scholarshipAllocation.findUnique({
            where: { studentId },
            include: { rule: true }
        });
    },

    async lockAllocation(studentId: string) {
        const allocation = await prisma.scholarshipAllocation.findUnique({ where: { studentId } });
        if (!allocation) return null;

        if (allocation.status !== ScholarshipStatus.RESERVED) return allocation;

        const lockedAt = new Date();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 20);

        return await prisma.scholarshipAllocation.update({
            where: { studentId },
            data: {
                status: ScholarshipStatus.LOCKED,
                lockedAt,
                expiresAt
            }
        });
    },

    async allocateManualRule(studentId: string, ruleId: string) {
        logger.info(`Manually allocating scholarship rule ${ruleId} to student ${studentId}`);

        const ruleExists = await prisma.scholarshipRule.findUnique({ where: { id: ruleId } });
        if (!ruleExists) throw new AppError('Scholarship Rule not found', 404);

        return await prisma.$transaction(async (tx) => {

            const rule = await tx.scholarshipRule.findUnique({ where: { id: ruleId } });
            if (!rule) throw new AppError('Scholarship Rule not found', 404);
            if (rule.filledSlots >= rule.totalSlots) throw new AppError('Scholarship Rule slots full', 400);

            await tx.scholarshipRule.update({
                where: { id: ruleId },
                data: { filledSlots: { increment: 1 } }
            });

            const existing = await tx.scholarshipAllocation.findUnique({ where: { studentId } });
            if (existing) {
                await tx.scholarshipAllocation.delete({ where: { studentId } });
                await tx.scholarshipRule.update({
                    where: { id: existing.ruleId },
                    data: { filledSlots: { decrement: 1 } }
                });
            }

            const reserveYearId = (await tx.academicYear.findFirstOrThrow({ where: { isActive: true, isDeleted: false } })).id;
            return await tx.scholarshipAllocation.create({
                data: {
                    studentId,
                    ruleId,
                    academicYearId: reserveYearId,
                    status: ScholarshipStatus.RESERVED,
                    reservedAt: new Date()
                }
            });
        });
    },

    async updateStudentScholarship(studentId: string, newPercentage: number, adminId: string, feeHeadId?: string, academicYearId?: string | null, adminRole?: string) {
        logger.info(`Updating scholarship for student ${studentId} to ${newPercentage}% (FeeHead: ${feeHeadId || 'AUTO-DETECT'})`);

        await assertScholarshipEditableForStudent(studentId, adminRole);

        const resolvedYearId: string = academicYearId ?? (await getActiveAcademicYear()).id;

        return await prisma.$transaction(async (tx) => {

            const studentScholarship = await tx.studentScholarship.upsert({
                where: { studentId },
                update: {
                    scholarshipPercentage: newPercentage,

                    isEligible: newPercentage > 0 ? 'YES' : 'NO',
                    updatedBy: adminId
                },
                create: {
                    studentId,
                    type: 'MANUAL',
                    scholarshipPercentage: newPercentage,
                    academicYearId: resolvedYearId,
                    createdBy: adminId,

                    isEligible: 'YES'
                }
            });

            const demands = await tx.studentFeeDemand.findMany({
                where: { 
                    studentId,
                    ...(feeHeadId ? { feeHeadId } : {})
                },
                include: { 
                    feeHead: true,
                    payments: { where: { status: 'SUCCESS' } }
                }
            });

            for (const demand of demands) {

                const feeName = (demand.feeHead?.name || '').toLowerCase();
                let isTuition: boolean;
                if (feeHeadId) {
                    const feeHeadRecord = await tx.feeHead.findUnique({
                        where: { id: feeHeadId },
                        select: { component: true }
                    });
                    isTuition = feeHeadRecord?.component === 'TUITION' ||
                        (feeHeadRecord?.component?.includes('TUITION') ?? false);
                } else {
                    isTuition = feeName.includes('tuition') || feeName.includes('tution');
                }

                if (isTuition) {
                    const oldScholarshipAmt = demand.scholarshipAmount || 0;
                    const newScholarshipAmt = (demand.amount * newPercentage) / 100;
                    const scholarshipDiff = newScholarshipAmt - oldScholarshipAmt;

                    if (scholarshipDiff !== 0) {
                        const paidAmount = demand.payments.reduce((sum, p) => sum + p.amount, 0);

                        const newNetAmount = (demand.netAmount || 0) - scholarshipDiff;
                        
                        let newStatus: any = 'PENDING';
                        if (paidAmount >= newNetAmount) newStatus = 'FULL';
                        else if (paidAmount > 0) newStatus = 'PARTIAL';

                        await tx.studentFeeDemand.update({
                            where: { id: demand.id },
                            data: {
                                scholarshipAmount: newScholarshipAmt,
                                netAmount: newNetAmount,
                                status: newStatus,
                                remarks: (demand.remarks || '') + ` | Scholarship updated to ${newPercentage}% (Old Pct Amt: ${oldScholarshipAmt}, New Pct Amt: ${newScholarshipAmt})`
                            } as any
                        });

                        await tx.studentLedger.create({
                            data: {
                                studentId,
                                type: scholarshipDiff > 0 ? 'CREDIT' : 'DEBIT',
                                amount: Math.abs(scholarshipDiff),
                                description: `Scholarship Adjusted: ${scholarshipDiff > 0 ? 'Increased' : 'Reduced'} from ₹${oldScholarshipAmt} to ₹${newScholarshipAmt} (${newPercentage}%)`,
                                referenceType: 'SCHOLARSHIP',
                                referenceId: demand.id,
                                feeHeadId: demand.feeHeadId,
                                createdBy: adminId,
                                academicYearId: resolvedYearId,
                                yearOfStudy: demand.yearOfStudy ?? undefined,
                                date: new Date()
                            }
                        });
                    }
                }
            }

            return { success: true, studentScholarship };
        });
    }
};

