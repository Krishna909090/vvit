import { Prisma, RetainedRevenueCategory, RetainedRevenueSourceType } from '@prisma/client';
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
    // Used to enforce sum(lines) === expectedTotal so the ledger can never drift
    // from the originating row's retained column. Pass the same number you wrote
    // to FeeCorrection.retainedAmount (or the equivalent on a Payment).
    expectedTotal: number;
    courseId?: string;
    hostelId?: string;
    routeId?: string;
    createdBy?: string;
};

const EPSILON = 0.01;

/**
 * Append per-category retained-revenue lines for a single source row.
 *
 * Zero-amount lines are dropped. Asserts sum(lines) === expectedTotal so the
 * normalized ledger and the parent row's `retainedAmount` (or equivalent) can
 * never silently diverge.
 *
 * Pass a Prisma transaction client so the lines commit atomically with the
 * source row (FeeCorrection / Payment) that produced them.
 */
export async function recordRetained(
    tx: Prisma.TransactionClient,
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
