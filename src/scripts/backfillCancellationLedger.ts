/**
 * One-off backfill: for every existing ACCOMMODATION_CHANGE_REFUND FeeCorrection
 * row that carries a non-zero `retainedAmount`, insert the matching StudentLedger
 * DEBIT row that the new cancel-flow code now writes inline.
 *
 * Idempotent — skips a correction if a ledger row keyed by that correction's id
 * already exists.
 *
 * Run:  npx ts-node src/scripts/backfillCancellationLedger.ts
 */

import prisma from '../config/prisma';

async function main() {
    const corrections: any[] = await (prisma as any).feeCorrection.findMany({
        where: {
            type: 'ACCOMMODATION_CHANGE_REFUND',
            retainedAmount: { gt: 0 },
            referenceType: { in: ['HOSTEL_CANCELLATION', 'TRANSPORT_CANCELLATION', 'HOSTEL_TO_TRANSPORT_SWITCH', 'TRANSPORT_TO_HOSTEL_SWITCH'] },
        },
        select: {
            id: true,
            studentId: true,
            academicYearId: true,
            retainedAmount: true,
            reason: true,
            referenceType: true,
            createdBy: true,
        },
    });

    console.log(`[backfill] Found ${corrections.length} correction(s) with retainedAmount > 0`);

    let inserted = 0;
    let skipped = 0;

    for (const fc of corrections) {
        const existing = await prisma.studentLedger.findFirst({
            where: {
                referenceId: fc.id,
                referenceType: fc.referenceType,
                type: 'DEBIT',
                isDeleted: false,
            },
            select: { id: true },
        });

        if (existing) {
            skipped++;
            continue;
        }

        const prefix =
            fc.referenceType === 'HOSTEL_CANCELLATION'        ? 'Hostel cancellation fee retained (backfill): ' :
            fc.referenceType === 'TRANSPORT_CANCELLATION'     ? 'Transport cancellation fee retained (backfill): ' :
            fc.referenceType === 'HOSTEL_TO_TRANSPORT_SWITCH' ? 'Hostel→Transport switch fee retained (backfill): ' :
            fc.referenceType === 'TRANSPORT_TO_HOSTEL_SWITCH' ? 'Transport→Hostel switch fee retained (backfill): ' :
                                                                'Accommodation fee retained (backfill): ';

        await prisma.studentLedger.create({
            data: {
                studentId: fc.studentId,
                type: 'DEBIT' as any,
                amount: fc.retainedAmount,
                description: `${prefix}${fc.reason ?? ''}`,
                referenceId: fc.id,
                referenceType: fc.referenceType,
                academicYearId: fc.academicYearId,
                createdBy: fc.createdBy,
            } as any,
        });

        inserted++;
        console.log(`[backfill]   + studentId=${fc.studentId} amount=${fc.retainedAmount} (${fc.referenceType})`);
    }

    console.log(`[backfill] DONE — inserted=${inserted}, skipped=${skipped} (out of ${corrections.length})`);
}

main()
    .catch((err) => {
        console.error('[backfill] FAILED:', err);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
