import axios from 'axios';
import logger from './logger';
import { getPaymentReceiptTemplate, PaymentEmailData, PaymentEmailType, HallTicketEmailData, getHallTicketTemplate, StatusUpdateEmailData, getStatusUpdateTemplate } from './emailTemplates';
import fs from 'fs';
import path from 'path';
import { EmailStatus } from '@prisma/client';
import { createEmailLog, updateEmailStatus, getEmailLogById } from '../modules/system/emailLog.service';
import { generateInvoicePDF, InvoiceData } from './invoiceGenerator';
import { uploadFileToS3 } from './s3Utils';

// ... (existing helper function and interface code)

/**
 * Send Hall Ticket Email
 */
export const sendHallTicketEmail = async (
    recipientEmail: string,
    data: HallTicketEmailData,
    pdfBuffer: Buffer
): Promise<{ success: boolean }> => {
    let emailLogId: string | undefined;

    try {
        logger.info(`[EMAIL SERVICE] Sending Hall Ticket to: ${recipientEmail}`);

        const htmlContent = getHallTicketTemplate(data);
        const subject = `Hall Ticket - ${data.applicationId} - VVITU Entrance Exam`;

        // Create Log Entry
        const logEntry = await createEmailLog({
            recipientEmail,
            subject,
            content: htmlContent,
            templateType: 'HALL_TICKET',
            metadata: {
                studentId: data.applicationId,
                examDate: data.examDate,
                center: data.examCenterName
            }
        });
        if (logEntry) emailLogId = logEntry.id;

        // Prepare Images
        const assetsDir = path.join(process.cwd(), 'src/assets');
        let logoBase64 = '';
        let bannerBase64 = '';

        try {
            if (fs.existsSync(path.join(assetsDir, 'logo.png'))) logoBase64 = fs.readFileSync(path.join(assetsDir, 'logo.png')).toString('base64');
            if (fs.existsSync(path.join(assetsDir, 'collegeBuilding.jpg'))) bannerBase64 = fs.readFileSync(path.join(assetsDir, 'collegeBuilding.jpg')).toString('base64');
        } catch (err) { logger.error('[EMAIL SERVICE] Failed to read image assets', err); }

        const base64Pdf = pdfBuffer.toString('base64');
        const attachments = [{
            name: `HallTicket_${data.applicationId}.pdf`,
            mime_type: 'application/pdf',
            content: base64Pdf
        }];

        const inlineImages = [];
        if (logoBase64) inlineImages.push({ name: 'logo.png', mime_type: 'image/png', content: logoBase64, cid: 'logo' });
        if (bannerBase64) inlineImages.push({ name: 'collegeBuilding.jpg', mime_type: 'image/jpeg', content: bannerBase64, cid: 'banner' });

        const result = await sendZeptoEmail(recipientEmail, subject, htmlContent, attachments, inlineImages);

        if (emailLogId) {
            await updateEmailStatus(
                emailLogId,
                result.success ? EmailStatus.SENT : EmailStatus.FAILED,
                result.messageId,
                result.error
            );
        }

        return { success: result.success };
    } catch (error: any) {
        logger.error('[EMAIL SERVICE] Send Hall Ticket Failed', error);

        if (emailLogId) {
            await updateEmailStatus(emailLogId, EmailStatus.FAILED, undefined, { message: error.message });
        }
        return { success: false };
    }
};


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
    additionalAttachments?: any[];
    skipInvoiceAttachment?: boolean;
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
            // signerName: 'Registrar',
            // signerTitle: 'Registrar, VVIT University',
            // signedDate: new Date(),
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

        const attachments = [
            ...(data.skipInvoiceAttachment ? [] : [{
                name: `Invoice.pdf`,
                mime_type: 'application/pdf',
                content: base64Pdf
            }]),
            ...(data.additionalAttachments || [])
        ];

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

/**
 * Send Cancellation Receipt Email
 * Uses the pre-generated PDF buffer directly — no PDF regeneration.
 */
export const sendCancellationReceipt = async (
    recipientEmail: string,
    data: {
        studentName: string;
        applicationId: string;
        conditionType: string;
        amount: number;
        date: Date;
    },
    pdfBuffer: Buffer
): Promise<{ success: boolean }> => {
    let emailLogId: string | undefined;

    try {
        const subject = `Cancellation Receipt - ${data.applicationId}`;
        const conditionLabel = data.conditionType?.replace(/_/g, ' ') ?? 'Cancellation';

        const dateObj = data.date ? new Date(data.date) : new Date();
        const formattedDate = dateObj.toLocaleString('en-IN', {
            day: '2-digit', month: 'short', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true,
            timeZone: 'Asia/Kolkata',
        });

        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Cancellation Receipt</title>
  <style>
    body { margin: 0; padding: 0; background-color: #FCFCFD; font-family: Arial, Helvetica, sans-serif; color: #6E6C78; }
    .container { max-width: 600px; margin: 0 auto; background-color: #FCFCFD; }
    .banner-table { width: 100%; border-collapse: collapse; border-radius: 12px 12px 0 0; overflow: hidden; }
    .banner-bg { background-size: cover; background-position: center center; background-repeat: no-repeat; height: 220px; }
    .logo-cell { text-align: right; vertical-align: top; padding: 20px; }
    .content { padding: 32px 40px 10px 40px; font-size: 14px; line-height: 1.75; color: #6E6C78; }
    .content p { margin: 0 0 14px 0; }
    .content strong { color: #131010; }
    .summary { margin: 10px 0 16px 18px; padding: 0; }
    .summary li { margin-bottom: 6px; padding-left: 4px; color: #6E6C78; }
    .signature { margin-top: 18px; }
    .divider { border-top: 1px solid #DEDFE3; margin: 20px 0 10px; }
    .watermark { text-align: center; font-size: 96px; font-weight: 800; color: #FFCC99; letter-spacing: 10px; margin: 8px 0 30px; line-height: 1; }
  </style>
</head>
<body>
  <div class="container">
    <table class="banner-table" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="banner-bg" background="cid:banner" style="background-image: url('cid:banner');">
          <div style="height: 220px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" height="100%">
              <tr>
                <td class="logo-cell">
                  <img src="cid:logo" alt="VVIT Logo" width="80" style="width:80px; height:auto;" />
                </td>
              </tr>
            </table>
          </div>
        </td>
      </tr>
    </table>

    <div class="content">
      <p><strong>Dear ${data.studentName},</strong></p>

      <p><strong>Seat Cancellation Processed</strong></p>

      <p>Your seat cancellation request at <strong>Vasireddy Venkatadri International Technological University</strong> has been approved and processed.</p>

      <p>Please find the cancellation receipt attached to this email for your records.</p>

      <ul class="summary">
        <li><strong>Student Name:</strong> ${data.studentName}</li>
        <li><strong>Reference ID:</strong> ${data.applicationId}</li>
        <li><strong>Cancellation Type:</strong> ${conditionLabel}</li>
        <li><strong>Date:</strong> ${formattedDate}</li>
        <li><strong>Amount:</strong> ₹${data.amount}</li>
      </ul>

      <p>If you have any questions regarding the refund or cancellation process, please contact us at <strong>admissions@vvit.edu.in</strong>.</p>

      <div class="signature">
        <p>Yours sincerely,<br><strong>Admissions Office</strong></p>
      </div>

      <div class="divider"></div>
      <div class="watermark">VVITU</div>
    </div>
  </div>
</body>
</html>`;

        // Create Log Entry
        const logEntry = await createEmailLog({
            recipientEmail,
            subject,
            content: htmlContent,
            templateType: 'CANCELLATION_RECEIPT' as any,
            metadata: {
                studentId: data.applicationId,
                conditionType: data.conditionType,
                amount: data.amount,
            },
        });
        if (logEntry) emailLogId = logEntry.id;

        // Prepare Images
        const assetsDir = path.join(process.cwd(), 'src/assets');
        let logoBase64 = '';
        let bannerBase64 = '';

        try {
            if (fs.existsSync(path.join(assetsDir, 'logo.png'))) logoBase64 = fs.readFileSync(path.join(assetsDir, 'logo.png')).toString('base64');
            if (fs.existsSync(path.join(assetsDir, 'collegeBuilding.jpg'))) bannerBase64 = fs.readFileSync(path.join(assetsDir, 'collegeBuilding.jpg')).toString('base64');
        } catch (err) { logger.error('[EMAIL SERVICE] Failed to read image assets', err); }

        const base64Pdf = pdfBuffer.toString('base64');
        const attachments = [{ name: 'CancellationReceipt.pdf', mime_type: 'application/pdf', content: base64Pdf }];

        const inlineImages = [];
        if (logoBase64) inlineImages.push({ name: 'logo.png', mime_type: 'image/png', content: logoBase64, cid: 'logo' });
        if (bannerBase64) inlineImages.push({ name: 'collegeBuilding.jpg', mime_type: 'image/jpeg', content: bannerBase64, cid: 'banner' });

        const result = await sendZeptoEmail(recipientEmail, subject, htmlContent, attachments, inlineImages);

        if (emailLogId) {
            await updateEmailStatus(
                emailLogId,
                result.success ? EmailStatus.SENT : EmailStatus.FAILED,
                result.messageId,
                result.error,
            );
        }

        return { success: result.success };
    } catch (error: any) {
        logger.error('[EMAIL SERVICE] Send Cancellation Receipt Failed', error);
        if (emailLogId) {
            await updateEmailStatus(emailLogId, EmailStatus.FAILED, undefined, { message: error.message });
        }
        return { success: false };
    }
};

/**
 * Send Scholarship Update Notification Email
 */
export const sendScholarshipUpdateEmail = async (
    recipientEmail: string,
    data: {
        studentName: string;
        applicationId: string;
        oldPercentage: number;
        newPercentage: number;
        supportEmail?: string;
    }
): Promise<{ success: boolean }> => {
    let emailLogId: string | undefined;

    try {
        const subject = `Scholarship Update - ${data.applicationId}`;
        const supportEmail = data.supportEmail || 'admissions@vvit.edu.in';

        const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Scholarship Update</title>
  <style>
    body { margin: 0; padding: 0; background-color: #FCFCFD; font-family: Arial, Helvetica, sans-serif; color: #6E6C78; }
    .container { max-width: 600px; margin: 0 auto; background-color: #FCFCFD; }
    .banner-table { width: 100%; border-collapse: collapse; border-radius: 12px 12px 0 0; overflow: hidden; }
    .banner-bg { background-size: cover; background-position: center center; background-repeat: no-repeat; height: 220px; }
    .logo-cell { text-align: right; vertical-align: top; padding: 20px; }
    .content { padding: 32px 40px 10px 40px; font-size: 14px; line-height: 1.75; color: #6E6C78; }
    .content p { margin: 0 0 14px 0; }
    .content strong { color: #131010; }
    .summary { margin: 10px 0 16px 18px; padding: 0; }
    .summary li { margin-bottom: 6px; padding-left: 4px; color: #6E6C78; }
    .signature { margin-top: 18px; }
    .divider { border-top: 1px solid #DEDFE3; margin: 20px 0 10px; }
    .watermark { text-align: center; font-size: 96px; font-weight: 800; color: #FFCC99; letter-spacing: 10px; margin: 8px 0 30px; line-height: 1; }
  </style>
</head>
<body>
  <div class="container">
    <table class="banner-table" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td class="banner-bg" background="cid:banner" style="background-image: url('cid:banner');">
          <div style="height: 220px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" height="100%">
              <tr>
                <td class="logo-cell">
                  <img src="cid:logo" alt="VVIT Logo" width="80" style="width:80px; height:auto;" />
                </td>
              </tr>
            </table>
          </div>
        </td>
      </tr>
    </table>

    <div class="content">
      <p><strong>Dear ${data.studentName},</strong></p>

      <p><strong>Scholarship Percentage Updated</strong></p>

      <p>We would like to inform you that your scholarship percentage at <strong>Vasireddy Venkatadri International Technological University</strong> has been revised.</p>

      <ul class="summary">
        <li><strong>Student Name:</strong> ${data.studentName}</li>
        <li><strong>Reference ID:</strong> ${data.applicationId}</li>
        <li><strong>Previous Scholarship:</strong> ${data.oldPercentage}%</li>
        <li><strong>Updated Scholarship:</strong> ${data.newPercentage}%</li>
      </ul>

      <p>Your fee demands have been updated to reflect this change. Please check the student portal for the revised fee details.</p>

      <p>For any queries, please contact us at <strong>${supportEmail}</strong>.</p>

      <div class="signature">
        <p>Yours sincerely,<br><strong>Admissions Office</strong></p>
      </div>

      <div class="divider"></div>
      <div class="watermark">VVITU</div>
    </div>
  </div>
</body>
</html>`;

        // Create Log Entry
        const logEntry = await createEmailLog({
            recipientEmail,
            subject,
            content: htmlContent,
            templateType: 'SCHOLARSHIP_UPDATE' as any,
            metadata: {
                studentId: data.applicationId,
                oldPercentage: data.oldPercentage,
                newPercentage: data.newPercentage,
            },
        });
        if (logEntry) emailLogId = logEntry.id;

        // Prepare Images
        const assetsDir = path.join(process.cwd(), 'src/assets');
        let logoBase64 = '';
        let bannerBase64 = '';

        try {
            if (fs.existsSync(path.join(assetsDir, 'logo.png'))) logoBase64 = fs.readFileSync(path.join(assetsDir, 'logo.png')).toString('base64');
            if (fs.existsSync(path.join(assetsDir, 'collegeBuilding.jpg'))) bannerBase64 = fs.readFileSync(path.join(assetsDir, 'collegeBuilding.jpg')).toString('base64');
        } catch (err) { logger.error('[EMAIL SERVICE] Failed to read image assets', err); }

        const inlineImages = [];
        if (logoBase64) inlineImages.push({ name: 'logo.png', mime_type: 'image/png', content: logoBase64, cid: 'logo' });
        if (bannerBase64) inlineImages.push({ name: 'collegeBuilding.jpg', mime_type: 'image/jpeg', content: bannerBase64, cid: 'banner' });

        const result = await sendZeptoEmail(recipientEmail, subject, htmlContent, [], inlineImages);

        if (emailLogId) {
            await updateEmailStatus(
                emailLogId,
                result.success ? EmailStatus.SENT : EmailStatus.FAILED,
                result.messageId,
                result.error,
            );
        }

        return { success: result.success };
    } catch (error: any) {
        logger.error('[EMAIL SERVICE] Send Scholarship Update Failed', error);
        if (emailLogId) {
            await updateEmailStatus(emailLogId, EmailStatus.FAILED, undefined, { message: error.message });
        }
        return { success: false };
    }
};

export const sendStatusUpdateEmail = async (
    recipientEmail: string,
    data: StatusUpdateEmailData
): Promise<{ success: boolean }> => {
    let emailLogId: string | undefined;

    try {
        logger.info(`[EMAIL SERVICE] Sending Status Update (${data.updateType}) to: ${recipientEmail}`);

        const htmlContent = getStatusUpdateTemplate(data);
        let subject = `Update on your Application - ${data.applicationId}`;
        
        if (data.updateType === 'QUALIFICATION_REJECTED') subject = `Action Required: Qualification Verification - ${data.applicationId}`;
        else if (data.updateType === 'DOCUMENT_REJECTED') subject = `Action Required: Document Verification - ${data.applicationId}`;
        else if (data.updateType === 'SEAT_ALLOTMENT_REJECTED') subject = `Seat Allotment Status - ${data.applicationId}`;
        else if (data.updateType === 'EXAM_FAILED') subject = `Entrance Exam Result - ${data.applicationId}`;
        else if (data.updateType === 'QUALIFICATION_PENDING') subject = `Action Required: Complete Qualification Details - ${data.applicationId}`;
        else if (data.updateType === 'DOCUMENT_PENDING') subject = `Action Required: Pending Documents - ${data.applicationId}`;
        else if (data.updateType === 'QUALIFICATION_VERIFIED') subject = `Qualification Verification Successful - ${data.applicationId}`;
        else if (data.updateType === 'DOCUMENT_VERIFIED') subject = `Documents Verification Successful - ${data.applicationId}`;
        else if (data.updateType === 'QUALIFICATION_STATUS') subject = `Update: Qualification Verification Status - ${data.applicationId}`;
        else if (data.updateType === 'DOCUMENT_STATUS') subject = `Update: Document Verification Status - ${data.applicationId}`;

        // Create Log Entry
        const logEntry = await createEmailLog({
            recipientEmail,
            subject,
            content: htmlContent,
            templateType: 'STATUS_UPDATE',
            metadata: {
                studentId: data.applicationId,
                updateType: data.updateType
            }
        });
        if (logEntry) emailLogId = logEntry.id;

        // Prepare Images
        const assetsDir = path.join(process.cwd(), 'src/assets');
        let logoBase64 = '';
        let bannerBase64 = '';

        try {
            if (fs.existsSync(path.join(assetsDir, 'logo.png'))) logoBase64 = fs.readFileSync(path.join(assetsDir, 'logo.png')).toString('base64');
            if (fs.existsSync(path.join(assetsDir, 'collegeBuilding.jpg'))) bannerBase64 = fs.readFileSync(path.join(assetsDir, 'collegeBuilding.jpg')).toString('base64');
        } catch (err) { logger.error('[EMAIL SERVICE] Failed to read image assets', err); }

        const inlineImages = [];
        if (logoBase64) inlineImages.push({ name: 'logo.png', mime_type: 'image/png', content: logoBase64, cid: 'logo' });
        if (bannerBase64) inlineImages.push({ name: 'collegeBuilding.jpg', mime_type: 'image/jpeg', content: bannerBase64, cid: 'banner' });

        const result = await sendZeptoEmail(recipientEmail, subject, htmlContent, [], inlineImages);

        if (emailLogId) {
            await updateEmailStatus(
                emailLogId,
                result.success ? EmailStatus.SENT : EmailStatus.FAILED,
                result.messageId,
                result.error
            );
        }

        return { success: result.success };
    } catch (error: any) {
        logger.error('[EMAIL SERVICE] Send Status Update Failed', error);

        if (emailLogId) {
            await updateEmailStatus(emailLogId, EmailStatus.FAILED, undefined, { message: error.message });
        }
        return { success: false };
    }
};

