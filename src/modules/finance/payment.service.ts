import axios from 'axios';
import crypto from 'crypto';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { format } from 'date-fns';
import { AdmissionStatus, PaymentStatus, PaymentComponent, DiscountStatus, FeeStatus, PaymentMethod, PaymentMode } from '@prisma/client';
import { getApplicationFeeAmount } from './fee.service';
import { generateInvoicePDF } from '../../utils/invoiceGenerator';
import { uploadFileToS3, getPresignedUrl, convertToPresignedUrl } from '../../utils/s3Utils';
import { ScholarshipService } from '../admin/scholarship.service';
import { generateAllotmentOrderPDF } from '../../utils/allotmentGenerator';
import { StudentDocumentStatus } from '@prisma/client';
import { sendEntranceFeeReceipt } from '../../utils/emailService';


import { StandardCheckoutClient, Env, StandardCheckoutPayRequest } from 'pg-sdk-node';

const MERCHANTABILITY = (process.env.PHONEPE_MERCHANT_ID || '').trim();
const SALT_KEY = (process.env.PHONEPE_SALT_KEY || '').trim();
const SALT_INDEX = (process.env.PHONEPE_SALT_INDEX || '1').trim();
const CLIENT_VERSION = 1;
const ENV = process.env.NODE_ENV === 'production' ? Env.PRODUCTION : Env.SANDBOX;
const CALLBACK_URL = (process.env.PHONEPE_CALLBACK_URL || '').trim();

// Initialize SDK Client
const client = StandardCheckoutClient.getInstance(MERCHANTABILITY, SALT_KEY, CLIENT_VERSION, ENV);

// Debug PhonePe Config
logger.info(`[PhonePe Config] MerchantId: ${MERCHANTABILITY}, SaltIndex: ${SALT_INDEX}, SaltKey(Last4): ${SALT_KEY.slice(-4)}`);

export const initiateApplicationFeePayment = async (studentId: string) => {
    const amount = await getApplicationFeeAmount();
    const student = await prisma.student.findUnique({
        where: { id: studentId }
    });

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

    // Create a pending payment record
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

    // BYPASS FOR DEV/TESTING (Only if explicit env var is set)
    if (process.env.BYPASS_PAYMENT === 'true') {
        logger.info(`[MOCK PAYMENT] Bypassing Payment Gateway for transaction ${transactionId}`);
        
        await prisma.payment.update({
             where: { id: createdPayment.id }, 
             data: { status: PaymentStatus.SUCCESS }
        });

         await prisma.studentAdmission.update({
            where: { studentId: studentId },
            data: {
                status: AdmissionStatus.ENTRANCE_FEE_PAID,
                feeStatus: FeeStatus.PARTIAL,
                paidFee: { increment: amount }
            }
        });

        return { redirectUrl: `${process.env.FRONTEND_URL}/payment/success?txnId=${transactionId}`, paymentId: createdPayment.id };
    }

    try {
        const redirectUrl = `${process.env.FRONTEND_URL}/student/payment?txnId=${transactionId}`;
        
        const request = StandardCheckoutPayRequest.builder()
            .merchantOrderId(transactionId)
            .amount(amount * 100)
            .redirectUrl(redirectUrl)
            .build();

        const response = await client.pay(request);
        return { redirectUrl: response.redirectUrl, paymentId: createdPayment.id };
    } catch (error: any) {
        logger.error(`PhonePe Payment Initiation Error: ${error.message}`, error);
        throw new AppError('Failed to initiate payment gateway', 502);
    }
};

export const checkPaymentStatus = async (merchantTransactionId: string) => {
    try {
        const response = await client.getOrderStatus(merchantTransactionId);
        
        // Fetch payment to return ID and update if needed
        const payment = await prisma.payment.findFirst({ 
             where: { providerTxId: merchantTransactionId },
             include: { student: true }
        });

        if (response.state === 'COMPLETED' || response.state === 'PAYMENT_SUCCESS') {
             if (payment && payment.status !== PaymentStatus.SUCCESS) {
                 await processPaymentSuccess(payment, response);
             }
             return { status: 'SUCCESS', data: response, paymentId: payment?.id };
        } else if (response.state === 'FAILED') {
             if (payment && payment.status === PaymentStatus.PENDING) {
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
    let invoiceUrl = null;
    try {
        // Generate Invoice Number: FEE_HEADER/YEAR/APPLICATION_NUMBER/RECEIPT_NUMBER
        // Example: VVIT/2026/VON202600001/001
        
        const feeHeader = 'VVIT'; // Or fetch dynamically if needed
        const year = new Date().getFullYear();
        const applicationNumber = payment.student.applicationId; // Assuming applicationId is the VON... number

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

        // Extract Real Transaction ID from PhonePe Metadata if available
        let realTransactionId = payment.providerTxId;
        if (metadata?.paymentDetails?.[0]?.transactionId) {
            realTransactionId = metadata.paymentDetails[0].transactionId;
        } else if (metadata?.data?.paymentDetails?.[0]?.transactionId) { // Some responses wrap it in 'data'
            realTransactionId = metadata.data.paymentDetails[0].transactionId;
        }

        // Generate Invoice
        const invoiceData:any = {
            invoiceNumber: invoiceNumber,
            date: new Date(),
            studentName: payment.student.name,
            studentId: payment.student.applicationId, // Label MUST be "Student ID" or "Application ID" as per PDF template expectation, here passing App ID as requested.
            paymentMethod: payment.method || 'ONLINE',
            transactionId: realTransactionId,
            amount: payment.amount,
            description: payment.component === 'APPLICATION_FEE' ? 'Application Fee' : 'Payment',
            items: [
                {
                    description: payment.component === 'APPLICATION_FEE' ? 'Application Fee' : 'Payment',
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
        
        if (payment.component === PaymentComponent.APPLICATION_FEE && payment.student.email) {
            logger.info('[Payment] Condition met. Sending Entrance Fee Receipt email...');
            const emailSent = await sendEntranceFeeReceipt(payment.student.email, {
                studentName: payment.student.name,
                invoiceNumber: invoiceNumber,
                applicationId: payment.student.applicationId,
                programName: 'Entrance Examination 2026',
                transactionId: realTransactionId,
                amount: payment.amount,
                date: new Date(),
                invoiceUrl: invoiceUrl,
                address: {
                    line1: payment.student.address,
                    line2: payment.student.address2 || '',
                    city: payment.student.city,
                    state: payment.student.state,
                    pincode: payment.student.pincode
                }
            });
            logger.info(`[Payment] Email send result: ${emailSent}`);
        } else {
            logger.info('[Payment] Email skipped. Condition not met.');
        }
    } catch (err) {
        logger.error(`Failed to generate/upload invoice or send email for ${payment.providerTxId}: ${err}`);
        console.error(err); // Ensure it prints to stdout too
    }

    // Update Payment Status
    await prisma.payment.update({
        where: { id: payment.id },
        data: {
            status: PaymentStatus.SUCCESS,
            metadata: metadata,
            invoiceUrl: invoiceUrl
        }
    });

    // Update Admission Status
    if (payment.component === PaymentComponent.APPLICATION_FEE) {
         await prisma.studentAdmission.update({
            where: { studentId: payment.studentId },
            data: {
                status: AdmissionStatus.ENTRANCE_FEE_PAID,
                feeStatus: FeeStatus.PARTIAL
                // REMOVED paidFee increment: Application Fee is separate from College Fee tally
                // OLD: paidFee: { increment: payment.amount }
            }
        });
        logger.info(`Student ${payment.studentId} admission status updated to ENTRANCE_FEE_PAID`);
    } else if (payment.component === PaymentComponent.TUITION) {
         await prisma.studentAdmission.update({
            where: { studentId: payment.studentId },
            data: {
                status: AdmissionStatus.ADMISSION_CONFIRMED,
                feeStatus: FeeStatus.PARTIAL,
                paidFee: { increment: payment.amount }
            }
        });


        logger.info(`Student ${payment.studentId} admission status updated to ADMISSION_CONFIRMED`);

    } else if (payment.component === PaymentComponent.SCHOLARSHIP_TOKEN) {
        await ScholarshipService.lockAllocation(payment.studentId);
        await prisma.studentAdmission.update({
            where: { studentId: payment.studentId },
            data: {
                paidFee: { increment: payment.amount },
                feeStatus: FeeStatus.PARTIAL,
                status: AdmissionStatus.ADMISSION_CONFIRMED 
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
                    ledgersToCreate.push({
                        studentId: payment.studentId,
                        type: 'DEBIT' as any,
                        amount: room.cost ?? 0,
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

    // --- NEW: WATERFALL FEE SETTLEMENT LOGIC ---
    // If payment is for College Fees (Tuition, Hostel, etc.), settle pending demands
    // Priority: Oldest Due Date first
    if (payment.component !== PaymentComponent.APPLICATION_FEE) {
        try {
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
                date: new Date()
            }
        });
        logger.info(`Ledger entry created for payment ${payment.providerTxId}`);
    } catch (err) {
        logger.error(`Failed to create ledger entry for ${payment.providerTxId}: ${err}`);
    }
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
    // Verify checksum
    const stringToSign = base64Payload + SALT_KEY;
    const sha256 = crypto.createHash('sha256').update(stringToSign).digest('hex');
    const expectedChecksum = sha256 + "###" + SALT_INDEX;

    if (expectedChecksum !== xVerify) {
        logger.error("Invalid checksum in payment callback");
        throw new AppError("Invalid checksum", 400);
    }

    const decodedPayload = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf-8'));
    const { merchantTransactionId, code } = decodedPayload;

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
        if (student.admissionDetails.roomNumber) {
            // Flatten rooms to find the matching one (simplified lookup)
            const room = hostel.blocks.flatMap(b => b.rooms).find(r => r.number === student.admissionDetails?.roomNumber);
            if (room) {
                hostelFee = room.cost ?? 0;
            }
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
    const payment = await prisma.payment.create({
        data: {
            studentId,
            amount: totalAmount,
            status: PaymentStatus.PENDING,
            component: PaymentComponent.TUITION,
            providerTxId: transactionId,
            method: paymentDetails?.paymentMode === 'PHONEPE' ? PaymentMethod.UPI : PaymentMethod.CASH
        }
    });

    // PhonePe Integration for College Fee
    // BYPASS FOR DEV/TESTING
    if (process.env.BYPASS_PAYMENT === 'true') {
         await prisma.payment.update({
             where: { id: payment.id }, 
             data: { status: PaymentStatus.SUCCESS }
        });
        await processPaymentSuccess({ ...payment, student }, {});
        return { redirectUrl: `${process.env.FRONTEND_URL}/payment/success?txnId=${transactionId}&amount=${totalAmount}`, totalAmount, paymentId: payment.id };
    }

    try {
        const redirectUrl = `${process.env.FRONTEND_URL}/payment/status?txnId=${transactionId}`;

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

export const getAllotmentOrderUrl = async (studentId: string) => {
    // Dynamically generate (or update) the allotment order on demand
    await generateAndSaveAllotmentOrder(studentId);

    const doc = await prisma.studentDocument.findUnique({
        where: {
            studentId_documentKey: {
                studentId,
                documentKey: 'ALLOTMENT_ORDER'
            }
        }
    });

    if (!doc) {
        throw new AppError('Allotment Order not found', 404);
    }

    // Extract key from URL if it's full URL, or use as is if it's key. 
    // Utils logic usually returns full URL "https://bucket.s3.../key"
    // s3Utils.getPresignedUrl takes Key. 
    
    // Logic to extract key from full URL:
    let key = doc.url;
    const parts = doc.url.split('amazonaws.com/');
    if (parts.length > 1) {
        key = parts[1];
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

    // BYPASS
    if (process.env.NODE_ENV !== 'production' || process.env.BYPASS_PAYMENT === 'true') {
        logger.info(`[MOCK TOKEN PAY] Bypassing Payment Gateway for transaction ${transactionId}`);
        await prisma.payment.update({
             where: { id: createdPayment.id }, 
             data: { status: PaymentStatus.SUCCESS }
        });

        // Trigger centralized success logic (updates Admission, Ledger, Allocations, and Waterfall settlement)
        await processPaymentSuccess({ ...createdPayment, student }, {});

        return `${process.env.FRONTEND_URL}/payment/success?txnId=${transactionId}`;
    }

    try {
        const redirectUrl = `${process.env.FRONTEND_URL}/payment/status?txnId=${transactionId}`;
        
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

export const getStudentFinancialHistory = async (studentId: string) => {
    // 1. Fetch Ledger (The Master Record)
    const ledger = await prisma.studentLedger.findMany({
        where: { studentId },
        orderBy: { date: 'desc' }
    });

    // 2. Fetch Payments to enrich ledger data
    const payments = await prisma.payment.findMany({
        where: { studentId }
    });

    // 3. Create a Map for fast lookup
    const paymentMap = new Map(payments.map(p => [p.id, p]));

    // 4. Merge Data and convert invoice URLs to presigned URLs
    const history = await Promise.all(ledger.map(async (entry) => {
        let enrichment = {};
        
        if (entry.referenceType === 'PAYMENT' && entry.referenceId) {
            const payment = paymentMap.get(entry.referenceId);
            if (payment) {
                // Convert invoice URL to presigned URL
                const invoiceUrl = await convertToPresignedUrl(payment.invoiceUrl);
                
                enrichment = {
                    category: payment.component, // e.g., APPLICATION_FEE, TUITION
                    paymentMethod: payment.method,
                    transactionId: payment.providerTxId,
                    invoiceUrl,
                    status: payment.status
                };
            }
        }

        return {
            ...entry,
            ...enrichment
        };
    }));

    return { history };
};

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
             
             // Calculate Fees
             const feeBreakdown: { name: string; amount: number }[] = [];
             let totalFee = 0;

             // Tuition (Base Fee)
             const tuition = student.admissionDetails.totalFee ?? 0;
             if (tuition > 0) {
                 feeBreakdown.push({ name: 'Tuition Fee', amount: tuition });
                 totalFee += tuition;
             }

             // Transport
             if (student.admissionDetails.transportRoute) {
                 const cost = student.admissionDetails.transportRoute.cost;
                 feeBreakdown.push({ name: 'Transport Fee', amount: cost });
                 totalFee += cost;
             }

             // Hostel (Fetch dynamic cost)
             if (student.admissionDetails.hostelId) {
                 const hostel = await prisma.hostel.findUnique({ 
                    where: { id: student.admissionDetails.hostelId },
                    include: { blocks: { include: { rooms: true } } }
                 });
                 let hostelCost = 0;
                 if (student.admissionDetails.roomNumber) {
                     const room = hostel?.blocks.flatMap(b => b.rooms).find(r => r.number === student.admissionDetails?.roomNumber);
                     hostelCost = room?.cost || 0;
                 }
                 // If no room assigned yet, we might not know cost. Or fallback to generic?
                 // For now only add if cost > 0
                 if (hostelCost > 0) {
                     feeBreakdown.push({ name: 'Hostel Fee', amount: hostelCost });
                     totalFee += hostelCost;
                 }
             }
             
             const totalPaid = student.admissionDetails.paidFee ?? 0;

            const allotmentData = {
                applicationId: student.applicationId ?? '',
                studentName: student.name,
                fatherName: student.fatherName,
                gender: student.gender,
                region: 'AU', 
                allottedCollege: 'VVIT UNIVERSITY (VVIT), GUNTUR',
                allottedCourse: student.admissionDetails.allottedCourse?.name || 'N/A',
                allottedCategory: student.convenorDetails?.category || `${student.category}_GEN_AU`,
                reportingDate: format(reportingDate, 'dd.MM.yyyy'),
                phase: 'First Phase',
                feeReimbursement: 'NO',
                profilePhotoUrl: profilePhotoUrl,
                
                feeBreakdown: feeBreakdown,
                totalFee: totalFee,
                totalPaid: totalPaid
            };

            const pdfBuffer = await generateAllotmentOrderPDF(allotmentData);
            // Force unique key to avoid cache
            const timestamp = Date.now();
            const s3Key = `student/${student.applicationId}/documents/AllotmentOrder_${timestamp}.pdf`;
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
