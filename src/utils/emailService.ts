import axios from 'axios';
import logger from './logger';
import { getEntranceExamReceiptTemplate } from './emailTemplates';
import fs from 'fs';
import path from 'path';
import { EmailStatus } from '@prisma/client';
import { createEmailLog, updateEmailStatus } from '../modules/system/emailLog.service';
import { generateInvoicePDF, InvoiceData } from './invoiceGenerator';

// Types
interface EmailData {
    studentName: string;
    applicationId: string;
    invoiceNumber:string;
    programName: string;
    transactionId: string;
    amount: number;
    date: Date;
    invoiceUrl: string;
    supportEmail?: string;
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
        return { success: false, error: 'Missing ZEPTO_API_KEY' };
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
                        // name: toName // Optional
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
            timeout: 10000 // 10 seconds timeout
        });

        const messageId = response.data?.data?.[0]?.messageId;
        logger.info(`[EMAIL SERVICE] Response Status: ${response.status}`);
        
        if (messageId) {
            logger.info(`[EMAIL SERVICE] Email sent successfully to ${toEmail}. ID: ${messageId}`);
        } else {
            logger.info(`[EMAIL SERVICE] Email sent successfully to ${toEmail}. (ID Unknown) Response: ${JSON.stringify(response.data)}`);
        }
        return { success: true, messageId, data: response.data };

    } catch (error: any) {
        logger.error(`[EMAIL SERVICE] Failed to send email via ZeptoMail: ${error.message}`);
        let errorData = error.message;
        if (error.response) {
            logger.error(`[EMAIL SERVICE] Zepto Response: ${JSON.stringify(error.response.data)}`);
            errorData = error.response.data;
        }
        return { success: false, error: errorData };
    }
};


export const sendEntranceFeeReceipt = async (
    recipientEmail: string,
    data: EmailData
) => {
    let emailLogId: string | undefined;
    
    try {
        logger.info(`----------------------------------------------------------------`);
        logger.info(`[EMAIL SERVICE] Prepare to send Entrance Fee Receipt to: ${recipientEmail}`);
        logger.info(data);
        
        const htmlContent = getEntranceExamReceiptTemplate(data);
        const subject = `Payment Receipt - Entrance Exam - ${data.applicationId}`;
        
        // Generate Invoice PDF
        const invoiceData: InvoiceData = {
            invoiceNumber: data.invoiceNumber,
            date: data.date,
            studentName: data.studentName,
            studentId: data.applicationId,
            paymentMethod: 'Online',
            transactionId: data.transactionId,
            amount: data.amount,
            description: `Entrance Exam Fee`,
            signerName: 'Registrar',
            signerTitle: 'Registrar, VVIT University',
            signedDate: new Date(),
            address: {
                line1: 'Nambur',
                city: 'Guntur',
                state: 'Andhra Pradesh',
                pincode: '522508'
            }
        };
        logger.info("in", invoiceData);

        // CREATE LOG ENTRY
        const logEntry = await createEmailLog({
            recipientEmail,
            subject,
            content: htmlContent,
            templateType: 'ENTRANCE_FEE_RECEIPT',
            invoiceData: invoiceData,
            metadata: {
                studentId: data.applicationId,
                transactionId: data.transactionId
            }
        });
        
        if (logEntry) {
            emailLogId = logEntry.id;
        }

        const pdfBuffer = await generateInvoicePDF(invoiceData);
        const base64Pdf = pdfBuffer.toString('base64');

        // Read and embed images
        const assetsDir = path.join(process.cwd(), 'src/assets');
        
        let logoBase64 = '';
        let bannerBase64 = '';
        let studentsBase64 = '';

        try {
            if (fs.existsSync(path.join(assetsDir, 'logo.png'))) {
                logoBase64 = fs.readFileSync(path.join(assetsDir, 'logo.png')).toString('base64');
            }
            if (fs.existsSync(path.join(assetsDir, 'collegeBuilding.jpg'))) {
                bannerBase64 = fs.readFileSync(path.join(assetsDir, 'collegeBuilding.jpg')).toString('base64');
            }
            if (fs.existsSync(path.join(assetsDir, 'students.jpg'))) {
                studentsBase64 = fs.readFileSync(path.join(assetsDir, 'students.jpg')).toString('base64');
            }
        } catch (err) {
            logger.error('[EMAIL SERVICE] Failed to read image assets', err);
        }

        const attachments = [
            {
                name: `Invoice_${data.applicationId}.pdf`,
                mime_type: 'application/pdf',
                content: base64Pdf
            }
        ];

        const inlineImages: any[] = [];

        // Add inline images if found
        if (logoBase64) {
            inlineImages.push({
                name: 'logo.png',
                mime_type: 'image/png',
                content: logoBase64,
                cid: 'logo'
            });
        }
        if (bannerBase64) {
            inlineImages.push({
                name: 'collegeBuilding.jpg',
                mime_type: 'image/jpeg',
                content: bannerBase64,
                cid: 'banner'
            });
        }
         if (studentsBase64) {
            inlineImages.push({
                name: 'students.jpg',
                mime_type: 'image/jpeg',
                content: studentsBase64,
                cid: 'students'
            });
        }

        const result = await sendZeptoEmail(recipientEmail, subject, htmlContent, attachments, inlineImages);
        
        // UPDATE LOG STATUS
        if (emailLogId) {
            await updateEmailStatus(
                emailLogId, 
                result.success ? EmailStatus.SENT : EmailStatus.FAILED,
                result.messageId,
                result.error
            );
        }
        
        logger.info(`----------------------------------------------------------------`);
        return result.success;
    } catch (error: any) {
        logger.error('[EMAIL SERVICE] Wrapper failed', error);
        
        // UPDATE LOG STATUS TO FAILED IF IT EXISTS
        if (emailLogId) {
            await updateEmailStatus(
                emailLogId,
                EmailStatus.FAILED,
                undefined,
                { message: error.message, stack: error.stack }
            );
        }

        return false;
    }
};

import { getEmailLogById } from '../modules/system/emailLog.service';

export const retryEmail = async (logId: string) => {
    const log = await getEmailLogById(logId);
    if (!log || log.status === EmailStatus.SENT) return { success: false, message: 'Invalid log or already sent' };

    // For now, only supporting ENTRANCE_FEE_RECEIPT
    if (log.templateType === 'ENTRANCE_FEE_RECEIPT' && log.invoiceData) {
        const invoiceData = log.invoiceData as any; // Cast from Json
        
        // Map InvoiceData back to EmailData
        const emailData: EmailData = {
           studentName: invoiceData.studentName,
           applicationId: invoiceData.studentId,
           invoiceNumber: invoiceData.invoiceNumber,
           programName: (log.metadata as any)?.programName || 'Entrance Examination 2026', 
           transactionId: invoiceData.transactionId,
           amount: invoiceData.amount,
           date: new Date(invoiceData.date),
           invoiceUrl: `${process.env.INSTITUTION_WEBSITE_URL || 'https://vvit.edu.in'}/invoices/${invoiceData.studentId}`,
           supportEmail: process.env.SUPPORT_EMAIL || "admissions@vvit.edu.in"
        };
        
        const htmlContent = getEntranceExamReceiptTemplate(emailData);
        const subject = log.subject;

        // Re-generate PDF
        const pdfBuffer = await generateInvoicePDF(invoiceData);
        const base64Pdf = pdfBuffer.toString('base64');
        
        // Images
        const assetsDir = path.join(process.cwd(), 'src/assets');
        let logoBase64 = '';
        let bannerBase64 = '';
        let studentsBase64 = '';
        try {
            if (fs.existsSync(path.join(assetsDir, 'logo.png'))) logoBase64 = fs.readFileSync(path.join(assetsDir, 'logo.png')).toString('base64');
            if (fs.existsSync(path.join(assetsDir, 'collegeBuilding.jpg'))) bannerBase64 = fs.readFileSync(path.join(assetsDir, 'collegeBuilding.jpg')).toString('base64');
            if (fs.existsSync(path.join(assetsDir, 'students.jpg'))) studentsBase64 = fs.readFileSync(path.join(assetsDir, 'students.jpg')).toString('base64');
        } catch (err) { logger.error('Msg', err); }

        const attachments = [{ name: `Invoice_${invoiceData.studentId}.pdf`, mime_type: 'application/pdf', content: base64Pdf }];
        const inlineImages = [];
        if (logoBase64) inlineImages.push({ name: 'logo.png', mime_type: 'image/png', content: logoBase64, cid: 'logo' });
        if (bannerBase64) inlineImages.push({ name: 'collegeBuilding.jpg', mime_type: 'image/jpeg', content: bannerBase64, cid: 'banner' });
        if (studentsBase64) inlineImages.push({ name: 'students.jpg', mime_type: 'image/jpeg', content: studentsBase64, cid: 'students' });

        // Send
        const result = await sendZeptoEmail(log.recipientEmail, subject, htmlContent, attachments, inlineImages);
        
        // Update Log
        await updateEmailStatus(
            log.id, 
            result.success ? EmailStatus.SENT : EmailStatus.FAILED,
            result.messageId,
            result.error
        );
        
        return result;
    }
    
    return { success: false, message: 'Unsupported template type or missing data' };
};
