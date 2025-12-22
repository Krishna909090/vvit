import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    // Default Password
    const passwordHash = await bcrypt.hash('Admin@123', 10);

    // Create a Super Admin
    const superAdminPhone = '9999999999';
    const superAdmin = await prisma.user.upsert({
        where: { phone: superAdminPhone },
        update: {
            role: Role.SUPER_ADMIN,
            name: 'Super Admin',
            email: 'superadmin@college.com',
            password: passwordHash
        },
        create: {
            phone: superAdminPhone,
            role: Role.SUPER_ADMIN,
            name: 'Super Admin',
            email: 'superadmin@college.com',
            password: passwordHash
        },
    });
    console.log('Super Admin created/updated:', superAdmin);

    // Create an Admin
    const adminPhone = '8888888888';
    const admin = await prisma.user.upsert({
        where: { phone: adminPhone },
        update: {
            role: Role.ADMIN,
            name: 'Admin User',
            email: 'admin@college.com',
            password: passwordHash
        },
        create: {
            phone: adminPhone,
            role: Role.ADMIN,
            name: 'Admin User',
            email: 'admin@college.com',
            password: passwordHash
        },
    });
    console.log('Admin created/updated:', admin);

    // Seed Configuration
    const configs = [
        { key: 'SMS_HEADER', value: 'VVITPO' },
        { key: 'SMS_ENTITY_ID', value: '1401575220000071076' },
        { key: 'SMS_CONTENT_TEMPLATE_ID', value: '1407174220708182938' }
    ];

    for (const config of configs) {
        await prisma.configuration.upsert({
            where: { key: config.key },
            update: { value: config.value },
            create: { key: config.key, value: config.value }
        });
        console.log(`Synced config: ${config.key}`);
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
