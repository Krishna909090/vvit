/**
 * dedupFeeDemands — one-shot detection and merge of duplicate StudentFeeDemand rows.
 *
 * A duplicate is two or more non-deleted demands with the same (studentId, feeStructureId).
 * This shouldn't happen, but the application had no DB-level uniqueness, so racing parallel
 * calls (promotion job + manual button) could produce them. Run this BEFORE applying
 * prisma/migrations/fee_demand_unique_constraint.sql.
 *
 * Merge rules — for each duplicate group:
 *   1. If any duplicate has linked SUCCESS payments → KEEP that one (preserve audit trail).
 *      If multiple have payments → fail loud (manual review needed; refusing to merge).
 *   2. Else keep the oldest (smallest createdAt).
 *   3. Soft-delete the rest (isDeleted=true, deletedAt=now, deletedBy='dedup-script').
 *
 * The script does NOT touch StudentLedger entries — those remain as the audit trail.
 * It does NOT adjust StudentAdmission.totalFee either: the kept demand's amount is the
 * correct base for that fee head; the soft-deleted duplicates inflated totalFee in error,
 * so we adjust totalFee by subtracting the soft-deleted amounts.
 *
 * Usage:
 *   ts-node src/scripts/dedupFeeDemands.ts --dry-run   # report only, no writes
 *   ts-node src/scripts/dedupFeeDemands.ts --apply     # apply merges
 */

import dotenv from 'dotenv';
dotenv.config();

import prisma from '../config/prisma';

interface DupGroup {
    studentId:      string;
    feeStructureId: string;
    rows: Array<{
        id:        string;
        amount:    number;
        createdAt: Date | null;
        payments:  Array<{ id: string; status: string | null; amount: number }>;
    }>;
}

async function findDuplicateGroups(): Promise<DupGroup[]> {
    // Raw SQL is the cleanest way to find groups with COUNT(*) > 1.
    const rows = await prisma.$queryRaw<Array<{ studentId: string; feeStructureId: string; cnt: bigint }>>`
        SELECT "studentId", "feeStructureId", COUNT(*)::bigint AS cnt
        FROM "StudentFeeDemand"
        WHERE "isDeleted" = false AND "feeStructureId" IS NOT NULL
        GROUP BY "studentId", "feeStructureId"
        HAVING COUNT(*) > 1
    `;

    if (rows.length === 0) return [];

    const groups: DupGroup[] = [];
    for (const r of rows) {
        const demands = await prisma.studentFeeDemand.findMany({
            where: {
                studentId:      r.studentId,
                feeStructureId: r.feeStructureId,
                isDeleted:      false,
            },
            select: {
                id:        true,
                amount:    true,
                createdAt: true,
                payments:  {
                    select: { id: true, status: true, amount: true },
                    where:  { isDeleted: false },
                },
            },
            orderBy: { createdAt: 'asc' },
        });

        groups.push({
            studentId:      r.studentId,
            feeStructureId: r.feeStructureId,
            rows: demands.map(d => ({
                id:        d.id,
                amount:    d.amount,
                createdAt: d.createdAt ?? null,
                payments:  d.payments.map(p => ({ id: p.id, status: p.status, amount: p.amount })),
            })),
        });
    }
    return groups;
}

function pickKeeper(g: DupGroup): { keep: string; drop: string[]; reason: string; manualReview?: boolean } {
    const withPaidPayments = g.rows.filter(r =>
        r.payments.some(p => p.status === 'SUCCESS')
    );

    if (withPaidPayments.length > 1) {
        // Multiple demands have successful payments — refuse to auto-merge.
        return {
            keep: withPaidPayments[0].id,
            drop: [],
            reason: `MANUAL_REVIEW_REQUIRED: ${withPaidPayments.length} duplicates have SUCCESS payments`,
            manualReview: true,
        };
    }
    if (withPaidPayments.length === 1) {
        const keeper = withPaidPayments[0].id;
        return {
            keep: keeper,
            drop: g.rows.filter(r => r.id !== keeper).map(r => r.id),
            reason: 'kept the row with SUCCESS payments',
        };
    }

    // No payments anywhere — keep oldest.
    const oldest = g.rows[0];
    return {
        keep: oldest.id,
        drop: g.rows.slice(1).map(r => r.id),
        reason: 'kept the oldest row (no payments anywhere)',
    };
}

async function main() {
    const args = new Set(process.argv.slice(2));
    const dryRun = !args.has('--apply');

    console.log(`[dedupFeeDemands] mode=${dryRun ? 'DRY-RUN' : 'APPLY'}`);
    console.log(`[dedupFeeDemands] scanning for duplicate (studentId, feeStructureId) groups...`);

    const groups = await findDuplicateGroups();
    console.log(`[dedupFeeDemands] found ${groups.length} duplicate group(s)`);

    if (groups.length === 0) {
        console.log(`[dedupFeeDemands] no duplicates — safe to apply fee_demand_unique_constraint.sql`);
        await prisma.$disconnect();
        return;
    }

    let willMerge = 0;
    let willSkip  = 0;
    let amountToReverse = 0;

    for (const g of groups) {
        const decision = pickKeeper(g);
        const totalAmt = g.rows.reduce((s, r) => s + r.amount, 0);
        const keeperAmt = g.rows.find(r => r.id === decision.keep)?.amount ?? 0;
        const droppedAmt = totalAmt - keeperAmt;

        console.log(
            `\n  student=${g.studentId} structure=${g.feeStructureId} count=${g.rows.length}\n` +
            `    rows: ${g.rows.map(r => `${r.id}(amt=${r.amount}, paid=${r.payments.filter(p => p.status === 'SUCCESS').length}, created=${r.createdAt?.toISOString() ?? 'n/a'})`).join(', ')}\n` +
            `    decision: ${decision.reason}\n` +
            `    keep=${decision.keep}, drop=[${decision.drop.join(', ')}], totalFee-reverse=${droppedAmt}`
        );

        if (decision.manualReview) {
            willSkip++;
            continue;
        }
        willMerge++;
        amountToReverse += droppedAmt;

        if (!dryRun) {
            await prisma.$transaction(async (tx) => {
                await tx.studentFeeDemand.updateMany({
                    where: { id: { in: decision.drop } },
                    data: {
                        isDeleted: true,
                        deletedAt: new Date(),
                        deletedBy: 'dedup-script',
                    },
                });
                if (droppedAmt > 0) {
                    await tx.studentAdmission.updateMany({
                        where: { studentId: g.studentId },
                        data: { totalFee: { decrement: droppedAmt } },
                    });
                }
            });
        }
    }

    console.log(
        `\n[dedupFeeDemands] summary: groups=${groups.length}, merged=${willMerge}, ` +
        `manualReview=${willSkip}, totalFeeReverse=${amountToReverse}`
    );
    if (dryRun) {
        console.log(`[dedupFeeDemands] DRY-RUN — re-run with --apply to commit changes`);
    } else {
        console.log(`[dedupFeeDemands] APPLY complete. After resolving any MANUAL_REVIEW groups, apply fee_demand_unique_constraint.sql`);
    }

    await prisma.$disconnect();
}

main().catch(err => {
    console.error('[dedupFeeDemands] fatal:', err);
    process.exit(1);
});
