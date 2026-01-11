
import { PrismaClient, Role } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

// Load .env.production
dotenv.config({ path: path.resolve(__dirname, '../.env.production') });

const prisma = new PrismaClient();

async function main() {
    const PHONE = '8297592829';
    const NAME = 'Madhu';
    const EMAIL = 'madhubabujanjanam@vvitu.com';

    console.log(`Checking for user with phone: ${PHONE}...`);

    const user = await prisma.user.upsert({
        where: { phone: PHONE },
        update: {
            role: Role.ADMIN,
            name: NAME,
            email: EMAIL,
            isDeleted: false
        },
        create: {
            phone: PHONE,
            name: NAME,
            email: EMAIL,
            role: Role.ADMIN,
            isDeleted: false
        }
    });

    console.log(`✅ User ${user.name} (${user.phone}) is now an ADMIN.`);
    console.log(`User ID: ${user.id}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
