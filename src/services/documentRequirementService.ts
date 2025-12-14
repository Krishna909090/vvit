// services/documentRequirementService.ts
// Business logic for managing document requirements based on qualifications/course types

import prisma from '../config/prisma';
import logger from '../utils/logger';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';

/**
 * Get all document requirements with optional filtering by courseType
 */
export const getDocumentRequirements = async (courseType?: string) => {
    logger.info(`[getDocumentRequirements] Fetching document requirements${courseType ? ` for courseType=${courseType}` : ''}`);
    
    const where: any = {
        isDeleted: false
    };
    
    if (courseType) {
        where.courseType = courseType;
    }
    
    const requirements = await prisma.documentRequirement.findMany({
        where,
        orderBy: [
            { courseType: 'asc' },
            { documentName: 'asc' }
        ]
    });
    
    logger.info(`[getDocumentRequirements] Found ${requirements.length} document requirements`);
    return requirements;
};

/**
 * Create a new document requirement
 */
export const createDocumentRequirement = async (data: any, userId?: string) => {
    const { courseType, documentName, documentKey, isRequired } = data;
    
    if (!courseType || !courseType.trim()) {
        throw new AppError('Course type is required', 400);
    }
    
    if (!documentName || !documentName.trim()) {
        throw new AppError('Document name is required', 400);
    }
    
    if (!documentKey || !documentKey.trim()) {
        throw new AppError('Document key is required', 400);
    }
    
    // Check if already exists
    const existing = await prisma.documentRequirement.findFirst({
        where: {
            courseType: courseType.trim(),
            documentKey: documentKey.trim(),
            isDeleted: false
        }
    });
    
    if (existing) {
        throw new AppError(
            `Document requirement already exists for courseType="${courseType}" with documentKey="${documentKey}"`,
            409
        );
    }
    
    const requirement = await prisma.documentRequirement.create({
        data: {
            courseType: courseType.trim(),
            documentName: documentName.trim(),
            documentKey: documentKey.trim(),
            isRequired: isRequired !== undefined ? Boolean(isRequired) : true,
            createdBy: userId
        }
    });
    
    logger.info(`[createDocumentRequirement] Created document requirement id=${requirement.id} for courseType=${courseType}`);
    return requirement;
};

/**
 * Update an existing document requirement
 */
export const updateDocumentRequirement = async (id: string, data: any, userId?: string) => {
    if (!id) {
        throw new AppError('Document requirement ID is required', 400);
    }
    
    const existing = await prisma.documentRequirement.findUnique({
        where: { id }
    });
    
    if (!existing) {
        throw new AppError('Document requirement not found', 404);
    }
    
    if (existing.isDeleted) {
        throw new AppError('Cannot update deleted document requirement', 400);
    }
    
    const updateData: any = {
        updatedBy: userId
    };
    
    if (data.documentName !== undefined) {
        if (!data.documentName.trim()) {
            throw new AppError('Document name cannot be empty', 400);
        }
        updateData.documentName = data.documentName.trim();
    }
    
    if (data.isRequired !== undefined) {
        updateData.isRequired = Boolean(data.isRequired);
    }
    
    // Note: courseType and documentKey cannot be updated as they form unique constraint
    // If needed, delete and create new one
    
    const updated = await prisma.documentRequirement.update({
        where: { id },
        data: updateData
    });
    
    logger.info(`[updateDocumentRequirement] Updated document requirement id=${id}`);
    return updated;
};

/**
 * Delete a document requirement (soft delete)
 */
export const deleteDocumentRequirement = async (id: string) => {
    if (!id) {
        throw new AppError('Document requirement ID is required', 400);
    }
    
    const existing = await prisma.documentRequirement.findUnique({
        where: { id }
    });
    
    if (!existing) {
        throw new AppError('Document requirement not found', 404);
    }
    
    if (existing.isDeleted) {
        throw new AppError('Document requirement already deleted', 400);
    }
    
    const deleted = await prisma.documentRequirement.update({
        where: { id },
        data: {
            isDeleted: true
        }
    });
    
    logger.info(`[deleteDocumentRequirement] Soft deleted document requirement id=${id}`);
    return deleted;
};

/**
 * Get document requirements for a specific student based on their course type
 */
export const getStudentDocumentRequirements = async (studentId: string) => {
    if (!studentId) {
        throw new AppError('Student ID is required', 400);
    }
    
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        select: {
            courseType: true
        }
    });
    
    if (!student) {
        throw new AppError('Student not found', 404);
    }
    
    if (!student.courseType) {
        throw new AppError('Student does not have a course type assigned', 400);
    }
    
    const requirements = await getDocumentRequirements(student.courseType);
    
    logger.info(`[getStudentDocumentRequirements] Found ${requirements.length} document requirements for student=${studentId} courseType=${student.courseType}`);
    return {
        studentId,
        courseType: student.courseType,
        requirements
    };
};
