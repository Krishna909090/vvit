// controllers/documentRequirementController.ts
// Express controllers for document requirement management APIs

import { Request, Response, NextFunction } from 'express';
import * as documentRequirementService from '../services/documentRequirementService';
import logger from '../utils/logger';
import { catchAsync } from '../utils/catchAsync';
import { sendResponse } from '../utils/response';

/**
 * Controller: Get all document requirements (with optional courseType filter)
 * Route: GET /document-requirements
 * Query Params: ?courseType=UG (optional)
 * Roles: ADMIN, SUPER_ADMIN
 */
export const getDocumentRequirements = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { courseType } = req.query;
        
        logger.info(`[getDocumentRequirements] by=${req.user?.userId} courseType=${courseType || 'all'}`);
        
        const requirements = await documentRequirementService.getDocumentRequirements(
            courseType as string | undefined
        );
        
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: 'Document requirements retrieved successfully',
            data: requirements
        });
    }
);

/**
 * Controller: Create a new document requirement
 * Route: POST /document-requirements
 * Roles: ADMIN, SUPER_ADMIN
 */
export const createDocumentRequirement = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        logger.info(`[createDocumentRequirement] by=${req.user?.userId}`);
        logger.debug && logger.debug(`[createDocumentRequirement] payload=${JSON.stringify(req.body)}`);
        
        const requirement = await documentRequirementService.createDocumentRequirement(
            req.body,
            req.user?.userId
        );
        
        sendResponse({
            res,
            statusCode: 201,
            success: true,
            message: 'Document requirement created successfully',
            data: requirement
        });
    }
);

/**
 * Controller: Update an existing document requirement
 * Route: PUT /document-requirements/:id
 * Roles: ADMIN, SUPER_ADMIN
 */
export const updateDocumentRequirement = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        
        logger.info(`[updateDocumentRequirement] id=${id} by=${req.user?.userId}`);
        logger.debug && logger.debug(`[updateDocumentRequirement] payload=${JSON.stringify(req.body)}`);
        
        const requirement = await documentRequirementService.updateDocumentRequirement(
            id,
            req.body,
            req.user?.userId
        );
        
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: 'Document requirement updated successfully',
            data: requirement
        });
    }
);

/**
 * Controller: Delete a document requirement (soft delete)
 * Route: DELETE /document-requirements/:id
 * Roles: ADMIN, SUPER_ADMIN
 */
export const deleteDocumentRequirement = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { id } = req.params;
        
        logger.info(`[deleteDocumentRequirement] id=${id} by=${req.user?.userId}`);
        
        await documentRequirementService.deleteDocumentRequirement(id);
        
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: 'Document requirement deleted successfully'
        });
    }
);

/**
 * Controller: Get document requirements for a specific student
 * Route: GET /students/:studentId/document-requirements
 * Roles: ADMIN, SUPER_ADMIN, STUDENT (own data)
 */
export const getStudentDocumentRequirements = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { studentId } = req.params;
        
        logger.info(`[getStudentDocumentRequirements] studentId=${studentId} by=${req.user?.userId}`);
        
        const result = await documentRequirementService.getStudentDocumentRequirements(studentId);
        
        sendResponse({
            res,
            statusCode: 200,
            success: true,
            message: 'Student document requirements retrieved successfully',
            data: result
        });
    }
);
