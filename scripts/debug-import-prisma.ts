
import dotenv from 'dotenv';
import path from 'path';

// MUST Load env BEFORE importing prisma config
dotenv.config({ path: path.resolve(__dirname, '../.env.production') });

import prisma from '../src/config/prisma';

async function main() {
    console.log('--- Debugging Imported Prisma Instance ---');
    
    // Check internal URL if possible (usually private)
    // @ts-ignore
    const internalUrl = prisma._engineConfig?.datasourceOverrides?.db?.[0] || 'hidden';
    console.log('Internal Engine Config URL:', internalUrl);

    const keys = ['SMS_HEADER'];
    const configs = await prisma.configuration.findMany({
        where: { key: { in: keys } }
    });
    
    console.log(`Query Result Count: ${configs.length}`);
    configs.forEach(c => console.log(c));
}

main().finally(() => prisma.$disconnect());
