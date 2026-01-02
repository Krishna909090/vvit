// validators/documentRequirementValidators.ts
// Zod schemas for document requirement validation

import { z } from 'zod';

export const createDocumentRequirementSchema = z.object({
    body: z.object({
        degreeType: z.string().min(1, 'Degree type is required').trim(),
        documentName: z.string().min(1, 'Document name is required').trim(),
        documentKey: z.string().min(1, 'Document key is required').trim(),
        isRequired: z.boolean().optional().default(true)
    })
});

export const updateDocumentRequirementSchema = z.object({
    body: z.object({
        documentName: z.string().min(1, 'Document name cannot be empty').trim().optional(),
        isRequired: z.boolean().optional()
    }).refine(
        (data) => data.documentName !== undefined || data.isRequired !== undefined,
        {
            message: 'At least one field (documentName or isRequired) must be provided for update'
        }
    )
});
