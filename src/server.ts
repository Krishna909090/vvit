import './config/env';
import { validateEnvironment } from './config/envValidator';
import app from './app';
import logger from './utils/logger';
import { getDatabaseSecret } from './config/awsConfig';
import { version } from '../package.json';
import { startStalePaymentCleanupJob, startPaymentReconciliationJob, startConvenorAllotHealJob } from './jobs/scheduler';

const PORT = process.env.PORT || 3000;
const SECRET_NAME = process.env.AWS_SECRET_NAME || "rds-secretname";

const startServer = async () => {
    try {

        logger.info('🔍 Validating environment configuration...');
        validateEnvironment();

        if (process.env.DATABASE_URL) {
            logger.info('Using configured DATABASE_URL from environment.');
        } else if (process.env.USE_LOCAL_DB === 'true') {

             logger.info('Using local database configuration.');
        } else {

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

        if (process.env.DISABLE_WEB_SERVER !== 'true') {
            app.listen(PORT, () => {
                logger.info(`Server (v${version}) is running on port ${PORT}`);
                logger.info(`Swagger docs available at http://localhost:${PORT}/api-docs`);

                startStalePaymentCleanupJob();
                startPaymentReconciliationJob();
                startConvenorAllotHealJob();
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
