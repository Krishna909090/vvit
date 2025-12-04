import prisma from '../config/prisma';
import logger from '../utils/logger';

import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';

export const createDocumentRequirement = async (data: any) => {
    const requirement = await prisma.documentRequirement.create({
        data: {
            courseType: data.courseType,
            documentName: data.documentName,
            documentKey: data.documentKey,
            isRequired: data.isRequired
        }
    });
    logger.info(`Document requirement created: ${requirement.id}`);
    return requirement;
};

export const getDocumentRequirements = async (courseType?: string) => {
    const where = courseType ? { courseType } : {};
    const requirements = await prisma.documentRequirement.findMany({
        where,
        orderBy: { createdAt: 'asc' }
    });
    logger.info(`Fetched ${requirements.length} document requirements for courseType=${courseType || 'ALL'}`);
    return requirements;
};

export const updateDocumentRequirement = async (id: string, data: any) => {
    const existing = await prisma.documentRequirement.findUnique({ where: { id } });
    if (!existing) {
        throw new AppError(MESSAGES.ERROR.REQUIREMENT_NOT_FOUND, 404);
    }

    const requirement = await prisma.documentRequirement.update({
        where: { id },
        data
    });
    logger.info(`Document requirement updated: ${id}`);
    return requirement;
};

export const deleteDocumentRequirement = async (id: string) => {
    const existing = await prisma.documentRequirement.findUnique({ where: { id } });
    if (!existing) {
        throw new AppError(MESSAGES.ERROR.REQUIREMENT_NOT_FOUND, 404);
    }

    await prisma.documentRequirement.delete({
        where: { id }
    });
    logger.info(`Document requirement deleted: ${id}`);
    return { message: 'Requirement deleted' };
};
