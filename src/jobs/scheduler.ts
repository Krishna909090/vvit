import prisma from '../config/prisma';
import logger from '../utils/logger';
import { ScholarshipStatus } from '@prisma/client';

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

        logger.info(`[ScholarshipExpiryJob] Check Completed. ✅ Processed: ${processedCount} | ❌ Failed: ${expiredAllocations.length - processedCount} | Total: ${expiredAllocations.length}`);

    } catch (error) {
        logger.error(`Error in Scholarship Expiry Job: ${error}`);
    }
};

