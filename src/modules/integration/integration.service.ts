
import { getDatabaseSecret } from '../../config/awsConfig';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import axios from 'axios';

const BSNL_SECRET_NAME = 'BsnlToken';
const BSNL_API_URL = 'https://bulksms.bsnl.in:5010/api/Send_SMS';

export const sendBsnlOtp = async (phone: string, otp: string, expiry: string = "10") => {
    try {

        let token: string | undefined;
        try {
            const secretData = await getDatabaseSecret(BSNL_SECRET_NAME);
            
            if (typeof secretData === 'string') {
                token = secretData;
            } else if (secretData && typeof secretData === 'object') {
                token = secretData.token || secretData.BsnlToken;
            } else {
                 logger.warn(`Secret ${BSNL_SECRET_NAME} format not recognized.`);
            }
        } catch (secretError) {
            logger.error(`Failed to retrieve secret ${BSNL_SECRET_NAME}:`, secretError);
        }

        if (!token) {
            logger.error(`BSNL SMS Token missing. Cannot send OTP to ${phone}`);
            return false;
        }

        const configKeys = ['SMS_HEADER', 'SMS_ENTITY_ID', 'SMS_CONTENT_TEMPLATE_ID'];
        const configs = await prisma.configuration.findMany({
          where: {
            key: {
              in: configKeys
            }
          }
        });
        
        logger.info(`[SMS Config Debug] Found ${configs.length} configs for keys: ${configKeys.join(', ')}`);
        configs.forEach(c => logger.info(`[SMS Config Debug] Key: ${c.key}, Value: ${c.value}`));

        const configMap = configs.reduce((acc: Record<string, string>, curr: { key: string; value: string }) => {
          acc[curr.key] = curr.value;
          return acc;
        }, {} as Record<string, string>);

        const missingConfigs = configKeys.filter(key => !configMap[key]);
        if (missingConfigs.length > 0) {
            logger.error(`Missing SMS configurations: ${missingConfigs.join(', ')}`);
            return false;
        }

        const payload = {
          "Header": configMap['SMS_HEADER'],
          "Target": phone,
          "Is_Unicode": "0",
          "Is_Flash": "0",
          "Message_Type": "SI",
          "Entity_Id": configMap['SMS_ENTITY_ID'],
          "Content_Template_Id": configMap['SMS_CONTENT_TEMPLATE_ID'],
          "Consent_Template_Id": null,
          "Template_Keys_and_Values": [
            { "Key": "var1", "Value": otp },
            { "Key": "var2", "Value": expiry }
          ]
        };

        logger.info(`[BSNL SMS] Sending OTP to ${phone}`);
        const response = await axios.post(BSNL_API_URL, payload, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8'
          }
        });

        logger.info(`[BSNL SMS] Response: ${JSON.stringify(response.data)}`);
        return true;

    } catch (error: any) {
        logger.error(`[BSNL SMS] Error: ${error.message}`);
        if (axios.isAxiosError(error)) {
            logger.error(`[BSNL SMS] Response Data: ${JSON.stringify(error.response?.data)}`);
        }
        return false;
    }
};

export const verifyAadhar = async (aadharNumber: string) => {

    logger.info(`[Mock Aadhar] Verifying ${aadharNumber}`);

    if (aadharNumber.length !== 12) {
        return false;
    }
    return true;
};

export const sendZeptoEmail = async (email: string, subject: string, content: string) => {
    logger.info(`[ZeptoMail] Sending email to ${email}`);
    try {
        const apiKey = process.env.ZEPTO_API_KEY;
        if (!apiKey) {
            logger.error('[ZeptoMail] Missing ZEPTO_API_KEY environment variable');
            return false;
        }

        const response = await axios.post(
            'https://api.zeptomail.in/v1.1/email',
            {
                from: {
                    address: process.env.ZEPTO_FROM_EMAIL || 'noreply@mail.vvitu.com',
                    name: process.env.ZEPTO_FROM_NAME || 'VVITU Admissions'
                },
                to: [
                    {
                        email_address: {
                            address: email,
                            name: 'User'
                        }
                    }
                ],
                subject: subject,
                htmlbody: content
            },
            {
                headers: {
                    'Authorization': apiKey,
                    'Content-Type': 'application/json'
                }
            }
        );
        logger.info(`[ZeptoMail] Response: ${JSON.stringify(response.data)}`);
        return true;
    } catch (error: any) {
        logger.error(`[ZeptoMail] Error: ${error.message}`);
        if (error.response) {
            logger.error(`[ZeptoMail] Response Data: ${JSON.stringify(error.response.data)}`);
        }
        return false;
    }
};
