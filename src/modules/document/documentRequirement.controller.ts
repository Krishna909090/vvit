

import { Request, Response, NextFunction } from 'express';
import * as documentRequirementService from './documentRequirement.service';
import logger from '../../utils/logger';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/response';
import { assertStudentOwns } from '../../utils/ownership';

export const getDocumentRequirements = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { degreeType } = req.query;
        
        logger.info(`[getDocumentRequirements] by=${req.user?.userId} degreeType=${degreeType || 'all'}`);
        
        const requirements = await documentRequirementService.getDocumentRequirements(
            degreeType as string | undefined
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

export const getDocumentRequirementById = catchAsync(async (req: Request, res: Response) => {
    const { id } = req.params;
    const requirement = await documentRequirementService.getDocumentRequirementById(id);
    sendResponse({
        res,
        statusCode: 200,
        success: true,
        data: requirement
    });
});

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

export const getStudentDocumentRequirements = catchAsync(
    async (req: Request, res: Response, next: NextFunction) => {
        const { studentId } = req.params;

        await assertStudentOwns(req, studentId);

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
