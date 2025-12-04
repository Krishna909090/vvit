import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    // Create a Super Admin
    const superAdminPhone = '9999999999';
    const superAdmin = await prisma.user.upsert({
        where: { phone: superAdminPhone },
        update: {
            role: Role.SUPER_ADMIN,
            name: 'Super Admin',
            email: 'superadmin@college.com'
        },
        create: {
            phone: superAdminPhone,
            role: Role.SUPER_ADMIN,
            name: 'Super Admin',
            email: 'superadmin@college.com'
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
            email: 'admin@college.com'
        },
        create: {
            phone: adminPhone,
            role: Role.ADMIN,
            name: 'Admin User',
            email: 'admin@college.com'
        },
    });
    console.log('Admin created/updated:', admin);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
