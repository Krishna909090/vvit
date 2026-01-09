
import dotenv from 'dotenv';
dotenv.config();

const url = process.env.DATABASE_URL || '';
const host = url.split('@')[1]?.split('/')[0] || 'Unknown';
console.log('Database Host:', host);
