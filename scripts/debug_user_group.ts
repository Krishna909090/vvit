
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- DIAGNOSTIC START ---');

  // 1. Get Super Admin User
  const superAdmin = await prisma.user.findUnique({
    where: { phone: '9999999999' },
    select: { id: true, name: true, phone: true }
  });
  
  if (!superAdmin) {
    console.log('ERROR: Super Admin user (9999999999) NOT FOUND in User table.');
  } else {
    console.log(`ACTUAL Super Admin User ID: ${superAdmin.id}`);
  }

  // 2. Get Administrators Group
  const adminGroup = await prisma.group.findUnique({
    where: { name: 'Administrators' },
    include: { users: true }
  });

  if (!adminGroup) {
    console.log('ERROR: Administrators group NOT FOUND.');
    return;
  }
  
  console.log(`Administrators Group ID: ${adminGroup.id}`);
  console.log('Users assigned to Admin Group (from UserGroup table):');
  
  if (adminGroup.users.length === 0) {
      console.log('  -> No users assigned.');
  } else {
      adminGroup.users.forEach(ug => {
          console.log(`  -> Assigned User ID: ${ug.userId}`);
          if (superAdmin && ug.userId === superAdmin.id) {
              console.log('     (MATCHES Super Admin ID)');
          } else {
              console.log('     (DOES NOT MATCH Super Admin ID)');
          }
      });
  }
  
  console.log('--- DIAGNOSTIC END ---');
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
