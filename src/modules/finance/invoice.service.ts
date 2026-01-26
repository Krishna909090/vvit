import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { generateInvoicePDF } from '../../utils/invoiceGenerator';
import { uploadFileToS3 } from '../../utils/s3Utils';
import { sendAdmissionFeeReceipt, sendEntranceFeeReceipt } from '../../utils/emailService';
import { PaymentStatus, PaymentComponent } from '@prisma/client';

export const InvoiceService = {
    /**
     * Generates an invoice for a successful payment, uploads it, updates the record, and sends and email.
     * Can be called idempotently (checks if invoiceUrl already exists? Maybe override if requested).
     */
    async generateInvoiceForPayment(paymentId: string, forceRegenerate = false) {
        logger.info(`[InvoiceService] Generating invoice for payment: ${paymentId}`);
        
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            include: { student: true, feeHead: true }
        }) as any;

        if (!payment) {
            throw new Error(`Payment not found: ${paymentId}`);
        }

        if (payment.status !== PaymentStatus.SUCCESS) {
             logger.warn(`[InvoiceService] Payment ${paymentId} is not SUCCESS (Status: ${payment.status}). Proceeding with caution.`);
        }

        // Logic copied/adapted from payment.service.ts to match Entrance Fee format
        // Format: VVIT/YEAR/APP_ID/RECEIPT_NO
        const feeHeader = 'VVIT'; 
        const year = new Date().getFullYear();
        const applicationNumber = payment.student.applicationId || payment.studentId.substring(0,8).toUpperCase(); 

        // Count existing successful payments for this student to generate serial number
        // We might want to use the current payment's index + 1 logic if strictly reproducing history, 
        // but strictly counting all successful ones is decent.
        const paymentCount = await prisma.payment.count({
            where: {
                studentId: payment.studentId,
                status: PaymentStatus.SUCCESS,
                // created_at <= this payment? To keep serial stable?
                // For now, simpler count is fine as requested.
            }
        });
        
        let receiptNo = 1;
        // Optimization: Checking how many payments exist BEFORE this one to get stable number
        const priorPayments = await prisma.payment.count({
            where: {
                studentId: payment.studentId,
                status: PaymentStatus.SUCCESS,
                createdAt: { lt: payment.createdAt || new Date() }
            }
        });
        receiptNo = priorPayments + 1;

        const receiptNumberStr = receiptNo.toString().padStart(3, '0');
        const invoiceNumber = `${feeHeader}/${year}/${applicationNumber}/${receiptNumberStr}`;

        // Real TX ID
        let realTransactionId = payment.providerTxId || payment.referenceNumber || payment.id;
        
        // Check Metadata for Gateway Response ID (PhonePe)
        // Similar to processPaymentSuccess logic in payment.service.ts
        const metadata: any = payment.metadata;
        if (metadata) {
            if (metadata?.paymentDetails?.[0]?.transactionId) {
                realTransactionId = metadata.paymentDetails[0].transactionId;
            } else if (metadata?.data?.paymentDetails?.[0]?.transactionId) {
                realTransactionId = metadata.data.paymentDetails[0].transactionId;
            }
        }
        // Determine Description
        let description = 'Fee Payment';
        const component = payment.component || '';
        
        // Detailed check based on component and fee head
        if (component === PaymentComponent.APPLICATION_FEE) {
            description = 'Application Fee';
        } else if (component === PaymentComponent.SCHOLARSHIP_TOKEN) {
            description = 'Admission Fee';
        } else if (component === PaymentComponent.TUITION) {
            description = 'Tuition Fee';
        } else if (component === PaymentComponent.HOSTEL) {
            description = 'Hostel Fee';
        } else if (component === PaymentComponent.TRANSPORT) {
            description = 'Transport Fee';
        } else {
            // Component is OTHER or unmapped
            if (payment.feeHead) {
                description = payment.feeHead.name;
            } else {
                // Fallback checks on component name if it somehow contains keywords
                if (component.includes('HOSTEL')) {
                    description = 'Hostel Fee';
                } else if (component.includes('TRANSPORT')) {
                    description = 'Transport Fee';
                } else {
                    description = 'Other Fee';
                }
            }
        }

        // Prepare Data
        const invoiceData: any = {
            invoiceNumber: invoiceNumber,
            date: payment.createdAt || new Date(),
            studentName: payment.student.name,
            studentId: payment.student.applicationId || payment.studentId,
            paymentMethod: payment.method || 'ONLINE',
            transactionId: realTransactionId,
            amount: payment.amount,
            description: description,
            items: [
                {
                    description: description,
                    amount: payment.amount
                }
            ],
            address: {
                line1: (payment.student as any).addressLine1 || (payment.student as any).address || '',
                line2: (payment.student as any).addressLine2 || (payment.student as any).address2 || '',
                city: payment.student.city || '',
                state: payment.student.state || '',
                pincode: payment.student.pincode || ''
            }
        };

        // Generate PDF
        const invoiceBuffer = await generateInvoicePDF(invoiceData);
        
        // Upload S3
        // Key format: student/APPID/invoices/TXID.pdf to match existing pattern
        const s3Key = `student/${applicationNumber}/invoices/${realTransactionId}.pdf`;
        const invoiceUrl = await uploadFileToS3(invoiceBuffer, s3Key, 'application/pdf');
        
        logger.info(`[InvoiceService] Valid URL generated: ${invoiceUrl}`);

        // Update Payment
        await prisma.payment.update({
            where: { id: paymentId },
            data: {
                invoiceUrl: invoiceUrl,
                // If we added invoiceNumber column to DB, we would save it here.
            }
        });

        // Send Email
        // Detect Template
        if (payment.component === PaymentComponent.APPLICATION_FEE) {
            await sendEntranceFeeReceipt(payment.student.email || '', invoiceData);
        } else {
            // Admission Fee
            await sendAdmissionFeeReceipt(payment.student.email || '', invoiceData);
        }
        
        return { success: true, invoiceUrl, invoiceNumber };
    }
};
