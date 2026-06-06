import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client } from "@aws-sdk/client-s3";
import logger from "../utils/logger";

const REGION = process.env.AWS_REGION || "ap-south-1";

const AWS_CREDENTIALS = (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) 
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    : undefined;

export const secretsManagerClient = new SecretsManagerClient({
    region: REGION,
    credentials: AWS_CREDENTIALS
});

export const s3Client = new S3Client({
    region: REGION,
    credentials: AWS_CREDENTIALS,

    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
} as any);

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
