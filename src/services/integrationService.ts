import logger from '../utils/logger';
import { AppError } from '../utils/AppError';
import axios from 'axios';

// Mock BSNL OTP API
export const sendBsnlOtp = async (phone: string, otp: string) => {
    logger.info(`[Mock BSNL] Sending OTP ${otp} to ${phone}`);

    // Simulate failure if needed, or just return true
    // Simulate failure if needed, or just return true

    return true;
};

// Mock Aadhar Verification API
export const verifyAadhar = async (aadharNumber: string) => {
    // In real implementation this would call UIDAI; here we mock and return boolean.
    logger.info(`[Mock Aadhar] Verifying ${aadharNumber}`);

    // Simulate valid if length is 12
    if (aadharNumber.length !== 12) {
        return false;
    }
    return true;
};

// Netcore Email API
export const sendNetcoreEmail = async (email: string, subject: string, content: string) => {
    logger.info(`[Netcore Email] Sending email to ${email}`);
    try {
        const response = await axios.post(
            'https://emailapi.netcorecloud.net/v5/mail/send',
            {
                from: {
                    email: 'info@mail.demo-thefreela.com', // Replace with verified sender
                    name: 'VVITU Admissions'
                },
                subject: subject,
                content: [
                    {
                        type: 'html',
                        value: content
                    }
                ],
                personalizations: [
                    {
                        to: [
                            {
                                email: email,
                                name: 'User'
                            }
                        ]
                    }
                ]
            },
            {
                headers: {
                    'api_key': process.env.NETCORE_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );
        logger.info(`[Netcore Email] Response: ${JSON.stringify(response.data)}`);
        return true;
    } catch (error: any) {
        logger.error(`[Netcore Email] Error: ${error.message}`);
        if (error.response) {
            logger.error(`[Netcore Email] Response Data: ${JSON.stringify(error.response.data)}`);
        }
        // Don't throw error to prevent blocking auth flow if email fails
        return false;
    }
};
