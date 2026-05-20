import './config/env'; // Must be first
import { validateEnvironment } from './config/envValidator'; // Validate environment variables
import app from './app';
import logger from './utils/logger';
import { getDatabaseSecret } from './config/awsConfig';
import { version } from '../package.json';
import { startStalePaymentCleanupJob, startPaymentReconciliationJob } from './jobs/scheduler';

const PORT = process.env.PORT || 3000;
const SECRET_NAME = process.env.AWS_SECRET_NAME || "rds-secretname";

const startServer = async () => {
    try {
        // STEP 1: Validate environment variables BEFORE anything else
        logger.info('🔍 Validating environment configuration...');
        validateEnvironment();
        
        // Check if DATABASE_URL is already provided (e.g. from .env or SSM)
        if (process.env.DATABASE_URL) {
            logger.info('Using configured DATABASE_URL from environment.');
        } else if (process.env.USE_LOCAL_DB === 'true') {
             // Local DB fallback (already handled logically by the first check if validated, but keeping structure)
             logger.info('Using local database configuration.');
        } else {
            // Only fetch from Secrets Manager if DATABASE_URL is NOT present
            logger.info('Fetching database credentials from Secrets Manager...');
            try {
                const dbCredentials = await getDatabaseSecret(SECRET_NAME);
                if (dbCredentials) {
                    const { username, password, host, port } = dbCredentials;
                    const dbPass = encodeURIComponent(password);
                    const dbHost = host || process.env.DB_HOST;
                    const dbPort = port || process.env.DB_PORT || 5432;
                    const dbName = process.env.DB_NAME || "postgres";

                    process.env.DATABASE_URL = `postgresql://${username}:${dbPass}@${dbHost}:${dbPort}/${dbName}?schema=public`;
                    logger.info('Database credentials configured from Secrets Manager.');
                }
            } catch (err) {
                 logger.warn(`Failed to fetch secret '${SECRET_NAME}'. Ensure AWS_SECRET_NAME is set or DATABASE_URL is provided.`);
            }
        }
        
        // Start Web Server: Only if NOT disabled (enabled by default)
        if (process.env.DISABLE_WEB_SERVER !== 'true') {
            app.listen(PORT, () => {
                logger.info(`Server (v${version}) is running on port ${PORT}`);
                logger.info(`Swagger docs available at http://localhost:${PORT}/api-docs`);

                // Start background jobs
                // startScholarshipExpiryJob();
                startStalePaymentCleanupJob();
                startPaymentReconciliationJob();
            });
        } else {
            logger.info('🔕 Web Server disabled (Worker Mode active)');
        }

    } catch (error: any) {
        logger.error(`❌ Failed to start server: ${error.message}`);
        process.exit(1);
    }
};

startServer();
