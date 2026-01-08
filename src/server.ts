import './config/env'; // Must be first
import { validateEnvironment } from './config/envValidator'; // Validate environment variables
import app from './app';
import logger from './utils/logger';
import { getDatabaseSecret } from './config/awsConfig';

const PORT = process.env.PORT || 3000;
const SECRET_NAME = process.env.AWS_SECRET_NAME || "rds-secretname";

const startServer = async () => {
    try {
        // STEP 1: Validate environment variables BEFORE anything else
        logger.info('🔍 Validating environment configuration...');
        validateEnvironment();
        
        if (process.env.USE_LOCAL_DB === 'true') {
            logger.info('Using local database configuration from environment variables.');
            if (!process.env.DATABASE_URL) {
                logger.warn('DATABASE_URL is not set in environment variables for local usage.');
            }
        } else {
            // Fetch Database Credentials
            logger.info('Fetching database credentials from Secrets Manager...');
            const dbCredentials = await getDatabaseSecret(SECRET_NAME);

            if (dbCredentials) {
                const { username, password, host, port, dbname } = dbCredentials;
                const dbUser = username;
                const dbPass = encodeURIComponent(password); // Encode password to handle special chars
                const dbHost = host || process.env.DB_HOST;
                const dbPort = port || process.env.DB_PORT || 5432;
                const dbName = process.env.DB_NAME || "postgres";

                const databaseUrl = `postgresql://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}?schema=public`;

                // Set env var for Prisma
                process.env.DATABASE_URL = databaseUrl;
                logger.info('Database credentials configured successfully.');
            } else {
                logger.warn('No secret string found. Using existing DATABASE_URL if available.');
            }
        }

        if (process.env.USE_LOCAL_DB !== 'true' && !process.env.DATABASE_URL) {
            // Already handled above
        }
        
        // Start Schedulers
        const { startScholarshipExpiryJob } = require('./jobs/scheduler');
        startScholarshipExpiryJob();

        app.listen(PORT, () => {
            logger.info(`🚀 Server is running on port ${PORT}`);
            logger.info(`📚 Swagger docs available at http://localhost:${PORT}/api-docs`);
            logger.info(`🔒 Security: Environment validation passed`);
        });

    } catch (error: any) {
        logger.error(`❌ Failed to start server: ${error.message}`);
        process.exit(1);
    }
};

startServer();
