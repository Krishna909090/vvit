import './config/env'; // Must be first
import app from './app';
import logger from './utils/logger';
import { getDatabaseSecret } from './config/awsConfig';

const PORT = process.env.PORT || 3000;
const SECRET_NAME = "rds!db-2e1ab980-8cb9-4e7c-a2fd-d1f50885c30f";

const startServer = async () => {
    try {
        // Fetch Database Credentials
        logger.info('Fetching database credentials from Secrets Manager...');
        const dbCredentials = await getDatabaseSecret(SECRET_NAME);

        if (dbCredentials) {
            const { username, password, host, port, dbname } = dbCredentials;
            const dbUser = username;
            const dbPass = encodeURIComponent(password); // Encode password to handle special chars
            const dbHost = host || "database-1.cixc0u4ee9uo.us-east-1.rds.amazonaws.com";
            const dbPort = port || 5432;
            const dbName = "postgres"; // Default DB name for RDS Postgres usually 'postgres' unless specified

            const databaseUrl = `postgresql://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}?schema=public`;

            // Set env var for Prisma
            process.env.DATABASE_URL = databaseUrl;
            logger.info('Database credentials configured successfully.');
        } else {
            logger.warn('No secret string found. Using existing DATABASE_URL if available.');
        }

        app.listen(PORT, () => {
            logger.info(`Server is running on port ${PORT}`);
            logger.info(`Swagger docs available at http://localhost:${PORT}/api-docs`);
        });

    } catch (error: any) {
        logger.error(`Failed to start server: ${error.message}`);
        process.exit(1);
    }
};

startServer();
