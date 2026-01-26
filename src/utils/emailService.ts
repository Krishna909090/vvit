import axios from 'axios';
import logger from './logger';
import { getPaymentReceiptTemplate, PaymentEmailData, PaymentEmailType } from './emailTemplates';
import fs from 'fs';
import path from 'path';
import { EmailStatus } from '@prisma/client';
import { createEmailLog, updateEmailStatus, getEmailLogById } from '../modules/system/emailLog.service';
import { generateInvoicePDF, InvoiceData } from './invoiceGenerator';
import { uploadFileToS3 } from './s3Utils';

// Old Type wrapper for compatibility if needed, but we will use PaymentEmailData generally
interface EmailData extends PaymentEmailData {
    invoiceNumber:string;
    items?: { description: string; amount: number }[];
    address?: {
        line1: string;
        line2?: string;
        city: string;
        state: string;
        pincode: string;
    };
}

// Environment variables
const ZEPTO_API_URL = process.env.ZEPTO_API_URL || 'https://api.zeptomail.in/v1.1/email';
const ZEPTO_API_KEY = process.env.ZEPTO_API_KEY;
const ZEPTO_FROM_EMAIL = process.env.ZEPTO_FROM_EMAIL || '';
const ZEPTO_FROM_NAME = process.env.ZEPTO_FROM_NAME || '';

/**
 * Send email using ZeptoMail API
 */
const sendZeptoEmail = async (toEmail: string, subject: string, htmlContent: string, attachments?: any[], inlineImages?: any[]) => {
    if (!ZEPTO_API_KEY) {
        logger.error('[EMAIL SERVICE] Missing ZEPTO_API_KEY. Cannot send email.');
        // For development, we return true to not block the flow even if email fails due to missing key
        return { success: true, error: 'Missing ZEPTO_API_KEY (Simulated Success)' };
    }

    try {
        const payload = {
            from: {
                address: ZEPTO_FROM_EMAIL,
                name: ZEPTO_FROM_NAME
            },
            to: [
                {
                    email_address: {
                        address: toEmail,
                    }
                }
            ],
            subject: subject,
            htmlbody: htmlContent,
            attachments: attachments,
            inline_images: inlineImages
        };

        const response = await axios.post(ZEPTO_API_URL, payload, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': ZEPTO_API_KEY
            },
            timeout: 30000 
        });

        const messageId = response.data?.data?.[0]?.messageId;
        logger.info(`[EMAIL SERVICE] Response Status: ${response.status}`);
        
        return { success: true, messageId, data: response.data };

    } catch (error: any) {
        logger.error(`[EMAIL SERVICE] Failed to send email via ZeptoMail: ${error.message}`);
        return { success: false, error: error.message };
    }
};

/**
 * Unified Payment Receipt Email Sender
 * Handles Application Fee, Admission Fee, and generic payments.
 */
export const sendPaymentReceipt = async (
    recipientEmail: string,
    data: EmailData
): Promise<{ success: boolean; invoiceUrl?: string }> => {
    let emailLogId: string | undefined;
    
    try {
        logger.info(`----------------------------------------------------------------`);
        logger.info(`[EMAIL SERVICE] Sending Payment Receipt (${data.paymentType}) to: ${recipientEmail}`);
        
        // 1. Generate Email Content
        const htmlContent = getPaymentReceiptTemplate(data);
        
        let subject = `Payment Receipt - ${data.applicationId}`;
        if (data.paymentType === 'APPLICATION_FEE') subject = `Application Confirmed - ${data.applicationId}`;
        else if (data.paymentType === 'ADMISSION_FEE') subject = `Admission Fee Receipt - ${data.applicationId}`;
        else if (data.customFeeType) subject = `${data.customFeeType} Receipt - ${data.applicationId}`;
        
        // 2. Prepare Invoice Data
        const feeDescription = data.customFeeType || (data.paymentType === 'APPLICATION_FEE' ? 'Application Fee' : 'Payment');
        
        const invoiceData: InvoiceData = {
            invoiceNumber: data.invoiceNumber,
            date: data.date,
            studentName: data.studentName,
            studentId: data.applicationId,
            paymentMethod: 'Online',
            transactionId: data.transactionId,
            amount: data.amount,
            description: feeDescription,
            items: data.items || [
                {
                    description: feeDescription,
                    amount: data.amount
                }
            ],
            signerName: 'Registrar',
            signerTitle: 'Registrar, VVIT University',
            signedDate: new Date(),
            address: data.address || {
                line1: 'Nambur',
                city: 'Guntur',
                state: 'Andhra Pradesh',
                pincode: '522508'
            }
        };

        // 3. Generate PDF & Upload (if not already provided)
        let invoiceUrl = data.invoiceUrl;
        const pdfBuffer = await generateInvoicePDF(invoiceData);
        const base64Pdf = pdfBuffer.toString('base64');

        if (!invoiceUrl) {
            // If invoice URL wasn't pre-generated/passed, upload now
            const s3Folder = data.paymentType === 'APPLICATION_FEE' ? 'invoices/application' : 'invoices/admission';
            const s3Key = `${s3Folder}/${data.applicationId}_${data.transactionId}.pdf`;
            invoiceUrl = await uploadFileToS3(pdfBuffer, s3Key, 'application/pdf');
            logger.info(`[EMAIL SERVICE] Invoice uploaded/generated: ${invoiceUrl}`);
        }

        // 4. Create Log Entry
        const logEntry = await createEmailLog({
            recipientEmail,
            subject,
            content: htmlContent,
            templateType: data.paymentType === 'APPLICATION_FEE' ? 'ENTRANCE_FEE_RECEIPT' : 'ADMISSION_FEE_RECEIPT',
            invoiceData: invoiceData,
            metadata: {
                studentId: data.applicationId,
                transactionId: data.transactionId,
                invoiceUrl: invoiceUrl,
                amount: data.amount
            }
        });
        
        if (logEntry) emailLogId = logEntry.id;

        // 5. Prepare Images
        const assetsDir = path.join(process.cwd(), 'src/assets');
        let logoBase64 = '';
        let bannerBase64 = '';
        let studentsBase64 = '';

        try {
            if (fs.existsSync(path.join(assetsDir, 'logo.png'))) logoBase64 = fs.readFileSync(path.join(assetsDir, 'logo.png')).toString('base64');
            if (fs.existsSync(path.join(assetsDir, 'collegeBuilding.jpg'))) bannerBase64 = fs.readFileSync(path.join(assetsDir, 'collegeBuilding.jpg')).toString('base64');
            if (fs.existsSync(path.join(assetsDir, 'students.jpg'))) studentsBase64 = fs.readFileSync(path.join(assetsDir, 'students.jpg')).toString('base64');
        } catch (err) { logger.error('[EMAIL SERVICE] Failed to read image assets', err); }

        const attachments = [{ 
            name: `Invoice_${data.applicationId}.pdf`, 
            mime_type: 'application/pdf', 
            content: base64Pdf 
        }];

        const inlineImages = [];
        if (logoBase64) inlineImages.push({ name: 'logo.png', mime_type: 'image/png', content: logoBase64, cid: 'logo' });
        if (bannerBase64) inlineImages.push({ name: 'collegeBuilding.jpg', mime_type: 'image/jpeg', content: bannerBase64, cid: 'banner' });
        if (studentsBase64) inlineImages.push({ name: 'students.jpg', mime_type: 'image/jpeg', content: studentsBase64, cid: 'students' });

        // 6. Send Email
        const result = await sendZeptoEmail(recipientEmail, subject, htmlContent, attachments, inlineImages);
        
        // 7. Update Log Status
        if (emailLogId) {
            await updateEmailStatus(
                emailLogId, 
                result.success ? EmailStatus.SENT : EmailStatus.FAILED,
                result.messageId,
                result.error
            );
        }
        
        return { success: result.success, invoiceUrl };

    } catch (error: any) {
        logger.error('[EMAIL SERVICE] Send Payment Receipt Failed', error);
        
        if (emailLogId) {
            await updateEmailStatus(emailLogId, EmailStatus.FAILED, undefined, { message: error.message });
        }
        return { success: false };
    }
};

// Aliases for backward compatibility if needed, but recommended to use sendPaymentReceipt direct
export const sendEntranceFeeReceipt = async (recipientEmail: string, data: any) => {
    return sendPaymentReceipt(recipientEmail, { ...data, paymentType: 'APPLICATION_FEE' });
};

export const sendAdmissionFeeReceipt = async (recipientEmail: string, data: any) => {
    return sendPaymentReceipt(recipientEmail, { ...data, paymentType: 'ADMISSION_FEE' });
};

export const retryEmail = async (logId: string) => {
    const log = await getEmailLogById(logId);
    if (!log || log.status === EmailStatus.SENT) return { success: false, message: 'Invalid log or already sent' };

    if (log.invoiceData) {
        const invoiceData = log.invoiceData as any;
        // determine type from log template type
        let pType: PaymentEmailType = 'DEFAULT';
        if (log.templateType === 'ENTRANCE_FEE_RECEIPT') pType = 'APPLICATION_FEE';
        if (log.templateType === 'ADMISSION_FEE_RECEIPT') pType = 'ADMISSION_FEE';

        const emailData: EmailData = {
           studentName: invoiceData.studentName,
           applicationId: invoiceData.studentId,
           invoiceNumber: invoiceData.invoiceNumber,
           transactionId: invoiceData.transactionId,
           amount: invoiceData.amount,
           date: new Date(invoiceData.date),
           paymentType: pType,
           items: invoiceData.items,
           address: invoiceData.address
        };
        
        return sendPaymentReceipt(log.recipientEmail, emailData);
    }
    
    return { success: false, message: 'Unsupported template type or missing data' };
};
