import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Fixing payment data...');
    try {
        // Find payments with null component
        // Note: component might not be typed as nullable in generated client yet if we didn't generate it,
        // but we can try to update using updateMany where component is possibly missing or by raw query if needed.
        // However, Prisma client generated based on OLD schema allowed nulls (presumably).
        // Let's check schema history. Previous schema had component?
        // If previous schema didn't have component or it was optional, it's fine.
        // The error `Made the column component ... required, but there are 1 existing NULL values` means it exists as null.

        const result = await prisma.payment.updateMany({
            where: {
                component: null as any
            },
            data: {
                component: "OTHER" // Using a safe default from enum
            }
        });

        console.log(`Updated ${result.count} payment records.`);
    } catch (e) {
        console.error('Error updating payments:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
