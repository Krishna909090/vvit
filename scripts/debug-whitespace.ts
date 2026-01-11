
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.production') });
const prisma = new PrismaClient();

async function main() {
    console.log('Inspecting keys for hidden characters...');
    
    // Fetch all configurations
    const configs = await prisma.configuration.findMany();
    
    configs.forEach(c => {
        const key = c.key;
        console.log(`Key: '${key}' (Length: ${key.length})`);
        
        // Check for specific target keys
        if (['SMS_HEADER', 'SMS_ENTITY_ID', 'SMS_CONTENT_TEMPLATE_ID'].includes(key.trim())) {
             if (key !== key.trim()) {
                 console.error(`🚨 WARNING: Key '${key}' has hidden whitespace! Should be trimmed.`);
             }
        }
    });
}

main().finally(() => prisma.$disconnect());
