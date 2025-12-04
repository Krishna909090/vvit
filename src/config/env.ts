import dotenv from 'dotenv';
import path from 'path';

// Load environment variables before anything else
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';

// Resolve path relative to CWD or __dirname
// Assuming running from root or dist
dotenv.config({ path: path.resolve(process.cwd(), envFile) });

// Fallback to default .env if specific file doesn't exist or for local dev
if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}
