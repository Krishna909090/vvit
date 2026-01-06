import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { ScholarshipStatus } from '@prisma/client';

export const ScholarshipService = {
    async createRule(data: any, createdBy: string) {
        const { name, minPercentile, discountPercentage, totalSlots } = data;
        
        return await prisma.scholarshipRule.create({
            data: {
                name,
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

        // 1. Fetch Student, Admission, Documents, Qualifications
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                admissionDetails: true,
                documents: true,
                academicQualifications: true
            }
        });

        if (!student) throw new AppError('Student not found', 404);

        // 2. Admission Status Gate
        // Allow if documents are verified OR if they moved to later stages (Seat Allotted, Confirmed, etc)
        const validStatuses = ['DOCUMENTS_VERIFIED', 'SEAT_ALLOTTED', 'ADMISSION_CONFIRMED', 'ENROLLED'];
        
        if (!validStatuses.includes(student.admissionDetails?.status || '')) {
             return { eligible: false, reason: `Admission status is '${student.admissionDetails?.status}', expected DOCUMENTS_VERIFIED or later` };
        }

        // 3. Filter Approved Documents
        const approvedDocs = student.documents.filter(d => d.status === 'APPROVED' && !d.isDeleted);
        
        if (approvedDocs.length === 0) {
            return { eligible: false, reason: "No approved documents found" };
        }

        const approvedDocKeys = new Set(approvedDocs.map(d => d.documentKey));

        // 4. Validate Qualifications against Documents
        const validScores: { type: string, score: number }[] = [];

        for (const qual of student.academicQualifications) {
            const level = qual.level?.toUpperCase();
            const examName = (qual.board || '').toUpperCase(); // Helper to identify specific exams

            // 1. Class 12 / Intermediate
            if (level === 'CLASS_12' || level === 'INTERMEDIATE') {
                if (approvedDocKeys.has('DOC_INTER_MARKSHEET')) {
                    validScores.push({ type: 'CLASS_12', score: Number(qual.gpaOrMarks) });
                }
            }
            
            // 2. Entrance Exams
            if (level === 'ENTRANCE') {
                // EAPCET
                if (examName.includes('EAPCET') && approvedDocKeys.has('DOC_EAPCET_RANK_CARD')) {
                    validScores.push({ type: 'EAPCET', score: Number(qual.gpaOrMarks) });
                }
                // SAT
                else if (examName.includes('SAT') && approvedDocKeys.has('DOC_SAT_RANK_CARD')) {
                    validScores.push({ type: 'SAT', score: Number(qual.gpaOrMarks) });
                }
                // JEE
                else if (examName.includes('JEE') && approvedDocKeys.has('DOC_JEE_RANK_CARD')) {
                    validScores.push({ type: 'JEE', score: Number(qual.gpaOrMarks) });
                }
            }
        }

        if (validScores.length === 0) {
            return { eligible: false, reason: "No qualifications backed by approved documents" };
        }

        // 5. Fetch Rules (Filtered by Degree Type)
        const rules = await prisma.scholarshipRule.findMany({
            where: { 
                isActive: true,
                degreeType: student.degreeType // Match student's degree
            },
            orderBy: { minPercentile: 'desc' }
        });

        // 6. Match Best Rule
        let bestMatch: any = null;
        let matchedScoreDetails: any = null;

        for (const scoreInfo of validScores) {
            // Check against all rules
            for (const rule of rules) {
                // Simple logic: Is score >= minPercentile? 
                // Note: Real world might need complex Type matching (Rule says "JEE" only). 
                // Assuming simple percentile check for now as requested.
                if (scoreInfo.score >= rule.minPercentile && rule.filledSlots < rule.totalSlots) {
                    // Check if this rule offers a better discount than the current best match
                    if (!bestMatch || rule.discountPercentage > bestMatch.discountPercentage) {
                        bestMatch = rule;
                        matchedScoreDetails = scoreInfo;
                    }
                    // CONTINUING searching in case a lower percentile rule offers a higher discount
                    // (e.g. 93% gives 25%, but 90% gives 50%)
                }
            }
        }

        if (!bestMatch) {
            return { eligible: false, reason: "No matching scholarship rule or slots full" };
        }

        // 7. Success Response
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
        logger.info(`Verification Officer ${verifierId} verifying scholarship eligibility for student ${studentId}`);
        
        // Update Student record with verification details and optionally the recommended rule
        await prisma.student.update({
            where: { id: studentId },
            data: {
                scholarshipVerified: true,
                scholarshipRemarks: remarks,
                scholarshipVerifiedBy: verifierId,
                scholarshipVerifiedAt: new Date(),
                eligibleScholarshipRuleId: ruleId // Store the Officer's recommended rule
            }
        });

        return { success: true, message: "Scholarship eligibility verified and recorded successfully" };
    },

    async allocateScholarship(studentId: string, ruleId: string, adminId: string) {
        // 1. Validate
        // Verify 'verification officer remarks' if applicable (omitted for speed unless table exists)
        
        const rule = await prisma.scholarshipRule.findUnique({ where: { id: ruleId } });
        if (!rule) throw new AppError('Rule not found', 404);
        
        if (rule.filledSlots >= rule.totalSlots) throw new AppError('Slots full', 400);

        // 2. Transact Allocation
        return await prisma.$transaction(async (tx) => {
             // Lock Rule
             await tx.scholarshipRule.update({
                where: { id: ruleId },
                data: { filledSlots: { increment: 1 } }
             });

             // Create Allocation
             return await tx.scholarshipAllocation.create({
                data: {
                    studentId,
                    ruleId,
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

        if (allocation.status !== ScholarshipStatus.RESERVED) return allocation; // Already locked or expired

        const lockedAt = new Date();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 20); // 20 days expiry

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

        const rule = await prisma.scholarshipRule.findUnique({ where: { id: ruleId } });
        if (!rule) throw new AppError('Scholarship Rule not found', 404);
        if (rule.filledSlots >= rule.totalSlots) throw new AppError('Scholarship Rule slots full', 400);

        return await prisma.$transaction(async (tx) => {
            await tx.scholarshipRule.update({
                where: { id: ruleId },
                data: { filledSlots: { increment: 1 } }
            });

            // Remove existing if any
            const existing = await tx.scholarshipAllocation.findUnique({ where: { studentId } });
            if (existing) {
                await tx.scholarshipAllocation.delete({ where: { studentId } });
                await tx.scholarshipRule.update({
                    where: { id: existing.ruleId },
                    data: { filledSlots: { decrement: 1 } }
                });
            }

            return await tx.scholarshipAllocation.create({
                data: {
                    studentId,
                    ruleId,
                    status: ScholarshipStatus.RESERVED,
                    reservedAt: new Date()
                }
            });
        });
    }
};

