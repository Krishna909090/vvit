import dotenv from 'dotenv';
import path from 'path';

// Load environment variables before anything else
const rootDir = path.resolve(__dirname, '../../'); // always project root

const envFile =
  process.env.NODE_ENV === 'production'
    ? '.env.production'
    : '.env.development';

dotenv.config({
  path: path.join(rootDir, envFile),
});

// Fallback
dotenv.config();
