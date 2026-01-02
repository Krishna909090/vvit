import { z } from 'zod';

export const createQualificationRequirementSchema = z.object({
    body: z.object({
        degreeType: z.string().min(1, 'Degree type is required'),
        ruleType: z.enum(['SINGLE', 'OR', 'AND']).optional().default('SINGLE'),
        // Support both single qualificationKey and array qualificationKeys in API for flexibility, 
        // but map to array in service/controller if needed, or enforce schema to match service expectation.
        // User asked for "qualificationKey" (singular) in simple example, and "qualificationKeys" (plural) in group.
        // I will allow both in schema and transform in controller if needed, or simply demand the client to follow one structure per type?
        // Let's support an optional transform or just expect the right fields.
        qualificationKey: z.string().optional(),
        qualificationKeys: z.array(z.string()).optional(),
        isRequired: z.boolean().optional().default(true)
    }).refine(data => {
        // Validation: either singular key OR plural keys must exist
        if (data.ruleType === 'SINGLE') {
            return !!data.qualificationKey || (!!data.qualificationKeys && data.qualificationKeys.length > 0);
        }
        return !!data.qualificationKeys && data.qualificationKeys.length > 0;
    }, {
        message: "Qualification key(s) required"
    })
});

export const updateQualificationRequirementSchema = z.object({
    body: z.object({
        ruleType: z.enum(['SINGLE', 'OR', 'AND']).optional(),
        qualificationKeys: z.array(z.string()).optional(),
        isRequired: z.boolean().optional()
    })
});
