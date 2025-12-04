import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client } from "@aws-sdk/client-s3";
import logger from "../utils/logger";

// AWS Configuration
// AWS Configuration
const REGION = process.env.AWS_REGION || "us-east-1";

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) are missing from environment variables');
}

const AWS_CREDENTIALS = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
};

export const secretsManagerClient = new SecretsManagerClient({
    region: REGION,
    credentials: AWS_CREDENTIALS
});

export const s3Client = new S3Client({
    region: REGION,
    credentials: AWS_CREDENTIALS
});

export const getDatabaseSecret = async (secretName: string) => {
    try {
        const command = new GetSecretValueCommand({ SecretId: secretName });
        const response = await secretsManagerClient.send(command);

        if (response.SecretString) {
            return JSON.parse(response.SecretString);
        }
        return null;
    } catch (error: any) {
        logger.error(`Error retrieving secret ${secretName}: ${error.message}`);
        throw error;
    }
};
