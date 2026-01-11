
import { sendBsnlOtp } from '../src/modules/integration/integration.service';
import dotenv from 'dotenv';
import path from 'path';

// Load .env.production
dotenv.config({ path: path.resolve(__dirname, '../.env.production') });

const PHONE = '9398185097';
const OTP = '123456';

async function main() {
    console.log(`Testing SMS to ${PHONE}...`);
    
    // Check if BSNL_TOKEN is in process.env (loaded by dotenv or AWS SSM)
    // Note: integration.service.ts uses getDatabaseSecret which fetches from Secrets Manager if not found? 
    // Actually, integration logic tries getDatabaseSecret('BsnlToken')
    
    // Using the service function directly
    const result = await sendBsnlOtp(PHONE, OTP);
    
    if (result) {
        console.log('✅ SMS Sent Successfully!');
    } else {
        console.log('❌ SMS Failed to send.');
    }
}

main().catch(console.error);
