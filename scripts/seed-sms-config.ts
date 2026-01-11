
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

// Load .env.production to connect to Prod DB
dotenv.config({ path: path.resolve(__dirname, '../.env.production') });

const prisma = new PrismaClient();

async function main() {
    console.log('Connecting to database...');
    
    // Configs to upsert
    const configs = [
        {
            key: 'SMS_HEADER',
            value: 'VVITPO',
            description: 'Header ID for SMS Gateway'
        },
        {
            key: 'SMS_ENTITY_ID',
            value: '1401575220000071076',
            description: 'Entity ID (DLT) for SMS Gateway'
        },
        {
            key: 'SMS_CONTENT_TEMPLATE_ID',
            value: '1407174220708182938',
            description: 'Content Template ID (DLT) for SMS OTP'
        }
    ];

    for (const config of configs) {
        // Upsert based on 'key' (assuming key is unique) or findFirst/update/create logic
        
        // Check if exists first (safer if key isn't @unique)
        const existing = await prisma.configuration.findFirst({
            where: { key: config.key }
        });

        if (existing) {
             console.log(`Updating existing config: ${config.key}`);
             await prisma.configuration.update({
                 where: { id: existing.id },
                 data: { value: config.value }
             });
        } else {
            console.log(`Creating new config: ${config.key}`);
            await prisma.configuration.create({
                data: {
                    key: config.key,
                    value: config.value,
                    description: config.description
                }
            });
        }
    }
    
    console.log('SMS Configuration seeded successfully!');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
