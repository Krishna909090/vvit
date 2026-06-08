import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { getActiveAcademicYear } from '../../utils/studentContext';
import { assertScholarshipEditableForStudent } from '../studentManagement/adminStudent/admission';

export const ScholarshipService = {

    async createRule(_data: any, _createdBy: string) {
        throw new AppError('Scholarship feature has been removed', 410);
    },

    async getAllRules() {
        return [];
    },

    async updateRule(_id: string, _data: any) {
        throw new AppError('Scholarship feature has been removed', 410);
    },

    async deleteRule(_id: string) {
        throw new AppError('Scholarship feature has been removed', 410);
    },

    async checkEligibility(_studentId: string) {
        return { eligible: false, reason: 'Scholarship feature has been removed' };
    },

    async verifyEligibility(_studentId: string, _remarks: string, _verifierId: string, _ruleId?: string) {
        return { success: true, message: 'Scholarship feature has been removed' };
    },

    async allocateScholarship(_studentId: string, _ruleId: string, _adminId: string) {
        throw new AppError('Scholarship feature has been removed', 410);
    },

    async getStudentAllocation(_studentId: string) {
        return null;
    },

    async lockAllocation(_studentId: string) {
        return null;
    },

    async allocateManualRule(_studentId: string, _ruleId: string) {
        throw new AppError('Scholarship feature has been removed', 410);
    },

    async updateStudentScholarship(studentId: string, newPercentage: number, adminId: string, feeHeadId?: string, academicYearId?: string | null, adminRole?: string) {
        logger.info(`Updating scholarship for student ${studentId} to ${newPercentage}%`);

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
                where: { studentId, ...(feeHeadId ? { feeHeadId } : {}) },
                include: { feeHead: true, payments: { where: { status: 'SUCCESS' } } }
            });

            for (const demand of demands) {
                const feeName = (demand.feeHead?.name || '').toLowerCase();
                let isTuition: boolean;
                if (feeHeadId) {
                    const feeHeadRecord = await tx.feeHead.findUnique({ where: { id: feeHeadId }, select: { component: true } });
                    isTuition = feeHeadRecord?.component === 'TUITION' || (feeHeadRecord?.component?.includes('TUITION') ?? false);
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
                                remarks: (demand.remarks || '') + ` | Scholarship updated to ${newPercentage}%`
                            } as any
                        });

                        await tx.studentLedger.create({
                            data: {
                                studentId,
                                type: scholarshipDiff > 0 ? 'CREDIT' : 'DEBIT',
                                amount: Math.abs(scholarshipDiff),
                                description: `Scholarship Adjusted: ${scholarshipDiff > 0 ? 'Increased' : 'Reduced'} to ₹${newScholarshipAmt} (${newPercentage}%)`,
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
