import { PrismaClient } from '@prisma/client';

const url = process.env.DATABASE_URL || '';
const host = url.split('@')[1]?.split('/')[0] || 'Unknown';
console.log(`[Prisma Init] Connecting to Host: ${host}`);

const prisma = new PrismaClient();

export default prisma;
// Prisma Client Instance

