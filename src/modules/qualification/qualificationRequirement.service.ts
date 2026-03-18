// services/qualificationRequirementService.ts
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';

/**
 * Get qualification requirements for a degree type
 */
export const getQualificationRequirements = async (degreeType?: string) => {
    logger.info(`[getQualificationRequirements] Fetching requirements${degreeType ? ` for degreeType=${degreeType}` : ''}`);
    
    const where: any = {
        isDeleted: false
    };
    
    if (degreeType) {
        where.degreeType = degreeType;
    }
    
    const requirements = await prisma.qualificationRequirement.findMany({
        where,
        orderBy: { createdAt: 'desc' }
    });
    
    return requirements;
};

/**
 * Get a single qualification requirement by ID
 */
export const getQualificationRequirementById = async (id: string) => {
    const requirement = await prisma.qualificationRequirement.findUnique({
        where: { id }
    });

    if (!requirement || requirement.isDeleted) {
        throw new AppError('Requirement not found', 404);
    }
    
    return requirement;
};

/**
 * Create a new qualification requirement
 */
export const createQualificationRequirement = async (data: any, userId?: string) => {
    const { degreeType, ruleType, qualificationKeys, isRequired } = data;
    
    // Validate inputs
    if (!degreeType) throw new AppError('Degree type is required', 400);
    if (!qualificationKeys || !qualificationKeys.length) throw new AppError('At least one qualification key is required', 400);

    // Create
    const requirement = await prisma.qualificationRequirement.create({
        data: {
            degreeType,
            ruleType: ruleType || 'SINGLE',
            qualificationKeys,
            isRequired: isRequired !== undefined ? isRequired : true,
            createdBy: userId
        }
    });
    
    logger.info(`[createQualificationRequirement] Created requirement id=${requirement.id}`);
    return requirement;
};

/**
 * Update a qualification requirement
 */
export const updateQualificationRequirement = async (id: string, data: any, userId?: string) => {
    const existing = await prisma.qualificationRequirement.findUnique({ where: { id } });
    if (!existing || existing.isDeleted) throw new AppError('Requirement not found', 404);

    const updated = await prisma.qualificationRequirement.update({
        where: { id },
        data: {
            ...data,
            updatedBy: userId
        }
    });
    
    logger.info(`[updateQualificationRequirement] Updated requirement id=${id}`);
    return updated;
};

/**
 * Delete a qualification requirement
 */
export const deleteQualificationRequirement = async (id: string) => {
    const existing = await prisma.qualificationRequirement.findUnique({ where: { id } });
    if (!existing || existing.isDeleted) throw new AppError('Requirement not found', 404);

    await prisma.qualificationRequirement.update({
        where: { id },
        data: { isDeleted: true }
    });
    
    logger.info(`[deleteQualificationRequirement] Deleted requirement id=${id}`);
    return true;
};

/**
 * Validate qualifications against requirements
 * @param degreeType The degree type the student is applying for
 * @param studentQualifications Array of qualification codes/keys the student possesses (e.g. ['SSC', 'INTER_MPC'])
 */
export const validateQualifications = async (degreeType: string, studentQualifications: string[]) => {
    const requirements = await prisma.qualificationRequirement.findMany({
        where: { degreeType, isDeleted: false, isRequired: true }
    });

    if (requirements.length === 0) {
        return { valid: true, missingRequirements: [] };
    }

    const missingRequirements = [];

    for (const req of requirements) {
        let met = false;
        const requiredKeys = req.qualificationKeys;

        if (req.ruleType === 'SINGLE') {
            // Check if ANY of the keys are present (usually single means just one key, but if array is passed, one of them)
            // Actually, if SINGLE implies "This specific qualification", it's usually one.
            // But if keys=["A", "B"], SINGLE might mean "Any of these satisfying this rule"? 
            // Or usually SINGLE has 1 key. 
            // Let's assume ANY match in the list satisfies the requirement.
            met = requiredKeys.some((key: string) => studentQualifications.includes(key));
        } else if (req.ruleType === 'OR') {
            // "ONE of these is required"
            met = requiredKeys.some((key: string) => studentQualifications.includes(key));
        } else if (req.ruleType === 'AND') {
             // "ALL of these are required"
             met = requiredKeys.every((key: string) => studentQualifications.includes(key));
        }

        if (!met) {
            missingRequirements.push({
                ruleId: req.id,
                ruleType: req.ruleType,
                required: req.qualificationKeys
            });
        }
    }

    return {
        valid: missingRequirements.length === 0,
        missingRequirements
    };
};
