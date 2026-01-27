import axios from 'axios';
import crypto from 'crypto';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { format } from 'date-fns';
import { AdmissionStatus, PaymentStatus, PaymentComponent, DiscountStatus, FeeStatus, PaymentMethod, PaymentMode, HostelPaymentMode } from '@prisma/client';
import { getApplicationFeeAmount } from './fee.service';
import { generateInvoicePDF } from '../../utils/invoiceGenerator';
import { uploadFileToS3, getPresignedUrl, convertToPresignedUrl } from '../../utils/s3Utils';
import { ScholarshipService } from '../admin/scholarship.service';
import { generateAllotmentOrderPDF } from '../../utils/allotmentGenerator';
import { StudentDocumentStatus } from '@prisma/client';
import { sendPaymentReceipt } from '../../utils/emailService';


import { StandardCheckoutClient, Env, StandardCheckoutPayRequest } from 'pg-sdk-node';

const MERCHANT_ID_ADMISSION = (process.env.PHONEPE_MERCHANT_ID || '').trim();
const SALT_KEY_ADMISSION = (process.env.PHONEPE_SALT_KEY || '').trim();
const SALT_INDEX_ADMISSION = (process.env.PHONEPE_SALT_INDEX || '1').trim();

const MERCHANT_ID_HOSTEL = (process.env.HOSTEL_PHONEPE_MERCHANT_ID || process.env.PHONEPE_MERCHANT_ID || '').trim();
const SALT_KEY_HOSTEL = (process.env.HOSTEL_PHONEPE_SALT_KEY || process.env.PHONEPE_SALT_KEY || '').trim();
const SALT_INDEX_HOSTEL = (process.env.HOSTEL_PHONEPE_SALT_INDEX || process.env.PHONEPE_SALT_INDEX || '1').trim();

const CLIENT_VERSION = 1;
const ENV = process.env.NODE_ENV === 'production' ? Env.PRODUCTION : Env.SANDBOX;

const PHONEPE_CREDENTIALS = {
    ADMISSION: {
        MERCHANT_ID: MERCHANT_ID_ADMISSION,
        SALT_KEY: SALT_KEY_ADMISSION,
        SALT_INDEX: SALT_INDEX_ADMISSION
    },
    HOSTEL: {
        MERCHANT_ID: MERCHANT_ID_HOSTEL,
        SALT_KEY: SALT_KEY_HOSTEL,
        SALT_INDEX: SALT_INDEX_HOSTEL
    }
};

const getPhonePeClient = (type: 'ADMISSION' | 'HOSTEL' = 'ADMISSION') => {
    const creds = PHONEPE_CREDENTIALS[type];
    return StandardCheckoutClient.getInstance(creds.MERCHANT_ID, creds.SALT_KEY, CLIENT_VERSION, ENV);
};

// Debug PhonePe Config
logger.info(`[PhonePe Config] Admission Merchant: ${MERCHANT_ID_ADMISSION}, Hostel Merchant: ${MERCHANT_ID_HOSTEL}`);

// Debug PhonePe Config
// Debug PhonePe Config
// logger.info('[PhonePe Config] Initialized');

// ... (imports remain)

// Reusable PhonePe Initialization
export const initiatePhonePePayment = async (studentId: string, amount: number, transactionId: string, redirectUrl: string, feeType: 'ADMISSION' | 'HOSTEL' = 'ADMISSION') => {
    try {
        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError('Student not found for payment', 404);

        const client = getPhonePeClient(feeType);

        const request = StandardCheckoutPayRequest.builder()
            .merchantOrderId(transactionId)
            .amount(amount * 100)
            .redirectUrl(redirectUrl)
            .build();

        const response = await client.pay(request);
        return { redirectUrl: response.redirectUrl };
    } catch (error: any) {
        logger.error(`PhonePe Initiation Error [${transactionId}]:`, error);
        throw new AppError('Failed to initiate payment gateway', 502);
    }
};

export const initiateApplicationFeePayment = async (studentId: string) => {
    const amount = await getApplicationFeeAmount();
    const student = await prisma.student.findUnique({
        where: { id: studentId }
    });
    
    // Step 1: Check Student Existence and Payment Status
    logger.info(`[initiateApplicationFeePayment] Step 1: Validating student ${studentId}`);

    if (!student) {
        throw new AppError('Student not found', 404);
    }
    
    // Check if already paid
    const existingPayment = await prisma.payment.findFirst({
        where: { 
            studentId, 
            component: PaymentComponent.APPLICATION_FEE,
            status: PaymentStatus.SUCCESS 
        }
    });

    if (existingPayment) {
        throw new AppError('Application fee already paid', 400);
    }

    // Step 2: Create a pending payment record
    logger.info(`[initiateApplicationFeePayment] Step 2: Creating PENDING payment record`);
    const transactionId = `TXN_${Date.now()}_${studentId.substring(0, 8)}`;
    
    const createdPayment = await prisma.payment.create({
        data: {
            studentId,
            amount,
            status: PaymentStatus.PENDING,
            component: PaymentComponent.APPLICATION_FEE,
            providerTxId: transactionId,
            method: PaymentMethod.UPI
        }
    });

    // Step 3: Initiate PhonePe Request (Reusable)
    logger.info(`[initiateApplicationFeePayment] Step 3: Initiating Payment with PhonePe`);
    const redirectUrl = `${process.env.FRONTEND_URL}/student/payment?txnId=${transactionId}`;
    
    // Explicitly use 'ADMISSION' credentials for Application Fee
    const result = await initiatePhonePePayment(studentId, amount, transactionId, redirectUrl, 'ADMISSION');
    return { redirectUrl: result.redirectUrl, paymentId: createdPayment.id };
};

export const checkPaymentStatus = async (merchantTransactionId: string) => {
    logger.info(`[checkPaymentStatus] Request for MerchantTxId=${merchantTransactionId}`);
    try {
        // We need to know which client to check status with. Iterate/Check both or use merchantId if known.
        // Actually, for getOrderStatus, we need the Merchant ID. 
        // We can try Admission first, then Hostel if not found? Or assume Admission for now?
        // Better: We stored providerTxId in Payment table.
        
        let payment = await prisma.payment.findFirst({ 
             where: { providerTxId: merchantTransactionId },
             include: { student: true }
        });

        // Heuristic to determine which Client to use
        let clientToCheck = getPhonePeClient('ADMISSION'); 
        
        // If we found the payment locally, we might guess the type based on component, 
        // OR we just try both.
        // If payment is HOSTEL component, use HOSTEL client.
        if (payment && payment.component === PaymentComponent.HOSTEL) {
             clientToCheck = getPhonePeClient('HOSTEL');
        } 
        // Special logic for College Fee needing Hostel Credentials?
        // If we are not sure, we might need a more robust way.
        
        // Let's try with the determined client
        let response;
        try {
             response = await clientToCheck.getOrderStatus(merchantTransactionId);
        } catch (e) {
             // If first try fails, maybe try the other one?
             logger.warn(`[checkPaymentStatus] Failed with first client, trying HOSTEL client...`);
             clientToCheck = getPhonePeClient('HOSTEL'); // Try fallthrough
             response = await clientToCheck.getOrderStatus(merchantTransactionId);
        }

        logger.debug(`[checkPaymentStatus] PhonePe Response: ${JSON.stringify(response)}`);
        
        // Step 1. Fetch payment to return ID and update if needed (Fetch again or use above)
        // ... (existing logic)

        if (!payment) {
            logger.warn(`[checkPaymentStatus] Payment record not found locally for ${merchantTransactionId}`);
        }

        if (response.state === 'COMPLETED' || response.state === 'PAYMENT_SUCCESS') {
             if (payment && payment.status !== PaymentStatus.SUCCESS) {
                 logger.info(`[checkPaymentStatus] Payment successful at Gateway but Pending locally. Processing success...`);
                 await processPaymentSuccess(payment, response);
             } else {
                 logger.debug(`[checkPaymentStatus] Payment already valid locally or not found.`);
             }
             return { status: 'SUCCESS', data: response, paymentId: payment?.id };
        } else if (response.state === 'FAILED') {
             if (payment && payment.status === PaymentStatus.PENDING) {
                  logger.warn(`[checkPaymentStatus] Payment failed at Gateway. Updating local status.`);
                  await prisma.payment.update({
                        where: { id: payment.id },
                        data: { status: PaymentStatus.FAILED, metadata: response as any }
                    });
             }
             return { status: 'FAILED', data: response, paymentId: payment?.id };
        }
        return { status: response.state, data: response, paymentId: payment?.id };
    } catch (error) {
        logger.error("Error Checking Payment Status", error);
        return null;
    }
};

const processPaymentSuccess = async (payment: any, metadata: any) => {
    logger.info(`[processPaymentSuccess] Starting success processing for PaymentID=${payment.id} Component=${payment.component}`);
    let invoiceUrl = null;
    try {
        // Step 1: Generate Invoice Number
        logger.info(`[processPaymentSuccess] Step 1: Generating Invoice for payment ${payment.id}`);
        // Generate Invoice Number: FEE_HEADER/YEAR/APPLICATION_NUMBER/RECEIPT_NUMBER
        
        const feeHeader = 'VVIT'; 
        const year = new Date().getFullYear();
        const applicationNumber = payment.student.applicationId; 

        // Count existing successful payments for this student to generate serial number
        const paymentCount = await prisma.payment.count({
            where: {
                studentId: payment.studentId,
                status: PaymentStatus.SUCCESS
            }
        });
        
        // Next receipt number (current count + 1). Pad with leading zeros (e.g., 001)
        const receiptNumber = (paymentCount + 1).toString().padStart(3, '0');
        const invoiceNumber = `${feeHeader}/${year}/${applicationNumber}/${receiptNumber}`;

// ...
    // Extract Real Transaction ID from PhonePe Metadata if available
    // Extract Real Transaction ID from PhonePe Metadata if available
    let realTransactionId = payment.providerTxId;
    
    // Robust check for PhonePe metadata structure
    if (metadata) {
        // User requested format like OM... which is usually providerReferenceId
        if (metadata.providerReferenceId) {
            realTransactionId = metadata.providerReferenceId;
        } else if (metadata.data?.providerReferenceId) {
             realTransactionId = metadata.data.providerReferenceId;
        } 
        // Fallback to standard PhonePe transaction Ids
        else if (metadata.paymentDetails?.[0]?.transactionId) {
            realTransactionId = metadata.paymentDetails[0].transactionId;
        } else if (metadata.data?.paymentDetails?.[0]?.transactionId) { 
            realTransactionId = metadata.data.paymentDetails[0].transactionId;
        } else if (metadata.transactionId) {
            realTransactionId = metadata.transactionId;
        }
    }
    logger.debug(`[processPaymentSuccess] Real Transaction ID: ${realTransactionId}`);

    // Fetch FeeHead for accurate description if available
    let feeHeadDetails = null;
    if (payment.feeHeadId) {
        feeHeadDetails = await prisma.feeHead.findUnique({ where: { id: payment.feeHeadId } });
    }

    // Determine Payment Type & Description
    let paymentDescription = 'Payment';
    let emailPaymentType: any = 'DEFAULT';

    switch (payment.component) {
        case PaymentComponent.APPLICATION_FEE:
            paymentDescription = 'Application Fee';
            emailPaymentType = 'APPLICATION_FEE';
            break;
        case PaymentComponent.TUITION:
            paymentDescription = 'Tuition Fee'; 
            emailPaymentType = 'TUITION_FEE'; 
            break;
        case PaymentComponent.SCHOLARSHIP_TOKEN:
            paymentDescription = 'Admission Fee';
            emailPaymentType = 'ADMISSION_FEE';
            break;
        case PaymentComponent.HOSTEL:
            paymentDescription = 'Hostel Fee';
            emailPaymentType = 'DEFAULT';
            break;
        case PaymentComponent.TRANSPORT:
            paymentDescription = 'Transport Fee';
            emailPaymentType = 'DEFAULT';
            break;
        default:
            // Use Fee Head Name if available, else formatted component
            if (feeHeadDetails) {
                paymentDescription = feeHeadDetails.name + (feeHeadDetails.description ? ` - ${feeHeadDetails.description}` : '');
            } else {
                paymentDescription = payment.component ? payment.component.replace(/_/g, ' ') : 'Fee Payment';
            }
            emailPaymentType = 'DEFAULT';
    }
    logger.debug(`[processPaymentSuccess] Fee Type Determined: ${emailPaymentType} (${paymentDescription})`);

    // Generate Invoice
    const invoiceData:any = {
        invoiceNumber: invoiceNumber,
        date: new Date(),
        studentName: payment.student.name,
        studentId: payment.student.applicationId, 
        paymentMethod: payment.method || 'ONLINE',
        transactionId: realTransactionId,
        amount: payment.amount,
        description: paymentDescription,
        items: [
            {
                description: paymentDescription,
                amount: payment.amount
            }
        ],
        address: {
            line1: payment.student.address,
            line2: payment.student.address2 || '',
            city: payment.student.city,
            state: payment.student.state,
            pincode: payment.student.pincode
        }
    };

    const invoiceBuffer = await generateInvoicePDF(invoiceData);
    const s3Key = `student/${payment.student.applicationId}/invoices/${payment.providerTxId}.pdf`;
    invoiceUrl = await uploadFileToS3(invoiceBuffer, s3Key, 'application/pdf');
    logger.info(`Invoice generated and uploaded: ${invoiceUrl}`);

    // Send Email Notification
    logger.info(`[Payment] Process email check. Component=${payment.component}, Email=${payment.student.email}`);
    
    if (payment.student.email) {
        await sendPaymentReceipt(payment.student.email, {
            studentName: payment.student.name,
            invoiceNumber: invoiceNumber,
            applicationId: payment.student.applicationId,
            transactionId: realTransactionId,
            amount: payment.amount,
            date: new Date(),
            paymentType: emailPaymentType,
            customFeeType: emailPaymentType === 'DEFAULT' ? paymentDescription : undefined,
            invoiceUrl: invoiceUrl,
            address: {
                line1: payment.student.address,
                line2: payment.student.address2 || '',
                city: payment.student.city,
                state: payment.student.state,
                pincode: payment.student.pincode
            }
        });
        logger.info(`[Payment] Email notification sent for ${emailPaymentType}`);
    } else {
        logger.warn(`[Payment] No email address found for student. Skipping email.`);
    }
} catch (err) {
// ...
        logger.error(`Failed to generate/upload invoice or send email for ${payment.providerTxId}: ${err}`);
        console.error(err); 
    }

    // Update Payment Status
    logger.info(`[processPaymentSuccess] Finalizing local payment status update.`);
    await prisma.payment.update({
        where: { id: payment.id },
        data: {
            status: PaymentStatus.SUCCESS,
            metadata: metadata,
            invoiceUrl: invoiceUrl
        }
    });

    // --- CHECK FOR ADMISSION FINALIZATION HOOK ---
    // This hook ensures that seat allocation, scholarship, and status updates happen 
    // for Online payments initiated via the finalize-admission API.
    if (payment.metadata?.targetAction === 'FINALIZE_ADMISSION') {
        logger.info(`[processPaymentSuccess] Triggering Final Admission Updates for ${payment.studentId}`);
        try {
            // Dynamic import to avoid circular dependency issues
            const { AdminStudentService } = require('../admin/adminStudent.service');
            await prisma.$transaction(async (tx) => {
                 await AdminStudentService.executeAdmissionUpdates(payment.studentId, payment.metadata, payment.id, 'SYSTEM', tx);
            });
            logger.info(`[processPaymentSuccess] Final Admission Updates Completed.`);
        } catch (admissionError) {
            logger.error(`[processPaymentSuccess] Failed to execute admission updates: ${admissionError}`);
            // We do not throw here to avoid rolling back the Payment Success status, 
            // but this requires manual intervention.
        }
    }

    // Update Admission Status
    if (payment.component === PaymentComponent.APPLICATION_FEE) {
         await prisma.studentAdmission.update({
            where: { studentId: payment.studentId },
            data: {
                status: AdmissionStatus.ENTRANCE_FEE_PAID,
                feeStatus: FeeStatus.PARTIAL
            }
        });
        // Duplicate removed
        logger.info(`Student ${payment.studentId} admission status updated to ENTRANCE_FEE_PAID`);
    } else if (payment.component === PaymentComponent.TUITION) {
        // ... (rest of logic continued below) -> this ensures we don't break the rest of the file which was cut off in view

         await prisma.studentAdmission.update({
            where: { studentId: payment.studentId },
            data: {
                status: AdmissionStatus.ADMISSION_CONFIRMED,
                feeStatus: FeeStatus.PARTIAL
            }
        });
        logger.info(`Student ${payment.studentId} admission status updated to ADMISSION_CONFIRMED`);
    } else if (payment.component === PaymentComponent.SCHOLARSHIP_TOKEN) {
        await ScholarshipService.lockAllocation(payment.studentId);
        await prisma.studentAdmission.update({
            where: { studentId: payment.studentId },
            data: {
                feeStatus: FeeStatus.PARTIAL,
                status: AdmissionStatus.ADMISSION_CONFIRMED 
                // paidFee increment removed here
            }
        });
        logger.info(`Scholarship locked for student ${payment.studentId}`);

        // --- GENERATE LEDGER ENTRIES FOR FEES & DISCOUNTS ---
        // Fetch detailed student info to calculate fees
        const detailedStudent = await prisma.student.findUnique({
            where: { id: payment.studentId },
            include: { 
                admissionDetails: {
                    include: {
                        hostel: { include: { blocks: { include: { rooms: true } } } },
                        transportRoute: true
                    }
                },
                scholarshipAllocation: { include: { rule: true } }
            }
        });

        if (detailedStudent && detailedStudent.admissionDetails) {
            const ledgersToCreate = [];
            const admission = detailedStudent.admissionDetails;

            // 1. Tuition Fee (DEBIT)
            const tuitionFee = (admission.totalFee ?? 0) > 0 ? (admission.totalFee ?? 0) : 25000; // Fallback
            ledgersToCreate.push({
                studentId: payment.studentId,
                type: 'DEBIT' as any,
                amount: tuitionFee,
                description: 'Tuition Fee (Annual)',
                referenceId: payment.id,
                referenceType: 'FEE_GENERATION', // Custom Ref Type
                date: new Date()
            });

            // 2. Hostel Fee (DEBIT)
            if (admission.hostelId && admission.roomNumber) {
                const room = admission.hostel?.blocks
                    .flatMap(b => b.rooms)
                    .find(r => r.number === admission.roomNumber);
                if (room && (room.cost ?? 0) > 0) {
                    let feeAmount = room.cost ?? 0;
                    if (admission.hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                        feeAmount += 6000;
                        logger.info(`[Debit Generation] Applied Semwise extra charge (+6000) for student ${payment.studentId}`);
                    }

                    ledgersToCreate.push({
                        studentId: payment.studentId,
                        type: 'DEBIT' as any,
                        amount: feeAmount,
                        description: `Hostel Fee - ${admission.hostel?.name} (Room ${admission.roomNumber})`,
                        referenceId: payment.id,
                        referenceType: 'FEE_GENERATION',
                        date: new Date()
                    });
                }
            }

            // 3. Transport Fee (DEBIT)
            if (admission.transportRouteId && admission.transportRoute) {
                ledgersToCreate.push({
                    studentId: payment.studentId,
                    type: 'DEBIT' as any,
                    amount: admission.transportRoute.cost,
                    description: `Transport Fee - ${admission.transportRoute.name}`,
                    referenceId: payment.id,
                    referenceType: 'FEE_GENERATION',
                    date: new Date()
                });
            }

            // 4. Scholarship Discount (CREDIT)
            // Handle both Scholarship Allocation AND Manual Discount logic if needed
            if (detailedStudent.scholarshipAllocation?.status === 'LOCKED' && detailedStudent.scholarshipAllocation.rule) {
                const rule = detailedStudent.scholarshipAllocation.rule;
                // Calculate Discount Amount (Percentage of Base Tuition)
                const discountAmount = (tuitionFee * rule.discountPercentage) / 100;
                
                if (discountAmount > 0) {
                    ledgersToCreate.push({
                        studentId: payment.studentId,
                        type: 'CREDIT' as any,
                        amount: discountAmount,
                        description: `Scholarship Discount - ${rule.name} (${rule.discountPercentage}%)`,
                        referenceId: detailedStudent.scholarshipAllocation.id, // Link to allocation
                        referenceType: 'SCHOLARSHIP',
                        date: new Date()
                    });
                }
            }
            
            // Batch Insert
            if (ledgersToCreate.length > 0) {
                await prisma.studentLedger.createMany({
                    data: ledgersToCreate as any
                });
                logger.info(`Generated ${ledgersToCreate.length} fee/discount ledger entries for student ${payment.studentId}`);
            }
        }
    }

    // --- NEW: WATERFALL OR STRICT FEE SETTLEMENT LOGIC ---
    if (payment.component !== PaymentComponent.APPLICATION_FEE) {
        
        // --- 1. Increment Paid Fee Counter (Centralized) ---
        await prisma.studentAdmission.update({
             where: { studentId: payment.studentId },
             data: { paidFee: { increment: payment.amount } }
        });
        
        try {
            // STRICT SETTLEMENT: If payment linked to specific Demand
            if (payment.feeDemandId) {
                const demand = await prisma.studentFeeDemand.findUnique({
                    where: { id: payment.feeDemandId }
                });

                if (demand) {
                    const newStatus = payment.amount >= demand.amount ? 'FULL' : 'PARTIAL';
                    
                    await prisma.studentFeeDemand.update({
                        where: { id: demand.id },
                        data: { status: newStatus as any }
                    });
                     logger.info(`[Strict Settlement] Demand ${demand.id} updated to ${newStatus}`);
                }
            } 
            // WATERFALL SETTLEMENT (Fallback)
            else {
                const pendingDemands = await prisma.studentFeeDemand.findMany({
                    where: {
                        studentId: payment.studentId,
                        status: FeeStatus.PENDING
                    },
                    orderBy: { dueDate: 'asc' }, // Settle oldest dues first
                    include: { feeStructure: true }
                });

                let remainingPayment = payment.amount;

                for (const demand of pendingDemands) {
                    if (remainingPayment <= 0) break;

                    // Check if we can fully settle this demand
                    if (remainingPayment >= demand.amount) {
                        await prisma.studentFeeDemand.update({
                            where: { id: demand.id },
                            data: { status: FeeStatus.FULL }
                        });
                        remainingPayment -= demand.amount;
                        logger.info(`Fee Demand ${demand.id} marked as FULL. Remaining: ${remainingPayment}`);
                    } else {
                        // Partial payment case
                        await prisma.studentFeeDemand.update({
                            where: { id: demand.id },
                            data: { status: FeeStatus.PARTIAL }
                        });
                        logger.info(`Fee Demand ${demand.id} marked as PARTIAL. Remaining payment ${remainingPayment} < Demand ${demand.amount}`);
                        break; 
                    }
                }
            }
        } catch (err) {
            logger.error(`Error settling fee demands: ${err}`);
        }
    }

    // 4. Create Ledger Entry (Financial Record)
    try {
        await prisma.studentLedger.create({
            data: {
                studentId: payment.studentId,
                type: 'CREDIT', // Use string literal or enum if imported
                amount: payment.amount,
                description: `Payment Received via ${payment.method || 'ONLINE'} (${payment.component})`,
                referenceId: payment.id,
                referenceType: 'PAYMENT',
                feeHeadId: payment.feeHeadId || undefined, // Store Link
                date: new Date()
            } as any // Use valid input type
        });
        logger.info(`Ledger entry created for payment ${payment.providerTxId}`);
    } catch (err) {
        logger.error(`Failed to create ledger entry for ${payment.providerTxId}: ${err}`);
    }

    return { invoiceUrl };
};

export const recordOfflineApplicationFeePayment = async (studentId: string, paymentMethod: PaymentMethod, transactionId?: string, remarks?: string, adminId?: string) => {
    const amount = await getApplicationFeeAmount();
    
    // Check if already paid
    const existingPayment = await prisma.payment.findFirst({
        where: { 
            studentId, 
            component: PaymentComponent.APPLICATION_FEE,
            status: PaymentStatus.SUCCESS 
        }
    });

    if (existingPayment) {
        throw new AppError('Application fee already paid', 400);
    }

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', 404);

    // If CASH, generate a system transaction ID
    const providerTxId = transactionId || `CASH_${Date.now()}_${studentId.substring(0, 8)}`;

    const payment = await prisma.payment.create({
        data: {
            studentId,
            amount,
            status: PaymentStatus.SUCCESS, // Direct Success
            component: PaymentComponent.APPLICATION_FEE,
            providerTxId,
            method: paymentMethod,
            mode: PaymentMode.OFFLINE,
            collectedBy: adminId,
            metadata: { remarks, mode: 'OFFLINE_ENTRY' }
        }
    });

    // Reuse the success processing logic (Invoice, Admission Status, Ledger, etc.)
    await processPaymentSuccess({ ...payment, student }, { remarks, adminId });

    return payment;
};

export const handlePaymentCallback = async (base64Payload: string, xVerify: string) => {
    // 1. Decode Payload first to identify Merchant
    const decodedBuffer = Buffer.from(base64Payload, 'base64');
    const decodedString = decodedBuffer.toString('utf-8');
    const decodedPayload = JSON.parse(decodedString);
    const { merchantTransactionId, code, merchantId } = decodedPayload;

    // 2. Select Credentials
    let saltKey = PHONEPE_CREDENTIALS.ADMISSION.SALT_KEY;
    let saltIndex = PHONEPE_CREDENTIALS.ADMISSION.SALT_INDEX;

    if (merchantId === PHONEPE_CREDENTIALS.HOSTEL.MERCHANT_ID) {
        saltKey = PHONEPE_CREDENTIALS.HOSTEL.SALT_KEY;
        saltIndex = PHONEPE_CREDENTIALS.HOSTEL.SALT_INDEX;
    }

    // 3. Verify Checksum
    const stringToSign = base64Payload + saltKey;
    const sha256 = crypto.createHash('sha256').update(stringToSign).digest('hex');
    const expectedChecksum = sha256 + "###" + saltIndex;

    if (expectedChecksum !== xVerify) {
        logger.error(`Invalid checksum in payment callback. Recv: ${xVerify}, Calc: ${expectedChecksum}, Merch: ${merchantId}`);
        throw new AppError("Invalid checksum", 400);
    }

    const payment: any = await prisma.payment.findFirst({
        where: { providerTxId: merchantTransactionId },
        include: { student: true }
    });

    if (!payment) {
        logger.error(`Payment not found for transaction: ${merchantTransactionId}`);
        return;
    }

    if (code === 'PAYMENT_SUCCESS') {
        if (payment.status !== PaymentStatus.SUCCESS) {
            await processPaymentSuccess(payment, decodedPayload);
        }
    } else {
         await prisma.payment.update({
            where: { id: payment.id },
            data: {
                status: PaymentStatus.FAILED,
                metadata: decodedPayload
            }
        });
        logger.warn(`Payment failed for transaction: ${merchantTransactionId}`);
    }

    return { status: 'OK' };
};

// Functions expected by PaymentController
export const payTestFee = async (studentId: string, userId: string | null) => {
    const { redirectUrl, paymentId } = await initiateApplicationFeePayment(studentId);
    return { redirectUrl, paymentId };
};

export const payCollegeFee = async (studentId: string, data: any, userId: string | null) => {
    const { hostelSelection, transportSelection, paymentDetails } = data;
    const { amount } = paymentDetails || {};

    // 1. Get Student Admission Details
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });

    if (!student || !student.admissionDetails) {
        throw new AppError('Student admission details not found', 404);
    }

    // Allow payment only if Seat Allotted or Confirmed
    if (student.admissionDetails.status !== AdmissionStatus.SEAT_ALLOTTED && 
        student.admissionDetails.status !== AdmissionStatus.ADMISSION_CONFIRMED) {
        throw new AppError('Seat not allotted yet. Cannot pay college fee.', 400);
    }

    // 2. Determine Transaction ID
    const transactionId = `TXN_${Date.now()}_${studentId.substring(0, 8)}`;

    // 3. Calculate Dynamic Fees
    let collegeFee = (student.admissionDetails.totalFee ?? 0) > 0 ? (student.admissionDetails.totalFee ?? 0) : 25000;
    
    // Deduct already paid amount (e.g. Token Fee)
    if ((student.admissionDetails.paidFee ?? 0) > 0) {
        collegeFee = Math.max(0, collegeFee - (student.admissionDetails.paidFee ?? 0));
    }

    let hostelFee = 0;
    let transportFee = 0;
    
    // Validate & Calculate Hostel Fee
    if (hostelSelection?.hostelId) {
        const hostel = await prisma.hostel.findUnique({ 
            where: { id: hostelSelection.hostelId },
            include: { blocks: { include: { rooms: true } } }
        });
        if (!hostel) throw new AppError('Selected hostel not found', 404);
        
        // Find assigned room cost if available
        // Find assigned room cost if available
        if (student.admissionDetails.roomNumber) {
            // Flatten rooms to find the matching one (simplified lookup)
            const room = hostel.blocks.flatMap(b => b.rooms).find(r => r.number === student.admissionDetails?.roomNumber);
            if (room) {
                hostelFee = room.cost ?? 0;
            }
        } else {
            // Fallback: Calculate based on Selection (Capacity/Sharing)
            // Expecting hostelSelection to contain details if room not confirmed
            if (hostelSelection.hostelType || hostelSelection.roomType) {
                 const sharing = hostelSelection.hostelType === 'SHARING_4' ? 4 : 
                                 hostelSelection.hostelType === 'SHARING_8' ? 8 : 4; // Default to 4? Or Error?

                 // Try to fetch Price Category
                 const priceCategory = await prisma.hostelPriceCategory.findFirst({
                     where: {
                         sharing: sharing,
                         roomType: hostelSelection.roomType // AC / NON_AC
                     }
                 });

                 if (priceCategory) {
                     hostelFee = priceCategory.price;
                 } else {
                     // Fallback check against Hostel Model defaults if simplified setup exists
                     // Or just default to 0 and let admin fix? Better to warn.
                     logger.warn(`Price category not found for Sharing:${sharing} Type:${hostelSelection.roomType}`);
                 }
            }
        }

        // Add Semwise Logic
        if (hostelSelection.paymentMode === HostelPaymentMode.SEMWISE || hostelSelection.paymentMode === 'SEMWISE') {
             hostelFee += 6000;
        }
    }

    // Validate & Calculate Transport Fee
    if (transportSelection?.routeId) {
        const route = await prisma.transportRoute.findUnique({ where: { id: transportSelection.routeId } });
        if (!route) throw new AppError('Selected transport route not found', 404);
        transportFee = route.cost;
    }

    const totalAmount = collegeFee + hostelFee + transportFee;

    // Validate if client sent amount matches (Optional strict check)
    if (paymentDetails?.amount && Number(paymentDetails.amount) !== totalAmount) {
         // logger.warn(`Client amount ${paymentDetails.amount} differs from calculated ${totalAmount}. Using calculated.`);
    }

    // 4. Process Logic (Transaction for Selections)
    await prisma.$transaction(async (tx) => {
        // Update Hostel/Transport Selections
        if (hostelSelection || transportSelection) {
            const updateData: any = {};
            
            if (hostelSelection?.hostelId) {
                updateData.hostelId = hostelSelection.hostelId;
                updateData.accommodationType = 'HOSTEL';
                if (hostelSelection.paymentMode) {
                     updateData.hostelPaymentMode = hostelSelection.paymentMode === 'SEMWISE' ? HostelPaymentMode.SEMWISE : HostelPaymentMode.YEARWISE;
                }
            }

            if (transportSelection?.routeId) {
                updateData.accommodationType = 'TRANSPORT'; 
            }

            if (Object.keys(updateData).length > 0) {
                 await tx.studentAdmission.update({
                    where: { studentId },
                    data: updateData
                });
            }
        }
    });

    // 5. Create Payment Record (Pending)
    const { feeHeadId, feeDemandId } = paymentDetails || {};

    const payment = await prisma.payment.create({
        data: {
            studentId,
            amount: totalAmount,
            status: PaymentStatus.PENDING,
            component: PaymentComponent.TUITION,
            providerTxId: transactionId,
            method: paymentDetails?.paymentMode === 'PHONEPE' ? PaymentMethod.UPI : PaymentMethod.CASH,
            feeHeadId: feeHeadId || undefined,
            feeDemandId: feeDemandId || undefined
        } as any
    });

    // PhonePe Integration for College Fee
    try {
        const redirectUrl = `${process.env.FRONTEND_URL}/payment/status?txnId=${transactionId}`;

        // Determine Credentials Type
        // If it's pure Hostel fee, use HOSTEL. 
        // If Tuition is involved, likely use ADMISSION/DEFAULT.
        // Logic: If College Fee (Tuition) is 0 AND Hostel Fee > 0, use HOSTEL.
        let feeType: 'ADMISSION' | 'HOSTEL' = 'ADMISSION';
        if (collegeFee === 0 && transportFee === 0 && hostelFee > 0) {
            feeType = 'HOSTEL';
        }

        const client = getPhonePeClient(feeType);

        const request = StandardCheckoutPayRequest.builder()
            .merchantOrderId(transactionId)
            .amount(totalAmount * 100)
            .redirectUrl(redirectUrl)
            .build();

        const response = await client.pay(request);
        return { redirectUrl: response.redirectUrl, totalAmount, paymentId: payment.id };
    } catch (error: any) {
        logger.error(`PhonePe Payment Initiation Error (College Fee): ${error.message}`, error);
        throw new AppError('Failed to initiate payment gateway', 502);
    }

};

export const initiateAdminOnlinePayment = async (studentId: string, amount: number, component: PaymentComponent, adminId: string, feeHeadId?: string, feeDemandId?: string) => {
    // 1. Verify Student
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', 404);

    // 2. Create Transaction ID
    const transactionId = `ADM_${Date.now()}_${studentId.substring(0, 8)}`;

    // 3. Create Pending Payment Record
    const payment = await prisma.payment.create({
        data: {
            studentId,
            amount,
            status: PaymentStatus.PENDING,
            component,
            providerTxId: transactionId,
            method: PaymentMethod.UPI,
            mode: PaymentMode.ONLINE, // Admin initiated online payment
            collectedBy: adminId, // Track who initiated it
            metadata: { initiatedBy: 'ADMIN' },
            feeHeadId,
            feeDemandId
        } as any
    });



    // 5. Initiate PhonePe Payment
    try {
        const redirectUrl = `${process.env.FRONTEND_URL}/payment/status?txnId=${transactionId}`;

        // Admin initiated - decide based on component
        let feeType: 'ADMISSION' | 'HOSTEL' = 'ADMISSION';
        if (component === PaymentComponent.HOSTEL) {
            feeType = 'HOSTEL';
        }

        const client = getPhonePeClient(feeType);

        const request = StandardCheckoutPayRequest.builder()
            .merchantOrderId(transactionId)
            .amount(amount * 100)
            .redirectUrl(redirectUrl)
            .build();

        const response = await client.pay(request);
        return { redirectUrl: response.redirectUrl, paymentId: payment.id };
    } catch (error: any) {
        logger.error(`PhonePe Payment Initiation Error (Admin): ${error.message}`, error);
        throw new AppError('Failed to initiate payment gateway', 502);
    }
};

export const requestDiscount = async (studentId: string, reason: string, amount: number, documentUrl?: string, userId?: string | null) => {
     return prisma.discountRequest.create({
            data: {
                studentId,
                reason,
                requestedAmount: Number(amount),
                documentUrl,
                status: DiscountStatus.REQUESTED,
                createdBy: userId || undefined
            }
        });
};

export const approveDiscount = async (requestId: string, approvedAmount: number, component: string, adminId: string, remarks?: string) => {
    const request = await prisma.discountRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppError('Discount Request not found', 404);
    if (request.status !== DiscountStatus.REQUESTED) throw new AppError('Request already processed', 400);

    return await prisma.$transaction(async (tx) => {
         const updated = await tx.discountRequest.update({
            where: { id: requestId },
            data: {
                status: DiscountStatus.APPROVED,
                approvedAmount,
                component,
                remarks,
                approvedBy: adminId,
                approvedAt: new Date()
            }
         });
         
         // Create Ledger Entry
         await tx.studentLedger.create({
            data: {
                studentId: request.studentId,
                type: 'CREDIT' as any,
                amount: approvedAmount,
                description: `Discount Approved - ${component} (${remarks || 'Admin Approval'})`,
                referenceId: updated.id,
                referenceType: 'DISCOUNT',
                date: new Date()
            }
         });
         
         return updated;
    });
};

export const rejectDiscount = async (requestId: string, remarks: string, adminId: string) => {
     return prisma.discountRequest.update({
         where: { id: requestId },
         data: {
             status: DiscountStatus.REJECTED,
             remarks,
             approvedBy: adminId,
             approvedAt: new Date()
         }
     });
};

export const getInvoiceUrl = async (paymentId: string) => {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
        include: { student: true }
    });

    if (!payment) {
        throw new AppError('Payment not found', 404);
    }

    if (!payment.invoiceUrl) {
        // Self-healing: If payment is success but invoice is missing, try to generate it again
        if (payment.status === PaymentStatus.SUCCESS) {
            logger.warn(`Payment ${paymentId} is SUCCESS but missing invoiceUrl. Attempting to regenerate...`);
            await processPaymentSuccess(payment, payment.metadata);
            
            // Refetch to get the updated URL
            const updatedPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
            if (updatedPayment?.invoiceUrl) {
                const key = getS3KeyFromUrl(updatedPayment.invoiceUrl);
                if (key) return getPresignedUrl(key);
            }
        }
        
        if (payment.status === PaymentStatus.PENDING) {
             throw new AppError('Payment is still PENDING. Invoice not generated.', 400);
        }
        if (payment.status === PaymentStatus.FAILED) {
             throw new AppError('Payment FAILED. Cannot generate invoice.', 400);
        }

        throw new AppError('Invoice not generated yet', 404);
    }

    // Extract Key from URL
    const key = getS3KeyFromUrl(payment.invoiceUrl);
    if (!key) {
         throw new AppError('Invalid invoice URL format', 500);
    }
    
    const presignedUrl = await getPresignedUrl(key);
    return presignedUrl;
};

// Helper to extract key from various URL formats
const getS3KeyFromUrl = (url: string): string | null => {
    const keyMatch = url.match(/(student\/.*\.pdf)/);
    if (keyMatch) return keyMatch[1];
    
    const parts = url.split('amazonaws.com/');
    if (parts.length > 1) return parts[1];

    return null;
};

export const getAllotmentOrderUrl = async (studentId: string, regenerate: boolean = false) => {
    
    // Check if document exists first
    let doc = await prisma.studentDocument.findUnique({
        where: {
            studentId_documentKey: {
                studentId,
                documentKey: 'ALLOTMENT_ORDER'
            }
        }
    });

    // Generate if missing or requested to regenerate
    if (!doc || regenerate) {
        await generateAndSaveAllotmentOrder(studentId);
        
        // Fetch fresh copy
        doc = await prisma.studentDocument.findUnique({
            where: {
                studentId_documentKey: {
                    studentId,
                    documentKey: 'ALLOTMENT_ORDER'
                }
            }
        });
    }

    if (!doc) {
        throw new AppError('Allotment Order not found', 404);
    }

    // Extract key from URL if it's full URL, or use as is if it's key. 
    // Utils logic usually returns full URL "https://bucket.s3.../key"
    // s3Utils.getPresignedUrl takes Key. 
    
    // Logic to extract key from full URL:
    let key = doc.url;
    
    // Check if it's already a clean key or a path
    if (doc.url.startsWith('student/') || doc.url.startsWith('students/')) {
        key = doc.url;
    } else {
        // Handle https://bucket.s3.region.amazonaws.com/key format
        const parts = doc.url.split('.amazonaws.com/');
        if (parts.length > 1) {
            key = decodeURIComponent(parts[1]);
        }
    }

    return getPresignedUrl(key);
};

export const initiateTokenPayment = async (studentId: string, data: any = {}) => {
    const TOKEN_AMOUNT = 10000; // Fixed Token Amount

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', 404);
    
    // 1. Update Selections (Hostel/Transport) if provided
    if (data.hostelSelection || data.transportSelection) {
        await prisma.$transaction(async (tx) => {
             const updateData: any = {};
             if (data.hostelSelection?.hostelId) {
                 updateData.hostelId = data.hostelSelection.hostelId;
                 updateData.accommodationType = 'HOSTEL';
             }
             if (data.transportSelection?.routeId) {
                 updateData.accommodationType = 'TRANSPORT'; 
                 updateData.transportRouteId = data.transportSelection.routeId;
             }
             if (Object.keys(updateData).length > 0) {
                 await tx.studentAdmission.update({
                     where: { studentId },
                     data: updateData
                 });
             }
        });
    }

    const transactionId = `TOK_${Date.now()}_${studentId.substring(0, 8)}`;

    const createdPayment = await prisma.payment.create({
        data: {
            studentId,
            amount: TOKEN_AMOUNT,
            status: PaymentStatus.PENDING,
            component: PaymentComponent.SCHOLARSHIP_TOKEN,
            providerTxId: transactionId,
            method: PaymentMethod.UPI
        }
    });



    try {
        const redirectUrl = `${process.env.FRONTEND_URL}/payment/status?txnId=${transactionId}`;
        
        // Token Payment = Admission
        const client = getPhonePeClient('ADMISSION');

        const request = StandardCheckoutPayRequest.builder()
            .merchantOrderId(transactionId)
            .amount(TOKEN_AMOUNT * 100)
            .redirectUrl(redirectUrl)
            .build();

        const response = await client.pay(request);
        return response.redirectUrl;
    } catch (error: any) {
        throw new AppError('Failed to initiate payment gateway', 502);
    }
};

// [REMOVED] Old getStudentFinancialHistory replaced by enhanced version below


export const getStudentFinancialSummary = async (studentId: string) => {
    // 1. Fetch Student Config & Admission Details
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            admissionDetails: {
                include: {
                    hostel: { include: { blocks: { include: { rooms: true } } } },
                    transportRoute: true
                }
            }
        }
    });

    if (!student || !student.admissionDetails) {
        throw new AppError('Student admission details not found', 404);
    }

    // 2. Fetch All Successful Payments
    const payments = await prisma.payment.findMany({
        where: {
            studentId,
            status: PaymentStatus.SUCCESS
        }
    });

    // 3. Initialize Summary Structure
    const summary = {
        applicationFee: { expected: 0, paid: 0, pending: 0, status: 'PENDING' },
        collegeFee: { expected: 0, paid: 0, pending: 0, breakdown: {}, status: 'PENDING' },
        totalPaid: 0
    };

    // --- APPLICATION FEE ---
    summary.applicationFee.expected = await getApplicationFeeAmount();
    summary.applicationFee.paid = payments
        .filter(p => p.component === PaymentComponent.APPLICATION_FEE)
        .reduce((sum, p) => sum + p.amount, 0);
    
    summary.applicationFee.pending = Math.max(0, summary.applicationFee.expected - summary.applicationFee.paid);
    summary.applicationFee.status = summary.applicationFee.pending === 0 ? 'PAID' : (summary.applicationFee.paid > 0 ? 'PARTIAL' : 'PENDING');

    // --- COLLEGE FEE (Tuition + Hostel + Transport) ---
    // Calculate Breakdown
    const baseTuition = (student.admissionDetails.totalFee ?? 0) > 0 ? (student.admissionDetails.totalFee ?? 0) : 25000; // Default or DB value
    let hostelFee = 0;
    let transportFee = 0;

    // Hostel Cost
    if (student.admissionDetails.hostelId && student.admissionDetails.roomNumber) {
         // Try to find the specific room cost
         const room = student.admissionDetails.hostel?.blocks
            .flatMap(b => b.rooms)
            .find(r => r.number === student.admissionDetails?.roomNumber);
         hostelFee = room ? (room.cost ?? 0) : 0;
    }

    // Transport Cost
    if (student.admissionDetails.transportRouteId) {
        transportFee = student.admissionDetails.transportRoute?.cost || 0;
    }

    summary.collegeFee.breakdown = {
        tuition: baseTuition,
        hostel: hostelFee,
        transport: transportFee
    };

    // Calculate Paid Breakdown
    const paidBreakdown = {
        tuition: 0,
        hostel: 0,
        transport: 0,
        scholarship_token: 0,
        other: 0
    };

    payments.forEach(p => {
        if (p.component === PaymentComponent.TUITION) paidBreakdown.tuition += p.amount;
        else if (p.component === PaymentComponent.HOSTEL) paidBreakdown.hostel += p.amount;
        else if (p.component === PaymentComponent.TRANSPORT) paidBreakdown.transport += p.amount;
        else if (p.component === PaymentComponent.SCHOLARSHIP_TOKEN) paidBreakdown.scholarship_token += p.amount;
        else if (p.component === PaymentComponent.OTHER) paidBreakdown.other += p.amount;
    });

    (summary.collegeFee as any).paidBreakdown = paidBreakdown;

    summary.collegeFee.expected = baseTuition + hostelFee + transportFee;

    // --- SCHOLARSHIP & DISCOUNTS ---
    // Fetch Active Scholarships
    const scholarship = await prisma.scholarshipAllocation.findUnique({
        where: { studentId },
        include: { rule: true }
    });

    let scholarshipAmount = 0;
    if (scholarship && scholarship.status === 'LOCKED' && scholarship.rule) {
        // Calculate Discount
        // Assuming percentage of TUITION Fee
        scholarshipAmount = (baseTuition * scholarship.rule.discountPercentage) / 100;
    }

    // Fetch Manual Discounts from Ledger (Type: CREDIT, RefType: DISCOUNT or Custom)
    // Or check if there is a 'DiscountRequest' APPROVED with specific amount. 
    // Since DiscountRequest schema doesn't have amount, we rely on Ledger entries created during approval.
    const discountLedgerEntries = await prisma.studentLedger.findMany({
        where: {
            studentId,
            type: 'CREDIT',
            OR: [
                { referenceType: 'DISCOUNT' },
                { description: { contains: 'Discount', mode: 'insensitive' } }
            ]
        }
    });

    const manualDiscountAmount = discountLedgerEntries.reduce((sum, entry) => sum + entry.amount, 0);

    const totalDiscount = scholarshipAmount + manualDiscountAmount;

    // Update College Fee Paid Logic to Include Discounts
    const collegeFeeComponents = [
        PaymentComponent.TUITION, 
        PaymentComponent.HOSTEL, 
        PaymentComponent.TRANSPORT, 
        PaymentComponent.SCHOLARSHIP_TOKEN, 
        PaymentComponent.OTHER
    ];
    
    summary.collegeFee.paid = payments
        .filter(p => collegeFeeComponents.includes(p.component as any))
        .reduce((sum, p) => sum + p.amount, 0);

    // Add Discount to "Paid/Waived" coverage
    // Effectively, Discount reduces the Pending Amount.
    // We can show it as "Waived" or just subtract from Expected.
    // Let's add specific field for Clarity.
    (summary.collegeFee as any).discount = totalDiscount;
    (summary.collegeFee as any).scholarship = scholarshipAmount;
    (summary.collegeFee as any).manualDiscount = manualDiscountAmount;

    // Pending = Expected - (Paid + Discount)
    summary.collegeFee.pending = Math.max(0, summary.collegeFee.expected - (summary.collegeFee.paid + totalDiscount));
    summary.collegeFee.status = summary.collegeFee.pending === 0 ? 'PAID' : (summary.collegeFee.paid > 0 ? 'PARTIAL' : 'PENDING');

    // --- TOTAL PAID ---
    summary.totalPaid = summary.collegeFee.paid;

    return summary;
};


// Helper to generate and save allotment order
// Helper to generate and save allotment order
export async function generateAndSaveAllotmentOrder(studentId: string) {
    try {
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { 
                admissionDetails: { 
                    include: { 
                        allottedCourse: true,
                        transportRoute: true
                    } 
                },
                convenorDetails: true 
            }
        });

        if (student && student.admissionDetails) {
             const reportingDate = new Date();
             reportingDate.setDate(reportingDate.getDate() + 7);
             
             // Get Presigned Profile Photo URL
             let profilePhotoUrl = undefined;
             if (student.profilePhotoUrl) {
                 profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl) || undefined;
             }
             
            const allotmentData = {
                applicationId: student.applicationId ?? '',
                studentName: student.name,
                fatherName: student.fatherName,
                motherName: student.motherName,
                gender: student.gender,
                state: 'Andhra Pradesh', 
                allottedCollege: 'VVIT UNIVERSITY (VVIT), GUNTUR',
                allottedCourse: student.admissionDetails.allottedCourse?.name || 'N/A',
                // Extra fields kept for potential future use but not currently in interface:
                allottedCategory: student.convenorDetails?.category || `${student.category}_GEN_AU`,
                reportingDate: format(reportingDate, 'dd.MM.yyyy'),
                phase: 'First Phase',
                feeReimbursement: 'NO',
                profilePhotoUrl: profilePhotoUrl
            };

            const pdfBuffer = await generateAllotmentOrderPDF(allotmentData);
            // Force unique key to avoid cache
            const timestamp = Date.now();
            const s3Key = `student/${student.phone}/documents/ProvisionalAllotmentOrder_${timestamp}.pdf`;
            const url = await uploadFileToS3(pdfBuffer, s3Key, 'application/pdf');

            await prisma.studentDocument.upsert({
                where: {
                    studentId_documentKey: {
                        studentId: studentId,
                        documentKey: 'ALLOTMENT_ORDER'
                    }
                },
                create: {
                    studentId: studentId,
                    documentKey: 'ALLOTMENT_ORDER',
                    url: url,
                    status: StudentDocumentStatus.APPROVED,
                    remarks: 'Generated after Fee Payment'
                },
                update: {
                    url: url,
                    updatedAt: new Date()
                }
            });
            
            logger.info(`Allotment order generated and saved for student ${studentId}`);
        }
    } catch (err) {
        logger.error(`Failed to generate allotment order for ${studentId}: ${err}`);
    }
};

// Step 4. Unified Payment Processor
export const processUnifiedPayment = async (data: any) => {
    const { studentId, amount, mode, method, component, feeHeadId, remarks, initiatedBy, referenceNumber } = data;

    // 1. Validate Student
    const student = await prisma.student.findUnique({ 
        where: { id: studentId },
        include: { admissionDetails: true }
    });
    if (!student) throw new AppError('Student not found', 404);

    // 2. Validate Fee Head
    if (component === PaymentComponent.OTHER && !feeHeadId) {
        throw new AppError('Fee Head ID required for Other payments', 400);
    }

    if (feeHeadId) {
        const feeHead = await prisma.feeHead.findUnique({ where: { id: feeHeadId } });
        if (!feeHead) {
            throw new AppError(`Invalid Fee Head ID: ${feeHeadId}`, 400);
        }
    }
    
    // 3. Generate Transaction ID
    const providerTxId = mode === PaymentMode.OFFLINE 
        ? (referenceNumber || `CASH_${Date.now()}_${studentId.substring(0, 8)}`)
        : `TXN_${Date.now()}_${studentId.substring(0, 8)}`;

    // 4. Create Payment Record
    const payment = await prisma.payment.create({
        data: {
            studentId,
            amount,
            mode,
            method: method || (mode === PaymentMode.ONLINE ? PaymentMethod.UPI : PaymentMethod.CASH),
            status: mode === PaymentMode.OFFLINE ? PaymentStatus.SUCCESS : PaymentStatus.PENDING,
            component,
            feeHeadId,
            providerTxId,
            collectedBy: initiatedBy,
            metadata: { remarks, source: 'UNIFIED_API' }
        }
    });

    // 5. Handle Offline Success Immediate Processing
    if (mode === PaymentMode.OFFLINE) {
        // Reuse Success Logic (Ledger, Invoice, Email)
        const successResult = await processPaymentSuccess({ ...payment, student }, { remarks, adminId: initiatedBy });
        
        let presignedInvoiceUrl = null;
        if (successResult?.invoiceUrl) {
            // Generate presigned URL for the uploaded invoice
            // The processPaymentSuccess returns the raw S3 URL, we need to extract key and presign
            const key = getS3KeyFromUrl(successResult.invoiceUrl);
            if (key) {
                 presignedInvoiceUrl = await getPresignedUrl(key);
            }
        }

        // Return Success Response
        return { 
            message: "Payment recorded successfully", 
            data: { 
                paymentId: payment.id, 
                status: 'SUCCESS',
                transactionId: providerTxId,
                invoiceUrl: presignedInvoiceUrl
            } 
        };
    } else {
        // 6. Handle Online Initiation
        try {
            // Bypass removed: Always initiate real payment

            const redirectUrl = `${process.env.FRONTEND_URL}/admin/fees/offlinepayments?paymentId=${payment.id}`;
            
            // Unified API: Determine type
            let feeType: 'ADMISSION' | 'HOSTEL' = 'ADMISSION';
            if (component === PaymentComponent.HOSTEL) {
                feeType = 'HOSTEL';
            }

            const client = getPhonePeClient(feeType);

            const request = StandardCheckoutPayRequest.builder()
                .merchantOrderId(providerTxId)
                .amount(Math.round(amount * 100))
                .redirectUrl(redirectUrl)
                .build();

            const response = await client.pay(request);
            return { 
                message: "Payment Initiated", 
                data: { 
                    paymentId: payment.id, 
                    redirectUrl: response.redirectUrl,
                    status: 'PENDING'
                } 
            };
        } catch (error: any) {
            logger.error(`Unified Payment Online Error: ${error.message}`);
            throw new AppError('Failed to initiate online payment', 502);
        }
    }
};

// Enhanced History
export const getStudentFinancialHistory = async (studentId: string) => {
    // 1. Fetch Demands (Debits from Ledger)
    const ledgers = await prisma.studentLedger.findMany({
        where: { studentId },
        orderBy: { date: 'desc' }
    });
    
    // 2. Fetch Payments (Credits) via Payments Table
    const payments = await prisma.payment.findMany({
        where: { studentId, status: PaymentStatus.SUCCESS },
        include: {
            feeDemand: {
                include: { feeStructure: { include: { feeHead: true } } }
            }
        }
    });

    // 3. Fetch Student Admission Details for Accurate Demand Calculation
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            admissionDetails: {
                include: {
                    hostel: { include: { blocks: { include: { rooms: true } } } },
                    transportRoute: true
                }
            }
        }
    });

    // 4. Fetch Student Fee Demands (For Book Bank, Skill, etc.)
    const feeDemands = await prisma.studentFeeDemand.findMany({
        where: { studentId },
        include: { 
            feeStructure: {
                include: { feeHead: true }
            }
        }
    });

    // 5. Fetch ALL Fee Heads (Restored)
    const allFeeHeads = await prisma.feeHead.findMany();

    // 6. Fetch Hostel Price Categories for Fallback Calculation
    const hostelPrices = await prisma.hostelPriceCategory.findMany();

    let totalDemanded = 0;
    let totalPaid = 0;
    
    const breakdown: any = {
        HOSTEL: { demanded: 0, paid: 0 },
        TRANSPORT: { demanded: 0, paid: 0 },
        TUITION: { demanded: 0, paid: 0 },
        BOOK_BANK: { demanded: 0, paid: 0 },
        ADMISSION: { demanded: 0, paid: 0 },
        SKILL_DEVELOPMENT: { demanded: 0, paid: 0 },
        OTHER: { demanded: 0, paid: 0 }
    };
    
    // Helper to map Fee Head Name to Category
    const getCategoryFromHeadName = (name: string): string => {
        const headName = (name || '').toUpperCase();
        if (headName.includes('HOSTEL')) return 'HOSTEL';
        if (headName.includes('TRANSPORT') || headName.includes('BUS')) return 'TRANSPORT';
        if (headName.includes('TUITION') || headName.includes('SEMESTER') || headName.includes('COLLEGE')) return 'TUITION';
        if (headName.includes('BOOK') || headName.includes('LIBRARY')) return 'BOOK_BANK';
        if (headName.includes('SKILL') || headName.includes('TRAINING')) return 'SKILL_DEVELOPMENT';
        if (headName.includes('ADMISSION') || headName.includes('ENTRANCE')) return 'ADMISSION';
        return 'OTHER';
    };

    // Fee Head ID -> Category Map (Centralized Source of Truth)
    const feeHeadCategoryMap = new Map<string, string>();
    allFeeHeads.forEach(h => {
        feeHeadCategoryMap.set(h.id, getCategoryFromHeadName(h.name));
    });

    // --- DEMAND CALCULATION (From Admission & Fee Tables) ---
    
    // 4a. Process Fee Demands First (Base Layer)
    feeDemands.forEach(demand => {
        const headId = demand.feeStructure?.feeHeadId;
        let category: string | undefined;

        if (headId) {
            category = feeHeadCategoryMap.get(headId);
        }
        
        if (!category) {
             const headName = demand.feeStructure?.feeHead?.name || '';
             category = getCategoryFromHeadName(headName);
             if (headId) feeHeadCategoryMap.set(headId, category); // Cache it
        }

        const catKey = category || 'OTHER';

        if (catKey in breakdown) {
            breakdown[catKey].demanded += demand.amount;
        } else {
             breakdown.OTHER.demanded += demand.amount;
        }
    });

    // 4b. Override/Refine with Admission Details (The "Truth" for Allocations)
    if (student && student.admissionDetails) {
        const admission = student.admissionDetails;

        // 1. Tuition Demand Override (Admission Total Fee is usually the contracted amount)
        if ((admission.totalFee ?? 0) > 0) {
            breakdown.TUITION.demanded = admission.totalFee ?? 0;
        }

        // 2. Hostel Demand Override
        if (admission.hostelId || admission.hostelType) {
             let hostelCost = 0;
             
             // Priority 1: Specific Room Cost
             if (admission.roomNumber && admission.hostel) {
                 const room = admission.hostel.blocks.flatMap(b => b.rooms).find(r => r.number === admission.roomNumber);
                 if (room) hostelCost = room.cost ?? 0;
             } 
             
             // Priority 2: Hostel Type (Fallback if no room assigned or room cost 0)
             if (hostelCost === 0 && admission.hostelType) {
                 // Parse "SHARING_4" -> 4
                 const sharingMatch = admission.hostelType.match(/SHARING_(\d+)/);
                 if (sharingMatch) {
                     const sharingCount = parseInt(sharingMatch[1]);
                     const priceCategory = hostelPrices.find(p => p.sharing === sharingCount);
                     if (priceCategory) {
                         hostelCost = priceCategory.price;
                     }
                 }
             }

             if (admission.hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                 hostelCost += 6000;
             }
             
             breakdown.HOSTEL.demanded = hostelCost;
        }

        // 3. Transport Demand Override
        if (admission.transportRouteId && admission.transportRoute) {
            breakdown.TRANSPORT.demanded = admission.transportRoute.cost;
        }
    }

    // --- PAID CALCULATION (From Payments) ---
    payments.forEach(p => {
         let key = 'OTHER';

         // Strategy 1: Link via Fee Demand
         if (p.feeDemand && p.feeDemand.feeStructure && p.feeDemand.feeStructure.feeHead) {
             key = getCategoryFromHeadName(p.feeDemand.feeStructure.feeHead.name);
         }
         // Strategy 2: Link via Fee Head ID (Direct)
         else if (p.feeHeadId && feeHeadCategoryMap.has(p.feeHeadId)) {
             key = feeHeadCategoryMap.get(p.feeHeadId) || 'OTHER';
         }
         // Strategy 3: Direct Component Fallback
         else {
             const comp = p.component || 'OTHER';
             key = comp;
             if (comp === PaymentComponent.SCHOLARSHIP_TOKEN) {
                 key = 'ADMISSION'; 
             }
         }
         
         // Ensure key exists, else OTHER
         if (!(key in breakdown)) {
             key = 'OTHER';
         }
         
         breakdown[key].paid += p.amount;
    });

    // --- LEDGER OVERRIDES / SUPPLEMENTS ---
    // We rely on FeeDemands + Admission Details now. 
    
    // Calculate Totals based on the new Breakdown
    totalDemanded = 
        breakdown.HOSTEL.demanded + 
        breakdown.TRANSPORT.demanded + 
        breakdown.TUITION.demanded + 
        breakdown.BOOK_BANK.demanded + 
        breakdown.ADMISSION.demanded +
        breakdown.SKILL_DEVELOPMENT.demanded + 
        breakdown.OTHER.demanded;

    totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);

    // Summary
    const summary = {
        totalDemanded,
        totalPaid,
        totalPending: Math.max(0, totalDemanded - totalPaid)
    };
    
    // Generate presigned URLs for payments
    const paymentsWithUrls = await Promise.all(payments.map(async (p) => {
        let presignedInvoiceUrl = null;
        if (p.invoiceUrl) {
           const key = getS3KeyFromUrl(p.invoiceUrl);
           if (key) {
               presignedInvoiceUrl = await getPresignedUrl(key);
           }
        }
        return {
            ...p,
            invoiceUrl: presignedInvoiceUrl // Override with presigned URL
        };
    }));

    return {
        summary,
        breakdown,
        ledger: ledgers,
        payments: paymentsWithUrls
    };
};
