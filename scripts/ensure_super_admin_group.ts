
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const superAdminPhone = '9999999999';
  
  // 1. Find Super Admin
  const superAdmin = await prisma.user.findUnique({
    where: { phone: superAdminPhone }
  });

  if (!superAdmin) {
    console.error('Super Admin not found!');
    return;
  }
  console.log('Found Super Admin:', superAdmin.id);

  // 2. Find Administrators Group
  const adminGroup = await prisma.group.findUnique({
    where: { name: 'Administrators' },
    include: { roles: { include: { role: { include: { permissions: true } } } } }
  });

  if (!adminGroup) {
    console.error('Administrators group not found!');
    return;
  }
  console.log('Found Admin Group:', adminGroup.id);
  console.log('Admin Group Roles:', adminGroup.roles.map(r => r.role.name));
  
  // Verify Admin Role has permissions
  const adminRole = adminGroup.roles.find(r => r.role.name === 'ADMIN');
  if (adminRole) {
      console.log(`ADMIN Role has ${adminRole.role.permissions.length} permissions connected.`);
  } else {
      console.log('ADMIN Role not found in group!');
      // Attach if missing (though seed should have done it)
      const role = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
      if (role) {
          await prisma.groupRole.create({
              data: { groupId: adminGroup.id, roleId: role.id }
          });
          console.log('Attached ADMIN role to Administrators group.');
      }
  }

  // 3. Check if Super Admin is in Group
  const userGroup = await prisma.userGroup.findUnique({
    where: {
      userId_groupId: {
        userId: superAdmin.id,
        groupId: adminGroup.id
      }
    }
  });

  if (userGroup) {
    console.log('Super Admin is ALREADY in Administrators group.');
  } else {
    console.log('Super Admin is NOT in Administrators group. Attaching...');
    await prisma.userGroup.create({
      data: {
        userId: superAdmin.id,
        groupId: adminGroup.id
      }
    });
    console.log('Successfully attached Super Admin to Administrators group.');
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
