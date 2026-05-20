import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { generateInvoicePDF } from '../../utils/invoiceGenerator';
import { uploadFileToS3, downloadFileFromS3 } from '../../utils/s3Utils';
import { sendEntranceFeeReceipt } from '../../utils/emailService';
import { PaymentStatus, PaymentComponent } from '@prisma/client';

export const InvoiceService = {
    /**
     * Generates an invoice for a successful payment, uploads it, updates the record, and sends and email.
     * Can be called idempotently (checks if invoiceUrl already exists? Maybe override if requested).
     */
    async generateInvoiceForPayment(paymentId: string, _forceRegenerate = false) {
        logger.info(`[InvoiceService] Generating invoice for payment: ${paymentId}`);
        
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            include: { student: { include: { admissionDetails: { include: { allottedCourse: true } } } }, feeHead: true }
        }) as any;

        if (!payment) {
            throw new Error(`Payment not found: ${paymentId}`);
        }

        if (payment.status !== PaymentStatus.SUCCESS) {
             logger.warn(`[InvoiceService] Payment ${paymentId} is not SUCCESS (Status: ${payment.status}). Proceeding with caution.`);
        }

        // --- NEW: Bundle Detection Logic ---
        // Find siblings sharing the same Transaction ID or Reference Number to generate a Unified Invoice
        let allPayments = [payment];
        
        // Conditions to look for siblings:
        // 1. Has providerTxId (Online or verified Offline)
        // 2. OR Has referenceNumber (Offline) in a way that groups them
        const groupingId = payment.providerTxId || (payment.method !== 'ONLINE' ? payment.referenceNumber : null);
        
        if (groupingId) {
             const siblings = await prisma.payment.findMany({
                 where: {
                     OR: [
                         { providerTxId: groupingId },
                         { referenceNumber: groupingId }
                     ],
                     id: { not: paymentId },
                     status: PaymentStatus.SUCCESS, 
                     studentId: payment.studentId // Safety check
                 },
                 include: { feeHead: true }
             });
             if (siblings.length > 0) {
                 allPayments = [payment, ...siblings];
                 logger.info(`[InvoiceService] Detected bundle. Merging ${allPayments.length} payments for invoice.`);
             }
        }

        const primaryPayment = allPayments[0]; // Use first as primary for metadata (dates, student, etc)

        const year = new Date().getFullYear();
        const applicationNumber = primaryPayment.student.applicationId || primaryPayment.studentId.substring(0,8).toUpperCase();

        // --- RECEIPT NUMBER (global per category per year) ---
        // Categories:
        //   ADMISSION group: TUITION, ADMISSION, BOOK_BANK, APPLICATION_FEE, COURSE_CHANGE_FEE, SCHOLARSHIP_TOKEN → VVITU/YEAR/001
        //   HOSTEL group:    HOSTEL, HOSTEL_ACCOMMODATION, TRANSPORT → SET/YEAR/001
        //   MESS group:      HOSTEL_MESS → LLP/SET/YEAR/001
        const admissionComponents = [
            PaymentComponent.TUITION, PaymentComponent.ADMISSION, PaymentComponent.BOOK_BANK,
            PaymentComponent.APPLICATION_FEE, PaymentComponent.COURSE_CHANGE_FEE, PaymentComponent.SCHOLARSHIP_TOKEN,
            PaymentComponent.SKILL_DEVELOPMENT, PaymentComponent.OTHER
        ];
        const hostelComponents = [
            PaymentComponent.HOSTEL, PaymentComponent.HOSTEL_ACCOMMODATION, PaymentComponent.TRANSPORT
        ];
        const messComponents = [PaymentComponent.HOSTEL_MESS];

        const component = primaryPayment.component;
        let receiptPrefix: string;
        let receiptCategory: string;

        if (messComponents.includes(component)) {
            receiptPrefix = 'LLP/SET';
            receiptCategory = 'MESS';
        } else if (hostelComponents.includes(component)) {
            receiptPrefix = 'SET';
            receiptCategory = 'HOSTEL';
        } else {
            receiptPrefix = 'VVITU';
            receiptCategory = 'ADMISSION';
        }

        // Count prior receipts in same category for this year to get next serial
        const yearStart = new Date(year, 0, 1);
        const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

        const componentList = receiptCategory === 'MESS' ? messComponents
            : receiptCategory === 'HOSTEL' ? hostelComponents
            : admissionComponents;

        const priorReceiptsInCategory = await prisma.payment.count({
            where: {
                status: PaymentStatus.SUCCESS,
                component: { in: componentList },
                createdAt: { gte: yearStart, lte: yearEnd },
                id: { not: primaryPayment.id }
            }
        });
        const receiptSerial = (priorReceiptsInCategory + 1).toString().padStart(3, '0');
        const receiptNumber = `${receiptPrefix}/${year}/${receiptSerial}`;

        // Invoice number (per student): PREFIX/YEAR/APP_ID/SERIAL
        const priorStudentPayments = await prisma.payment.count({
            where: {
                studentId: primaryPayment.studentId,
                status: PaymentStatus.SUCCESS,
                createdAt: { lt: primaryPayment.createdAt || new Date() }
            }
        });
        const invoiceSerial = (priorStudentPayments + 1).toString().padStart(3, '0');
        const invoiceNumber = `${receiptPrefix}/${year}/${applicationNumber}/${invoiceSerial}`;

        // Real TX ID (Internal)
        const internalTxId = primaryPayment.providerTxId || primaryPayment.id;

        // UTR / Reference ID (External)
        let realTransactionId = primaryPayment.referenceNumber || 'N/A';
        
        // Check Metadata for Gateway Response ID (PhonePe)

        // Check Metadata for Gateway Response ID (PhonePe)
        const metadata: any = primaryPayment.metadata;
        if (metadata) {
            // Priority 1: Direct UTR from Rail (User Request Format)
            if (metadata?.paymentDetails?.[0]?.splitInstruments?.[0]?.rail?.utr) {
                realTransactionId = metadata.paymentDetails[0].splitInstruments[0].rail.utr;
            } else if (metadata?.data?.paymentDetails?.[0]?.splitInstruments?.[0]?.rail?.utr) {
                 realTransactionId = metadata.data.paymentDetails[0].splitInstruments[0].rail.utr;
            } else if (metadata?.paymentDetails?.[0]?.rail?.utr) {
                realTransactionId = metadata.paymentDetails[0].rail.utr;
            } else if (metadata?.data?.paymentDetails?.[0]?.rail?.utr) {
                 realTransactionId = metadata.data.paymentDetails[0].rail.utr;
            }
            // Priority 2: Provider Reference ID
            else if (metadata?.providerReferenceId) {
                realTransactionId = metadata.providerReferenceId;
            } else if (metadata?.data?.providerReferenceId) {
                realTransactionId = metadata.data.providerReferenceId;
            } 
            // Priority 3: Transaction ID from Details
            else if (metadata?.paymentDetails?.[0]?.transactionId) {
                realTransactionId = metadata.paymentDetails[0].transactionId;
            } else if (metadata?.data?.paymentDetails?.[0]?.transactionId) {
                realTransactionId = metadata.data.paymentDetails[0].transactionId;
            } else if (metadata?.transactionId) {
                realTransactionId = metadata.transactionId;
            }
        }

        // Determine Description & Items
        let description = 'Fee Payment';
        let invoiceItems: { description: string, amount: number }[] = [];
        let totalAmount = 0;

        // Helper to get description for a payment row
        const getPaymentDescription = (p: any) => {
             if (p.feeHead) return p.feeHead.name;
             
             const c = p.component;
             if (c === PaymentComponent.APPLICATION_FEE) return 'Application Fee';
             if (c === PaymentComponent.SCHOLARSHIP_TOKEN) return 'Admission Fee (Token)';
             if (c === PaymentComponent.TUITION) return 'Tuition Fee';
             if (c === PaymentComponent.HOSTEL) return 'Hostel Fee';
             if (c === PaymentComponent.HOSTEL_ACCOMMODATION) return 'Hostel Accommodation Fee';
             if (c === PaymentComponent.HOSTEL_MESS) return 'Mess Fee';
             if (c === PaymentComponent.TRANSPORT) return 'Transport Fee';
             if (c === PaymentComponent.BOOK_BANK) return 'Book Bank Fee';
             // Fallback
             return c ? c.replace(/_/g, ' ') : 'Fee Component';
        };

        if (allPayments.length > 1) {
             // Multi-Row Bundle
             description = `Consolidated Payment (${allPayments.length} items)`;
             invoiceItems = allPayments.map(p => ({
                 description: getPaymentDescription(p),
                 amount: p.amount
             }));
             totalAmount = allPayments.reduce((sum, p) => sum + p.amount, 0);
        } else {
             // Single Row Logic (Backward Compatibility)
             // Check if it's a "MULTI_COMPONENT" row with metadata items (Legacy support)
             const component = primaryPayment.component;
             description = getPaymentDescription(primaryPayment);
             
             if (component === 'MULTI_COMPONENT' && metadata && metadata.components && Array.isArray(metadata.components)) {
                 invoiceItems = metadata.components.map((c: any) => {
                     let label = c.component;
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
                 description = 'Multiple Fee Payment';
                 totalAmount = primaryPayment.amount; // Already summed in single row
            } else {
                 invoiceItems = [{
                     description: description,
                     amount: primaryPayment.amount
                 }];
                 totalAmount = primaryPayment.amount;
            }
        }

        // Resolve counter name if payment was created by non-student
        let counterName: string | undefined;
        const creatorId = primaryPayment.collectedBy || primaryPayment.createdBy;
        if (creatorId) {
            const creator = await prisma.user.findUnique({ where: { id: creatorId }, select: { name: true, role: true } });
            if (creator && creator.role !== 'STUDENT') {
                counterName = creator.name || undefined;
            }
        }

        // Prepare Data
        const courseName = primaryPayment.student.admissionDetails?.allottedCourse?.name || undefined;

        const invoiceData: any = {
            receiptNumber: receiptNumber,
            invoiceNumber: invoiceNumber,
            date: primaryPayment.createdAt || new Date(),
            studentName: primaryPayment.student.name,
            studentId: primaryPayment.student.applicationId || primaryPayment.studentId,
            applicationId: primaryPayment.student.applicationId || primaryPayment.studentId,
            courseName,
            paymentMethod: (primaryPayment.method === 'NEFT_RTGS') ? 'Bank Transfer' : (primaryPayment.method || 'ONLINE'),
            transactionId: internalTxId,
            referenceId: realTransactionId,
            amount: totalAmount,
            description: description,
            items: invoiceItems,
            academicYear: 'Academic Year 2026–2027',
            counterName,
            address: {
                line1: (primaryPayment.student as any).addressLine1 || (primaryPayment.student as any).address || '',
                line2: (primaryPayment.student as any).addressLine2 || (primaryPayment.student as any).address2 || '',
                city: primaryPayment.student.city || '',
                state: primaryPayment.student.state || '',
                pincode: primaryPayment.student.pincode || ''
            }
        };

        // Generate PDF
        const invoiceBuffer = await generateInvoicePDF(invoiceData);
        
        // Upload S3
        // Key format: student/APPID/invoices/TXID.pdf to match existing pattern
        const sanitizedTxId = realTransactionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
        const s3Key = `student/${applicationNumber}/invoices/${sanitizedTxId}.pdf`;
        const invoiceUrl = await uploadFileToS3(invoiceBuffer, s3Key, 'application/pdf');
        
        logger.info(`[InvoiceService] Valid URL generated: ${invoiceUrl}. Updating ${allPayments.length} payment records.`);

        // Update ALL involved records
        const paymentIds = allPayments.map(p => p.id);
        await prisma.payment.updateMany({
            where: { id: { in: paymentIds } },
            data: {
                invoiceUrl: invoiceUrl
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
            // Determine email template by PaymentComponent enum (strict, component-driven)
            let pType: any = 'DEFAULT';
            if (payment.component === PaymentComponent.SCHOLARSHIP_TOKEN) pType = 'ADMISSION_FEE';
            else if (payment.component === PaymentComponent.TUITION) pType = 'TUITION_FEE';
            else if (
                payment.component === PaymentComponent.HOSTEL
                || payment.component === PaymentComponent.HOSTEL_ACCOMMODATION
                || payment.component === PaymentComponent.HOSTEL_MESS
                || payment.component === PaymentComponent.HOSTEL_LAUNDRY
                || payment.component === PaymentComponent.HOSTEL_REGISTRATION
            ) pType = 'HOSTEL_FEE';
            else if (payment.component === PaymentComponent.TRANSPORT) pType = 'TRANSPORT_FEE';
            else if (payment.component === PaymentComponent.BOOK_BANK) pType = 'BOOK_BANK_FEE';
            else pType = 'DEFAULT';

            // For admission-related payments, attach Allotment Order instead of Invoice
            const admissionComponents = [PaymentComponent.SCHOLARSHIP_TOKEN, PaymentComponent.TUITION];
            const isAdmissionPayment = pType === 'ADMISSION_FEE' || pType === 'TUITION_FEE' || allPayments.some(p => admissionComponents.includes(p.component));
            const allotmentAttachments = [];

            if (isAdmissionPayment) {
                logger.info(`[InvoiceService] Admission payment detected (pType=${pType}). Looking up Allotment Order for student=${payment.studentId}`);
                try {
                    const allotmentDoc = await prisma.studentDocument.findUnique({
                        where: {
                            studentId_documentKey: {
                                studentId: payment.studentId,
                                documentKey: 'ALLOTMENT_ORDER'
                            }
                        }
                    });

                    logger.info(`[InvoiceService] Allotment Order lookup result: ${allotmentDoc ? `found (url=${allotmentDoc.url ? 'YES' : 'NULL'})` : 'NOT FOUND'}`);

                    if (allotmentDoc?.url) {
                        // Extract S3 key from the full URL
                        const s3Key = allotmentDoc.url.split('.amazonaws.com/')[1] || allotmentDoc.url;
                        const pdfBuffer = await downloadFileFromS3(decodeURIComponent(s3Key));
                        const pdfBase64 = pdfBuffer.toString('base64');

                        allotmentAttachments.push({
                            name: `AllotmentOrder_${payment.student.applicationId || payment.studentId}.pdf`,
                            mime_type: 'application/pdf',
                            content: pdfBase64
                        });
                        logger.info(`[InvoiceService] Allotment Order attached to email successfully`);
                    } else {
                        logger.warn(`[InvoiceService] Allotment Order not found or URL is null for student=${payment.studentId}. Email will be sent without attachment.`);
                    }
                } catch (err) {
                    logger.error('[InvoiceService] Failed to fetch Allotment Order PDF for email', err);
                }
            }

            const { sendPaymentReceipt } = await import('../../utils/emailService');
            await sendPaymentReceipt(payment.student.email || '', {
                ...invoiceData,
                paymentType: pType,
                customFeeType: pType === 'DEFAULT' ? description : undefined,
                ...(isAdmissionPayment ? {
                    skipInvoiceAttachment: true,
                    additionalAttachments: allotmentAttachments
                } : {})
            });
        }
        
        return { success: true, invoiceUrl, invoiceNumber, receiptNumber, realTransactionId, invoiceData, invoiceItems };
    }
};
