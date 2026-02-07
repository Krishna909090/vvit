import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seedRBAC() {
    console.log('🧹 Cleaning up existing RBAC data...');
    // Delete in order of dependency to avoid foreign key constraints
    await prisma.userPermissionOverride.deleteMany({});
    await prisma.rolePermission.deleteMany({});
    await prisma.groupRole.deleteMany({});
    await prisma.userGroup.deleteMany({});
    await prisma.permission.deleteMany({});
    await prisma.role.deleteMany({});
    await prisma.group.deleteMany({});
    await prisma.module.deleteMany({});
    console.log('✅ Cleanup complete!');

    console.log('🌱 Starting RBAC Seed...');

    // 1. Create Modules
    const modules = [
        { name: 'Academic System', code: 'academic' },
        { name: 'Admin System', code: 'admin' },
        { name: 'Admission System', code: 'admission' },
        { name: 'Document Management', code: 'document' },
        { name: 'Examination', code: 'exam' },
        { name: 'Finance & Accounts', code: 'finance' },
        { name: 'Hostel Management', code: 'hostel' },
        { name: 'Qualification Management', code: 'qualification' },
        { name: 'Scholarship Management', code: 'scholarship' },
        { name: 'Student Management', code: 'student' },
        { name: 'Transport Management', code: 'transport' },
    ];

    const createdModules: Record<string, any> = {};
    for (const mod of modules) {
        const module = await prisma.module.upsert({
            where: { code: mod.code },
            update: { name: mod.name },
            create: mod,
        });
        createdModules[mod.code] = module;
        console.log(`✅ Module: ${mod.code}`);
    }

    // 2. Create Permissions (CRUD pattern: create.own, create.all, read.own, read.all, update.own, update.all, delete.own, delete.all)
    const permissionKeys = ['create.own', 'create.all', 'read.own', 'read.all', 'update.own', 'update.all', 'delete.own', 'delete.all'];
    
    for (const [moduleCode, module] of Object.entries(createdModules)) {
        for (const permKey of permissionKeys) {
            const fullKey = `${moduleCode}.${permKey}`;
            const [action, scope] = permKey.split('.');
            const description = `${action.charAt(0).toUpperCase() + action.slice(1)} ${scope === 'own' ? 'own' : 'all'} ${moduleCode} records`;
            
            await prisma.permission.upsert({
                where: { key: fullKey },
                update: { description },
                create: {
                    key: fullKey,
                    description,
                    moduleId: module.id,
                },
            });
        }
        console.log(`✅ Permissions for module: ${moduleCode}`);
    }

    // 3. Create Roles
    const roles = [
        { name: 'SuperAdminRole', description: 'Full system access' },
        { name: 'AdminRole', description: 'Administrative access' },
        { name: 'RegistrarRole', description: 'Student admission and management' },
        { name: 'AccountantRole', description: 'Finance and fee management' },
        { name: 'InvigilatorRole', description: 'Exam management and attendance' },
        { name: 'StudentRole', description: 'Student self-service access' },
    ];

    const createdRoles: Record<string, any> = {};
    for (const role of roles) {
        const created = await prisma.role.upsert({
            where: { name: role.name },
            update: { description: role.description },
            create: role,
        });
        createdRoles[role.name] = created;
        console.log(`✅ Role: ${role.name}`);
    }

    // 4. Assign ALL permissions to SuperAdminRole
    const allPermissions = await prisma.permission.findMany();
    for (const permission of allPermissions) {
        await prisma.rolePermission.upsert({
            where: {
                roleId_permissionId: {
                    roleId: createdRoles['SuperAdminRole'].id,
                    permissionId: permission.id,
                },
            },
            update: {},
            create: {
                roleId: createdRoles['SuperAdminRole'].id,
                permissionId: permission.id,
            },
        });
    }
    console.log(`✅ Assigned ${allPermissions.length} permissions to SuperAdminRole`);

    // 5. Assign permissions to StudentRole (read.own only)
    const studentPermissions = await prisma.permission.findMany({
        where: {
            key: {
                endsWith: '.read.own',
            },
        },
    });
    for (const permission of studentPermissions) {
        await prisma.rolePermission.upsert({
            where: {
                roleId_permissionId: {
                    roleId: createdRoles['StudentRole'].id,
                    permissionId: permission.id,
                },
            },
            update: {},
            create: {
                roleId: createdRoles['StudentRole'].id,
                permissionId: permission.id,
            },
        });
    }
    console.log(`✅ Assigned ${studentPermissions.length} permissions to StudentRole`);

    // 6. Create Groups
    const groups = [
        { name: 'SuperAdminGroup', type: 'SUPER_ADMIN' },
        { name: 'AdminGroup', type: 'ADMIN' },
        { name: 'StudentGroup', type: 'STUDENT' },
        { name: 'StaffGroup', type: 'STAFF' },
    ];

    const createdGroups: Record<string, any> = {};
    for (const group of groups) {
        const created = await prisma.group.upsert({
            where: { name: group.name },
            update: { type: group.type },
            create: group,
        });
        createdGroups[group.name] = created;
        console.log(`✅ Group: ${group.name}`);
    }

    // 7. Assign Roles to Groups
    await prisma.groupRole.upsert({
        where: {
            groupId_roleId: {
                groupId: createdGroups['SuperAdminGroup'].id,
                roleId: createdRoles['SuperAdminRole'].id,
            },
        },
        update: {},
        create: {
            groupId: createdGroups['SuperAdminGroup'].id,
            roleId: createdRoles['SuperAdminRole'].id,
        },
    });
    console.log(`✅ Assigned SuperAdminRole to SuperAdminGroup`);

    await prisma.groupRole.upsert({
        where: {
            groupId_roleId: {
                groupId: createdGroups['StudentGroup'].id,
                roleId: createdRoles['StudentRole'].id,
            },
        },
        update: {},
        create: {
            groupId: createdGroups['StudentGroup'].id,
            roleId: createdRoles['StudentRole'].id,
        },
    });
    console.log(`✅ Assigned StudentRole to StudentGroup`);

    // 8. Assign Super Admin user to SuperAdminGroup
    const superAdmin = await prisma.user.findUnique({
        where: { email: 'superadmin@college.com' },
    });

    if (superAdmin) {
        await prisma.userGroup.upsert({
            where: {
                userId_groupId: {
                    userId: superAdmin.id,
                    groupId: createdGroups['SuperAdminGroup'].id,
                },
            },
            update: {},
            create: {
                userId: superAdmin.id,
                groupId: createdGroups['SuperAdminGroup'].id,
            },
        });
        console.log(`✅ Assigned Super Admin user to SuperAdminGroup`);
    }

    console.log('🎉 RBAC Seed Complete!');
}

seedRBAC()
    .catch((e) => {
        console.error('❌ RBAC Seed Error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
