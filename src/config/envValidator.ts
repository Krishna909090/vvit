

import logger from '../utils/logger';

interface EnvConfig {

    PORT: string;
    NODE_ENV: string;

    DATABASE_URL: string;

    JWT_SECRET: string;
    JWT_EXPIRES_IN?: string;
    JWT_REFRESH_SECRET?: string;
    JWT_REFRESH_EXPIRES_IN?: string;

    QR_ENCRYPTION_KEY: string;

    AWS_REGION?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
    AWS_BUCKET_NAME?: string;

    CORS_ORIGIN?: string;

    SKIP_DATE_VALIDATION?: string;

    PHONEPE_MERCHANT_ID?: string;
    PHONEPE_SALT_KEY?: string;
    PHONEPE_SALT_INDEX?: string;
    PHONEPE_ENV?: string;
    PHONEPE_CALLBACK_URL?: string;

    FRONTEND_URL?: string;
}

const requiredEnvVars: (keyof EnvConfig)[] = [
    'DATABASE_URL',
    'JWT_SECRET',
    'QR_ENCRYPTION_KEY'
];

const recommendedEnvVars: (keyof EnvConfig)[] = [
    'NODE_ENV',
    'PORT',
    'JWT_EXPIRES_IN',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_BUCKET_NAME',
    'CORS_ORIGIN',

    'PHONEPE_MERCHANT_ID',
    'PHONEPE_SALT_KEY',
    'PHONEPE_SALT_INDEX',
    'PHONEPE_ENV',
    'PHONEPE_CALLBACK_URL',
    'FRONTEND_URL'
];

export function validateEnvironment(): void {
    const missingRequired: string[] = [];
    const missingRecommended: string[] = [];

    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar] || process.env[envVar]?.trim() === '') {
            missingRequired.push(envVar);
        }
    }

    for (const envVar of recommendedEnvVars) {
        if (!process.env[envVar] || process.env[envVar]?.trim() === '') {
            missingRecommended.push(envVar);
        }
    }

    if (missingRequired.length > 0) {
        logger.error('❌ CRITICAL: Missing required environment variables:');
        missingRequired.forEach(varName => {
            logger.error(`   - ${varName}`);
        });
        logger.error('\n💡 Please set these variables in your .env file before starting the application.');
        logger.error('   Example: JWT_SECRET=your-super-secret-key-here\n');

        process.exit(1);
    }

    if (missingRecommended.length > 0) {
        logger.warn('⚠️  WARNING: Missing recommended environment variables:');
        missingRecommended.forEach(varName => {
            logger.warn(`   - ${varName}`);
        });
        logger.warn('   The application will use default values, but this is not recommended for production.\n');
    }

    const jwtSecret = process.env.JWT_SECRET!;
    if (jwtSecret.length < 32) {
        logger.warn('⚠️  WARNING: JWT_SECRET is too short. Recommended minimum length: 32 characters');
    }

    const qrKey = process.env.QR_ENCRYPTION_KEY!;
    if (qrKey.length < 32) {
        logger.warn('⚠️  WARNING: QR_ENCRYPTION_KEY is too short. Recommended minimum length: 32 characters');
    }

    const validEnvs = ['development', 'production', 'test'];
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (!validEnvs.includes(nodeEnv)) {
        logger.warn(`⚠️  WARNING: NODE_ENV="${nodeEnv}" is not standard. Use: development, production, or test`);
    }

    logger.info('✅ Environment validation passed');
    logger.info(`   Environment: ${nodeEnv}`);
    logger.info(`   Database: ${process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'configured'}`);
    logger.info(`   CORS Origin: ${process.env.CORS_ORIGIN || '*'}`);
}

export function getEnv(key: keyof EnvConfig, defaultValue?: string): string {
    const value = process.env[key];
    
    if (!value && !defaultValue) {
        throw new Error(`Environment variable ${key} is not set and no default value provided`);
    }
    
    return value || defaultValue!;
}

export function isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
}

export function isDevelopment(): boolean {
    return process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
}

export function isTest(): boolean {
    return process.env.NODE_ENV === 'test';
}
