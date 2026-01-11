
import dotenv from 'dotenv';
import path from 'path';

// Load .env.production BEFORE importing any modules that use Prisma
dotenv.config({ path: path.resolve(__dirname, '../.env.production') });

async function main() {
    console.log(`Testing SMS to 9398185097...`);
    
    // Dynamic import to ensure config is loaded first
    const { sendBsnlOtp } = require('../src/modules/integration/integration.service');
    
    // Using the service function directly
    const result = await sendBsnlOtp('9398185097', '123456');
    
    if (result) {
        console.log('✅ SMS Sent Successfully!');
    } else {
        console.log('❌ SMS Failed to send.');
    }
}

main().catch(console.error);
