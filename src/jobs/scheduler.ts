import prisma from '../config/prisma';
import logger from '../utils/logger';
import { PaymentStatus, PaymentMode, PaymentComponent } from '@prisma/client';

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

export const startConvenorAllotHealJob = () => {
    try {
        logger.info('[ConvenorAllotHeal] Starting (Interval: 10 minutes)');
        healStuckConvenorAllotments();
        setInterval(async () => {
            await healStuckConvenorAllotments();
        }, 10 * 60 * 1000);
    } catch (err) {
        logger.error(`[ConvenorAllotHeal] Failed to start: ${err}`);
    }
};

const HEAL_MAX_ATTEMPTS = 5;
const HEAL_BATCH_SIZE  = 100;

// Finds CONVENOR_ALLOT payments that are SUCCESS but whose CA is still REPORTED
// and retries completion. Failure counts are stored in payment.metadata._healAttempts
// so they survive process restarts (no in-memory state).
const healStuckConvenorAllotments = async () => {
    try {
        const stuckCAs = await prisma.convenorAdmission.findMany({
            where: { status: 'REPORTED', studentId: { not: null } },
            select: { studentId: true },
        });
        const stuckStudentIds = stuckCAs.map(ca => ca.studentId as string);
        if (stuckStudentIds.length === 0) return;

        const stuckPayments = await prisma.payment.findMany({
            where: {
                status: PaymentStatus.SUCCESS,
                component: PaymentComponent.REGISTRATION,
                isDeleted: false,
                studentId: { in: stuckStudentIds },
            },
            include: { student: true },
            take: HEAL_BATCH_SIZE,  // process up to 100 per cycle; next cycle picks up remainder
        });

        if (stuckPayments.length === 0) return;

        logger.warn(`[ConvenorAllotHeal] Found ${stuckPayments.length} stuck payment(s) — retrying`);

        const { ConvenorAdmissionService } = await import('../modules/convenorAdmission/convenorAdmission.service');

        for (const payment of stuckPayments) {
            const meta = (payment.metadata && typeof payment.metadata === 'object' && !Array.isArray(payment.metadata))
                ? payment.metadata as Record<string, any>
                : {} as Record<string, any>;

            // Persist failure count in DB so retries survive process restarts
            const attempts: number = meta._healAttempts ?? 0;
            if (attempts >= HEAL_MAX_ATTEMPTS) {
                logger.error(`[ConvenorAllotHeal] Payment ${payment.id} exhausted ${HEAL_MAX_ATTEMPTS} attempts — manual intervention required`);
                continue;
            }

            try {
                // If metadata was overwritten by PhonePe response, convenorAdmissionId is gone.
                // Recover by looking up the REPORTED CA for this student directly.
                if (!meta.convenorAdmissionId) {
                    let ca: { id: string; courseId: string | null; entryYear: number | null; feesReimbursement: boolean | null } | null = null;
                    try {
                        ca = await prisma.convenorAdmission.findFirst({
                            where: { studentId: payment.studentId, status: 'REPORTED', isDeleted: false },
                            select: { id: true, courseId: true, entryYear: true, feesReimbursement: true },
                        });
                    } catch (lookupErr) {
                        // DB error during CA lookup — treat as transient, will retry next cycle
                        logger.error(`[ConvenorAllotHeal] CA lookup failed for payment=${payment.id}: ${lookupErr}`);
                        await prisma.payment.update({
                            where: { id: payment.id },
                            data: { metadata: { ...meta, _healAttempts: attempts + 1 } as any },
                        }).catch(() => {});
                        continue;
                    }

                    if (!ca?.id || !ca.courseId) {
                        // CA deleted or course missing — cannot recover, stop retrying
                        logger.warn(`[ConvenorAllotHeal] No recoverable CA for payment=${payment.id} student=${payment.studentId} — giving up`);
                        await prisma.payment.update({
                            where: { id: payment.id },
                            data: { metadata: { ...meta, _healAttempts: HEAL_MAX_ATTEMPTS, _healGiveUp: true } as any },
                        }).catch(() => {});
                        continue;
                    }

                    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                    if (!UUID_RE.test(ca.id) || !UUID_RE.test(ca.courseId)) {
                        logger.error(`[ConvenorAllotHeal] Recovered CA has invalid UUIDs id=${ca.id} courseId=${ca.courseId} — giving up`);
                        await prisma.payment.update({
                            where: { id: payment.id },
                            data: { metadata: { ...meta, _healAttempts: HEAL_MAX_ATTEMPTS, _healGiveUp: true } as any },
                        }).catch(() => {});
                        continue;
                    }

                    // Accommodation intent was in the overwritten metadata — cannot recover.
                    // Default to NONE; hostel/transport can be assigned via dedicated API.
                    logger.warn(`[ConvenorAllotHeal] Payment ${payment.id}: accommodation metadata lost — defaulting to NONE. Manual hostel/transport assignment may be needed if student had accommodation.`);

                    payment.metadata = {
                        ...meta,
                        targetAction:        'CONVENOR_ALLOT',
                        convenorAdmissionId: ca.id,
                        courseId:            ca.courseId,
                        caCourseId:          ca.courseId,
                        caEntryYear:         ca.entryYear ?? 1,
                        feesReimbursement:   ca.feesReimbursement ?? false,
                        accommodation:       { type: 'NONE' },
                        adminId:             'SYSTEM',
                    };
                    logger.info(`[ConvenorAllotHeal] Recovered metadata for payment=${payment.id} from CA=${ca.id}`);
                }

                await ConvenorAdmissionService.completeAllotAfterPayment(payment);

                // Clear heal counter on success
                await prisma.payment.update({
                    where: { id: payment.id },
                    data: { metadata: { ...(payment.metadata as object), _healAttempts: 0 } as any },
                }).catch(() => {});
                logger.info(`[ConvenorAllotHeal] Healed payment=${payment.id} CA=${(payment.metadata as any).convenorAdmissionId}`);

            } catch (err) {
                // Increment persistent counter so retries survive restart
                await prisma.payment.update({
                    where: { id: payment.id },
                    data: { metadata: { ...meta, _healAttempts: attempts + 1 } as any },
                }).catch(() => {});
                logger.error(`[ConvenorAllotHeal] Failed to heal payment=${payment.id} (attempt ${attempts + 1}/${HEAL_MAX_ATTEMPTS}): ${err}`);
            }
        }

        if (stuckPayments.length === HEAL_BATCH_SIZE) {
            logger.warn(`[ConvenorAllotHeal] Batch full (${HEAL_BATCH_SIZE}) — more may remain, will process next cycle`);
        }
    } catch (error) {
        logger.error(`[ConvenorAllotHeal] Error: ${error}`);
    }
};
