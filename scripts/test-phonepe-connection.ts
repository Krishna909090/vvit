
import { StandardCheckoutClient, Env } from 'pg-sdk-node';
import dotenv from 'dotenv';
import path from 'path';

// Load .env.production
dotenv.config({ path: path.resolve(__dirname, '../.env.production') });

const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const SALT_KEY = process.env.PHONEPE_SALT_KEY;
const SALT_INDEX = process.env.PHONEPE_SALT_INDEX || '1';
const ENV_NAME = process.env.NODE_ENV || 'production';

console.log('--- PhonePe Connection Test ---');
console.log(`Merchant ID: ${MERCHANT_ID}`);
console.log(`Salt Index: ${SALT_INDEX}`);
console.log(`Environment: ${ENV_NAME}`);

if (!MERCHANT_ID || !SALT_KEY) {
    console.error('ERROR: Missing PHONEPE_MERCHANT_ID or PHONEPE_SALT_KEY in .env.production');
    process.exit(1);
}

const testConnection = async (env: Env, envName: string) => {
    console.log(`\nTesting connection to ${envName}...`);
    try {
        const client = StandardCheckoutClient.getInstance(MERCHANT_ID, SALT_KEY, 1, env);
        
        // Try to check status of a non-existent transaction
        // Correct credentials -> "Payment Not Found" or similar 404 for transaction
        // Incorrect credentials -> "Client Not Found" or 401/403
        
        const fakeTxnId = `TEST_${Date.now()}`;
        console.log(`Checking status for fake transaction: ${fakeTxnId}`);
        
        const response = await client.getOrderStatus(fakeTxnId);
        console.log(`[${envName}] Response:`, JSON.stringify(response, null, 2));
        
    } catch (error: any) {
        console.error(`[${envName}] Error:`, error.message);
        if (error.response) {
             console.error(`[${envName}] API Response Data:`, JSON.stringify(error.response.data, null, 2));
        }
        if (error.data) {
             console.error(`[${envName}] Error Data:`, JSON.stringify(error.data, null, 2));
        }
    }
};

(async () => {
    // 1. Test PRODUCTION
    await testConnection(Env.PRODUCTION, 'PRODUCTION');

    // 2. Test SANDBOX (just in case)
    await testConnection(Env.SANDBOX, 'SANDBOX');
})();
