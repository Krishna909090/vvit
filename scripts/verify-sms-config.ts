
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

// Load .env.production to connect to Prod DB
dotenv.config({ path: path.resolve(__dirname, '../.env.production') });

const prisma = new PrismaClient();

async function main() {
    console.log('Connecting to database...');
    
    const keysToCheck = ['SMS_HEADER', 'SMS_ENTITY_ID', 'SMS_CONTENT_TEMPLATE_ID'];
    
    const configs = await prisma.configuration.findMany({
        where: { key: { in: keysToCheck } }
    });
    
    console.log('API Output:');
    console.table(configs.map(c => ({ 
        Key: c.key, 
        Value: c.value, 
        ID: c.id 
    })));
    
    if (configs.length === 3) {
        console.log('✅ All 3 keys are present in Production DB.');
    } else {
        console.log('❌ Some keys are missing!');
        const foundKeys = configs.map(c => c.key);
        const missing = keysToCheck.filter(k => !foundKeys.includes(k));
        console.log('Missing:', missing);
    }
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
