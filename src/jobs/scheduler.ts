import prisma from '../config/prisma';
import logger from '../utils/logger';
import { ScholarshipStatus } from '@prisma/client';

export const startScholarshipExpiryJob = () => {
    logger.info('⏳ Starting Scholarship Expiry Job (Interval: 1 hour)');

    // Run immediately on startup
    checkExpiredScholarships();

    // Run every 1 hour (3600000 ms)
    setInterval(async () => {
        await checkExpiredScholarships();
    }, 3600000); 
};

const checkExpiredScholarships = async () => {
    try {
        logger.info('Running Scholarship Expiry Check...');
        const now = new Date();

        // Find allocations that are LOCKED and passed their expiry time
        const expiredAllocations = await prisma.scholarshipAllocation.findMany({
            where: {
                status: ScholarshipStatus.LOCKED,
                expiresAt: { lt: now }
            }
        });

        if (expiredAllocations.length === 0) {
            logger.info('No expired scholarships found.');
            return;
        }

        logger.info(`Found ${expiredAllocations.length} expired scholarships. Processing...`);

        let processedCount = 0;
        for (const allocation of expiredAllocations) {
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
                logger.info(`Expired scholarship for student ${allocation.studentId}`);
            } catch (err) {
                logger.error(`Failed to expire scholarship for ${allocation.studentId}: ${err}`);
            }
        }

        logger.info(`Scholarship Expiry Check Completed. Processed: ${processedCount}/${expiredAllocations.length}`);

    } catch (error) {
        logger.error(`Error in Scholarship Expiry Job: ${error}`);
    }
};
