
import { PrismaClient, Role } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

// Load .env.production
dotenv.config({ path: path.resolve(__dirname, '../.env.production') });

const prisma = new PrismaClient();

async function main() {
    const admins = [
        { phone: '9493697463', name: 'Krishna', email: null },
        { phone: '8297592829', name: 'Madhu', email: 'madhubabujanjanam@vvitu.com' }
    ];

    for (const admin of admins) {
        console.log(`Processing Admin: ${admin.name} (${admin.phone})...`);
        
        await prisma.user.upsert({
            where: { phone: admin.phone },
            update: {
                role: Role.ADMIN,
                name: admin.name,
                ...(admin.email ? { email: admin.email } : {}),
                isDeleted: false
            },
            create: {
                phone: admin.phone,
                name: admin.name,
                email: admin.email || undefined,
                role: Role.ADMIN,
                isDeleted: false
            }
        });
        console.log(`✅ Admin ${admin.name} configured.`);
    }

    console.log(`✅ All Admins configured successfully.`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
