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

            // items array construction
            let invoiceItems: { description: string, amount: number }[] = [];
            
            if (component === 'MULTI_COMPONENT' && metadata && metadata.components && Array.isArray(metadata.components)) {
                 invoiceItems = metadata.components.map((c: any) => {
                     let label = c.component;
                     // Map to readable names
                     if (label === PaymentComponent.TUITION) label = 'Tuition Fee';
                     else if (label === PaymentComponent.TRANSPORT) label = 'Transport Fee';
                     else if (label === PaymentComponent.HOSTEL) label = 'Hostel Fee'; 
                     else if (label === PaymentComponent.HOSTEL_ACCOMMODATION) label = 'Hostel Accommodation Fee';
                     else if (label === PaymentComponent.HOSTEL_MESS) label = 'Mess Fee';
                     else if (label === PaymentComponent.APPLICATION_FEE) label = 'Application Fee';
                     else if (label === PaymentComponent.OTHER) label = 'Other Fee';
                     
                     return {
                         description: label,
                         amount: c.amount
                     };
                 });
                 // Override main description if it's generic
                 description = 'Multiple Fee Payment';
            } else {
                 invoiceItems = [
                    {
                        description: description,
                        amount: payment.amount
                    }
                ];
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
                items: invoiceItems,
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
        // Send Email
        // Detect Template & Type
        if (payment.component === PaymentComponent.APPLICATION_FEE) {
            // Fetch detailed student data for Application Summary
            const fullStudentRef = await prisma.student.findUnique({
                where: { id: payment.studentId },
                include: {
                    academicQualifications: true,
                    pref1Course: true,
                    pref2Course: true,
                    pref3Course: true
                }
            });

            const additionalAttachments = [];
            
            if (fullStudentRef) {
                const { generateApplicationSummaryPDF } = await import('../../utils/applicationSummaryGenerator');
                const summaryData = {
                    applicationId: fullStudentRef.applicationId || '',
                    studentName: fullStudentRef.name,
                    fatherName: fullStudentRef.fatherName,
                    motherName: fullStudentRef.motherName,
                    dob: fullStudentRef.dob,
                    gender: fullStudentRef.gender,
                    phone: fullStudentRef.phone,
                    email: fullStudentRef.email || '',
                    address: `${fullStudentRef.address}, ${fullStudentRef.city}, ${fullStudentRef.state} - ${fullStudentRef.pincode}`,
                    degreeType: fullStudentRef.degreeType || '',
                    courseType: fullStudentRef.courseType || '',
                    pref1: fullStudentRef.pref1Course?.name,
                    pref2: fullStudentRef.pref2Course?.name,
                    pref3: fullStudentRef.pref3Course?.name,
                    profilePhotoUrl: fullStudentRef.profilePhotoUrl || undefined,
                    qualifications: fullStudentRef.academicQualifications.map(q => ({
                        level: q.level || '',
                        institution: (q as any).institution || '', // Cast to any if strictly checking but likely 'institution'
                        board: q.board || '',
                        yearOfPassing: q.yearOfPassing?.toString() || '',
                        percentage: q.percentage?.toString() || ''
                    }))
                };
                
                try {
                    const summaryPdfBuffer = await generateApplicationSummaryPDF(summaryData as any);
                    additionalAttachments.push({
                        name: `Application_Summary_${fullStudentRef.applicationId}.pdf`,
                        mime_type: 'application/pdf',
                        content: summaryPdfBuffer.toString('base64')
                    });
                } catch (err) {
                    logger.error('[InvoiceService] Failed to generate Application Summary PDF', err);
                }
            }

            await sendEntranceFeeReceipt(payment.student.email || '', {
                ...invoiceData,
                additionalAttachments
            });
        } else {
            // Determine specific payment type for email template
            let pType: any = 'DEFAULT';
            if (payment.component === PaymentComponent.SCHOLARSHIP_TOKEN) pType = 'ADMISSION_FEE';
            else if (payment.component === PaymentComponent.TUITION) pType = 'TUITION_FEE';
            else if (payment.component === PaymentComponent.HOSTEL || payment.component === PaymentComponent.HOSTEL_ACCOMMODATION || payment.component === PaymentComponent.HOSTEL_MESS) pType = 'HOSTEL_FEE';
            else if (payment.component === PaymentComponent.TRANSPORT) pType = 'TRANSPORT_FEE';
            else if (payment.component === PaymentComponent.BOOK_BANK) pType = 'BOOK_BANK_FEE';
            else if (payment.component === 'MULTI_COMPONENT' || payment.component === 'OTHER') {
                 // Try to be smart about 'Other' if description is clear, otherwise Default
                 if (description.includes('Hostel')) pType = 'HOSTEL_FEE';
                 else if (description.includes('Transport')) pType = 'TRANSPORT_FEE';
                 else pType = 'DEFAULT';
            }

            // Use the generic sender with the specific type
            const { sendPaymentReceipt } = await import('../../utils/emailService');
            await sendPaymentReceipt(payment.student.email || '', {
                ...invoiceData,
                paymentType: pType,
                customFeeType: pType === 'DEFAULT' ? description : undefined
            });
        }
        
        return { success: true, invoiceUrl, invoiceNumber };
    }
};
