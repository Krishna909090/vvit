import { z } from 'zod';

export const createQualificationRequirementSchema = z.object({
    body: z.object({
        degreeType: z.string().min(1, 'Degree type is required'),
        ruleType: z.enum(['SINGLE', 'OR', 'AND']).optional().default('SINGLE'),

        qualificationKey: z.string().optional(),
        qualificationKeys: z.array(z.string()).optional(),
        isRequired: z.boolean().optional().default(true)
    }).refine(data => {

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
