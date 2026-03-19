import prisma from '../config/prisma';
import logger from '../utils/logger';
import { ScholarshipStatus, PaymentStatus, PaymentMode } from '@prisma/client';

// ─────────────────────────────────────────────
// Job 1: Scholarship Expiry
// ─────────────────────────────────────────────

export const startScholarshipExpiryJob = () => {
    logger.info('⏳ Starting Scholarship Expiry Job (Interval: 1 hour)');
    logger.info('[ScholarshipExpiryJob] Running initial check on startup...');

    // Run immediately on startup
    checkExpiredScholarships();

    // Run every 1 hour
    setInterval(async () => {
        logger.info('[ScholarshipExpiryJob] Interval triggered. Running check...');
        await checkExpiredScholarships();
    }, 3600000);
};

const checkExpiredScholarships = async () => {
    try {
        const now = new Date();
        logger.info(`[ScholarshipExpiryJob] Running Scholarship Expiry Check at ${now.toISOString()}...`);

        const expiredAllocations = await prisma.scholarshipAllocation.findMany({
            where: {
                status: ScholarshipStatus.LOCKED,
                expiresAt: { lt: now }
            }
        });
        logger.info(`[ScholarshipExpiryJob] DB query complete. Found ${expiredAllocations.length} expired allocation(s).`);

        if (expiredAllocations.length === 0) {
            logger.info('No expired scholarships found.');
            return;
        }

        logger.info(`Found ${expiredAllocations.length} expired scholarships. Processing...`);

        let processedCount = 0;
        for (const allocation of expiredAllocations) {
            logger.info(`[ScholarshipExpiryJob] Processing allocation id=${allocation.id} for student=${allocation.studentId} ruleId=${allocation.ruleId}`);
            try {
                await prisma.$transaction([
                    prisma.scholarshipAllocation.update({
                        where: { id: allocation.id },
                        data: { status: ScholarshipStatus.EXPIRED }
                    }),
                    prisma.scholarshipRule.update({
                        where: { id: allocation.ruleId },
                        data: { filledSlots: { decrement: 1 } }
                    })
                ]);
                processedCount++;
                logger.info(`[ScholarshipExpiryJob] ✅ Expired allocation id=${allocation.id} for student=${allocation.studentId}. filledSlots decremented for ruleId=${allocation.ruleId}.`);
            } catch (err) {
                logger.error(`[ScholarshipExpiryJob] ❌ Failed to expire allocation id=${allocation.id} for student=${allocation.studentId}: ${err}`);
            }
        }

        logger.info(`[ScholarshipExpiryJob] Check Completed. Processed: ${processedCount} | Failed: ${expiredAllocations.length - processedCount} | Total: ${expiredAllocations.length}`);

    } catch (error) {
        logger.error(`Error in Scholarship Expiry Job: ${error}`);
    }
};

// ─────────────────────────────────────────────
// Job 2: Stale PENDING Payment Cleanup
// Marks ONLINE payments older than 22 minutes as FAILED
// PhonePe QR expires at 20 min — 22 min gives 2 min buffer
// ─────────────────────────────────────────────

export const startStalePaymentCleanupJob = () => {
    logger.info('[StalePaymentCleanup] Starting (Interval: 5 minutes)');

    // Run immediately on startup, then every 5 minutes
    cleanupStalePayments();
    setInterval(async () => {
        await cleanupStalePayments();
    }, 5 * 60 * 1000);
};

const cleanupStalePayments = async () => {
    try {
        const thirtyMinAgo = new Date(Date.now() - 22 * 60 * 1000);

        const stalePayments = await prisma.payment.findMany({
            where: {
                status: PaymentStatus.PENDING,
                mode: PaymentMode.ONLINE,
                createdAt: { lt: thirtyMinAgo }
            },
            select: { id: true, providerTxId: true, studentId: true, createdAt: true }
        });

        if (stalePayments.length === 0) return;

        logger.info(`[StalePaymentCleanup] Found ${stalePayments.length} stale PENDING payment(s)`);

        // Mark as FAILED
        const ids = stalePayments.map(p => p.id);
        await prisma.payment.updateMany({
            where: { id: { in: ids } },
            data: { status: PaymentStatus.FAILED, metadata: { reason: 'AUTO_EXPIRED', expiredAt: new Date().toISOString() } as any }
        });

        logger.info(`[StalePaymentCleanup] Marked ${ids.length} stale payments as FAILED`);
    } catch (error) {
        logger.error(`[StalePaymentCleanup] Error: ${error}`);
    }
};

// ─────────────────────────────────────────────
// Job 3: Payment Reconciliation
// Checks PhonePe status for PENDING online payments (5-30 min old)
// to catch missed callbacks
// ─────────────────────────────────────────────

export const startPaymentReconciliationJob = () => {
    logger.info('[PaymentReconciliation] Starting (Interval: 10 minutes)');

    // Run immediately on startup, then every 10 minutes
    reconcilePendingPayments();
    setInterval(async () => {
        await reconcilePendingPayments();
    }, 10 * 60 * 1000);
};

const reconcilePendingPayments = async () => {
    try {
        const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000);
        const twentyTwoMinAgo = new Date(Date.now() - 22 * 60 * 1000);

        // Find PENDING online payments between 3-22 minutes old
        // Lower: 3 min gives PhonePe time to send webhook first
        // Upper: 22 min aligns with PhonePe QR expiry (20 min) + 2 min buffer
        const pendingPayments = await prisma.payment.findMany({
            where: {
                status: PaymentStatus.PENDING,
                mode: PaymentMode.ONLINE,
                createdAt: { gt: twentyTwoMinAgo, lt: threeMinAgo }
            },
            select: { id: true, providerTxId: true, studentId: true },
            distinct: ['providerTxId']
        });

        if (pendingPayments.length === 0) return;

        logger.info(`[PaymentReconciliation] Found ${pendingPayments.length} pending payment(s) to reconcile`);

        const { checkPaymentStatus } = await import('../modules/finance/payment.service');

        let reconciled = 0;
        let failed = 0;

        for (const payment of pendingPayments) {
            if (!payment.providerTxId) continue;
            try {
                const result = await checkPaymentStatus(payment.providerTxId);
                if (result.status === 'SUCCESS' || result.status === 'FAILED') {
                    reconciled++;
                    logger.info(`[PaymentReconciliation] Reconciled ${payment.providerTxId} -> ${result.status}`);
                }
            } catch (err) {
                failed++;
                logger.warn(`[PaymentReconciliation] Failed to reconcile ${payment.providerTxId}: ${err}`);
            }

            // Small delay to avoid hammering PhonePe API
            await new Promise(r => setTimeout(r, 500));
        }

        logger.info(`[PaymentReconciliation] Done. Reconciled: ${reconciled}, Failed: ${failed}, Total: ${pendingPayments.length}`);
    } catch (error) {
        logger.error(`[PaymentReconciliation] Error: ${error}`);
    }
};

