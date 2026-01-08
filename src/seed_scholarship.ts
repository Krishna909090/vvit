
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Scholarship Rules...');

  const rules = [
    {
      name: 'Merit Scholarship (Platinum)',
      minPercentile: 98.0,
      discountPercentage: 100.0,
      totalSlots: 10,
      degreeType: 'BTECH',
      isActive: true,
    },
    {
      name: 'Merit Scholarship (Gold)',
      minPercentile: 95.0,
      discountPercentage: 50.0,
      totalSlots: 20,
      degreeType: 'BTECH',
      isActive: true,
    },
    {
      name: 'Merit Scholarship (Silver)',
      minPercentile: 90.0,
      discountPercentage: 25.0,
      totalSlots: 50,
      degreeType: 'BTECH',
      isActive: true,
    },
    {
        name: 'Merit Scholarship (Bronze)',
        minPercentile: 80.0,
        discountPercentage: 10.0,
        totalSlots: 100,
        degreeType: 'BTECH',
        isActive: true,
      }
  ];

  for (const rule of rules) {
    // Check if exists to avoid duplicates (by name)
    const existing = await prisma.scholarshipRule.findFirst({
        where: { name: rule.name }
    });

    if (!existing) {
        await prisma.scholarshipRule.create({
            data: rule
        });
        console.log(`Created rule: ${rule.name}`);
    } else {
        console.log(`Rule already exists: ${rule.name}`);
    }
  }

  console.log('Scholarship Rules seeding completed.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
