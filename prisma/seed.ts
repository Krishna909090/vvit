import { PrismaClient, UserRole } from '@prisma/client';
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
            role: UserRole.SUPER_ADMIN,
            name: 'Super Admin',
            email: 'superadmin@college.com',
            password: passwordHash
        },
        create: {
            phone: superAdminPhone,
            role: UserRole.SUPER_ADMIN,
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
            role: UserRole.ADMIN,
            name: 'Admin User',
            email: 'admin@college.com',
            password: passwordHash
        },
        create: {
            phone: adminPhone,
            role: UserRole.ADMIN,
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

    // --- RBAC SEEDING ---
    console.log('Seeding RBAC...');

    const modules = [
        'academic', 'admin', 'admission', 'document', 'exam', 'finance', 
        'hostel', 'qualification', 'scholarship', 'student', 'transport'
    ];

    const actions = ['create', 'read', 'update', 'delete'];
    const scopes = ['own', 'all'];

    const permissions: { key: string; moduleCode: string; description: string }[] = [];

    for (const m of modules) {
        for (const a of actions) {
            for (const s of scopes) {
                permissions.push({
                    key: `${m}.${a}.${s}`,
                    moduleCode: m.toUpperCase(),
                    description: `${a.toUpperCase()} ${m} (${s})`
                });
            }
        }
    }

    // Create Modules and store their IDs
    const moduleMap = new Map<string, string>();
    for (const m of modules) {
        const code = m.toUpperCase();
        const name = m.charAt(0).toUpperCase() + m.slice(1);
        const module = await prisma.module.upsert({
            where: { code },
            update: { name },
            create: { name, code }
        });
        moduleMap.set(code, module.id);
    }
    console.log(`Seeded ${modules.length} modules.`);

    // Create Permissions
    for (const p of permissions) {
        const moduleId = moduleMap.get(p.moduleCode);
        if (!moduleId) {
            console.error(`Module ID not found for code: ${p.moduleCode}`);
            continue;
        }

        await prisma.permission.upsert({
            where: { key: p.key },
            update: { moduleId: moduleId, description: p.description },
            create: { key: p.key, moduleId: moduleId, description: p.description }
        });
    }
    console.log(`Seeded ${permissions.length} permissions.`);

    // Create Roles
    const adminRole = await prisma.role.upsert({
        where: { name: 'ADMIN' },
        update: { description: 'System Administrator with full access' },
        create: { name: 'ADMIN', description: 'System Administrator with full access' }
    });

    const studentRole = await prisma.role.upsert({
        where: { name: 'STUDENT' }, // Using 'STUDENT' to match UserRole enum if needed, or just standard naming
        update: { description: 'Student Role with access to own data' },
        create: { name: 'STUDENT', description: 'Student Role with access to own data' }
    });
    
    // Assign ALL permissions to ADMIN (Both own and all, or just all implies own? 
    // Logic usually checks explicit key. So give all.)
    const allPerms = await prisma.permission.findMany();
    const adminPermsData = allPerms.map(p => ({
        roleId: adminRole.id,
        permissionId: p.id
    }));

    // Assign Student Permissions
    // Students get '.own' permissions for key areas
    const studentPermKeys = [
        'student.create.own', 'student.read.own', 'student.update.own',
        'finance.create.own', 'finance.read.own',
        'exam.create.own', 'exam.read.own',
        'hostel.read.own',
        'transport.read.own',
        'document.create.own', 'document.read.own', 'document.delete.own',
        'admission.read.own'
    ];

    const studentPerms = await prisma.permission.findMany({
        where: { key: { in: studentPermKeys } }
    });

    const studentPermsData = studentPerms.map(p => ({
        roleId: studentRole.id,
        permissionId: p.id
    }));



    // Start Transaction to assign
    // Using simple loop to avoid complex mismatch
    const allRolePerms = [...adminPermsData, ...studentPermsData];

    for (const ap of allRolePerms) {
        try {
             await prisma.rolePermission.create({
                data: ap
             });
        } catch (e) {
            // Ignore dupes
        }
    }
    console.log('Assigned permissions to ADMIN and STUDENT roles.');

    // Create Groups
    // Admin Group
    const adminGroup = await prisma.group.upsert({
        where: { name: 'Administrators' },
        update: {},
        create: { name: 'Administrators', type: 'ADMIN' }
    });

    // Student Group
    const studentGroup = await prisma.group.upsert({
        where: { name: 'Students' },
        update: {},
        create: { name: 'Students', type: 'STUDENT' }
    });

    // Other Default Groups
    await prisma.group.upsert({ where: { name: 'Staff' }, update: {}, create: { name: 'Staff', type: 'STAFF' } });
    await prisma.group.upsert({ where: { name: 'Invigilators' }, update: {}, create: { name: 'Invigilators', type: 'INVIGILATOR' } });
    await prisma.group.upsert({ where: { name: 'Agents' }, update: {}, create: { name: 'Agents', type: 'AGENT' } });

    // Assign Roles to Groups
    // Admin Group -> Admin Role
    try {
        await prisma.groupRole.create({
            data: { groupId: adminGroup.id, roleId: adminRole.id }
        });
    } catch(e) {}

    // Student Group -> Student Role
    try {
        await prisma.groupRole.create({
            data: { groupId: studentGroup.id, roleId: studentRole.id }
        });
    } catch(e) {}

    // Assign Admins to Admin Group (CRITICAL FOR INITIAL ACCESS)
    try {
        await prisma.userGroup.create({
            data: { userId: superAdmin.id, groupId: adminGroup.id }
        });
    } catch(e) {}

    try {
        await prisma.userGroup.create({
            data: { userId: admin.id, groupId: adminGroup.id }
        });
    } catch(e) {}

    console.log('Groups created, roles assigned, and initial admins added to group.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
