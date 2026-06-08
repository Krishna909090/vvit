import dotenv from 'dotenv';
import path from 'path';

const rootDir = path.resolve(__dirname, '../../');

const envFile =
  process.env.NODE_ENV === 'production'
    ? '.env.production'
    : '.env.development';

dotenv.config({
  path: path.join(rootDir, envFile),
});

dotenv.config({ override: true });
