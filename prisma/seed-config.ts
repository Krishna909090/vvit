
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const configurations = [
    { key: 'SMS_HEADER', value: 'VVITPO', category: 'SMS' },
    { key: 'SMS_ENTITY_ID', value: '1401575220000071076', category: 'SMS' },
    { key: 'SMS_CONTENT_TEMPLATE_ID', value: '1407174220708182938', category: 'SMS' }, // For OTP
    // Keep generic ones if needed, or remove if strictly replacing
    { key: 'BSNL_SMS_URL', value: process.env.BSNL_SMS_URL || 'https://bulksms.bsnl.in/api/sendhttp.php', category: 'SMS' },
    { key: 'BSNL_SMS_USERNAME', value: process.env.BSNL_SMS_USERNAME || 'CHANGE_ME', category: 'SMS' },
    { key: 'BSNL_SMS_PASSWORD', value: process.env.BSNL_SMS_PASSWORD || 'CHANGE_ME', category: 'SMS' },
];

async function main() {
  console.log('Seeding configuration...');
  for (const config of configurations) {
    await prisma.configuration.upsert({
        where: { key: config.key },
        update: { value: config.value, category: config.category },
        create: config
    });
    console.log(`Upserted config: ${config.key}`);
  }
  console.log('Configuration seeded.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
