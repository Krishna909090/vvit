import prisma from '../config/prisma';
import logger from '../utils/logger';
import { PaymentStatus, PaymentMode } from '@prisma/client';

export const startScholarshipExpiryJob = () => {
    logger.info('[ScholarshipExpiryJob] Scholarship feature removed — job disabled.');
};

export const startStalePaymentCleanupJob = () => {
    try {
        logger.info('[StalePaymentCleanup] Starting (Interval: 5 minutes)');

        cleanupStalePayments();
        setInterval(async () => {
            await cleanupStalePayments();
        }, 5 * 60 * 1000);
    } catch (err) {
        logger.error(`[StalePaymentCleanup] Failed to start: ${err}`);
    }
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

        const fullPayments = await prisma.payment.findMany({
            where: { id: { in: stalePayments.map(p => p.id) } },
            select: { id: true, metadata: true }
        });

        const expiredAt = new Date().toISOString();
        let markedCount = 0;
        for (const payment of fullPayments) {
            try {
                const existingMetadata = (payment.metadata && typeof payment.metadata === 'object' && !Array.isArray(payment.metadata))
                    ? payment.metadata as Record<string, unknown>
                    : {};
                await prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        status: PaymentStatus.FAILED,
                        metadata: { ...existingMetadata, reason: 'AUTO_EXPIRED', expiredAt } as any
                    }
                });
                markedCount++;
            } catch (err) {
                logger.error(`[StalePaymentCleanup] Failed to expire payment ${payment.id}: ${err}`);
            }
        }

        logger.info(`[StalePaymentCleanup] Marked ${markedCount} stale payments as FAILED`);
    } catch (error) {
        logger.error(`[StalePaymentCleanup] Error: ${error}`);
    }
};

export const startPaymentReconciliationJob = () => {
    try {
        logger.info('[PaymentReconciliation] Starting (Interval: 10 minutes)');

        reconcilePendingPayments();
        setInterval(async () => {
            await reconcilePendingPayments();
        }, 10 * 60 * 1000);
    } catch (err) {
        logger.error(`[PaymentReconciliation] Failed to start: ${err}`);
    }
};

const reconcilePendingPayments = async () => {
    try {
        const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000);
        const twentyTwoMinAgo = new Date(Date.now() - 22 * 60 * 1000);

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

            await new Promise(r => setTimeout(r, 500));
        }

        logger.info(`[PaymentReconciliation] Done. Reconciled: ${reconciled}, Failed: ${failed}, Total: ${pendingPayments.length}`);
    } catch (error) {
        logger.error(`[PaymentReconciliation] Error: ${error}`);
    }
};

