import { RetainedRevenueCategory, RetainedRevenueSourceType } from '@prisma/client';
import { AppError } from './AppError';

export type RetainedLine = {
    category: RetainedRevenueCategory;
    amount: number;
};

export type RecordRetainedArgs = {
    studentId: string;
    academicYearId: string;
    sourceType: RetainedRevenueSourceType;
    sourceId: string;
    occurredAt: Date;
    lines: RetainedLine[];
    expectedTotal: number;
    courseId?: string;
    hostelId?: string;
    routeId?: string;
    createdBy?: string;
};

const EPSILON = 0.01;

/**
 * Append per-category retained-revenue lines. Zero-amount lines are dropped.
 * Throws if sum(lines) !== expectedTotal (the parent row's retainedAmount).
 */
export async function recordRetained(
    tx: any,
    args: RecordRetainedArgs,
): Promise<void> {
    const lines = args.lines.filter(l => l.amount > 0);
    if (lines.length === 0) {
        if (args.expectedTotal > EPSILON) {
            throw new AppError(
                `recordRetained: expectedTotal=${args.expectedTotal} but no non-zero lines provided (sourceType=${args.sourceType}, sourceId=${args.sourceId})`,
                500,
            );
        }
        return;
    }

    const sum = lines.reduce((s, l) => s + l.amount, 0);
    if (Math.abs(sum - args.expectedTotal) > EPSILON) {
        throw new AppError(
            `recordRetained: line sum ${sum} does not match expectedTotal ${args.expectedTotal} (sourceType=${args.sourceType}, sourceId=${args.sourceId})`,
            500,
        );
    }

    await tx.retainedRevenueLine.createMany({
        data: lines.map(l => ({
            studentId:      args.studentId,
            academicYearId: args.academicYearId,
            category:       l.category,
            amount:         l.amount,
            sourceType:     args.sourceType,
            sourceId:       args.sourceId,
            courseId:       args.courseId,
            hostelId:       args.hostelId,
            routeId:        args.routeId,
            occurredAt:     args.occurredAt,
            createdBy:      args.createdBy,
        })),
    });
}
