import axios from 'axios';
import crypto from 'crypto';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { AdmissionStatus, PaymentStatus, PaymentComponent, DiscountStatus, FeeStatus, PaymentMethod } from '@prisma/client';
import { getApplicationFeeAmount } from './fee.service';
import { generateInvoicePDF } from '../../utils/invoiceGenerator';
import { uploadFileToS3, getPresignedUrl } from '../../utils/s3Utils';
import { ScholarshipService } from '../admin/scholarship.service';
import { generateAllotmentOrderPDF } from '../../utils/allotmentGenerator';
import { StudentDocumentStatus } from '@prisma/client';


import { StandardCheckoutClient, Env, StandardCheckoutPayRequest } from 'pg-sdk-node';

const MERCHANTABILITY = (process.env.PHONEPE_MERCHANT_ID || 'VVITFEEONLINE_2512111619').trim();
const SALT_KEY = (process.env.PHONEPE_SALT_KEY || 'MGQ4MzNmMmEtNmEzZC00M2JiLWE1NGUtZDdlNjA1MTI0ZTcx').trim();
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
        
        if (response.state === 'COMPLETED' || response.state === 'PAYMENT_SUCCESS') { // Check Exact Enum from SDK
             const payment = await prisma.payment.findFirst({ 
                 where: { providerTxId: merchantTransactionId },
                 include: { student: true }
             });

             if (payment && payment.status !== PaymentStatus.SUCCESS) {
                 await processPaymentSuccess(payment, response);
             }
             return { status: 'SUCCESS', data: response };
        } else if (response.state === 'FAILED') {
             const payment = await prisma.payment.findFirst({ where: { providerTxId: merchantTransactionId } });
             if (payment && payment.status === PaymentStatus.PENDING) {
                  await prisma.payment.update({
                        where: { id: payment.id },
                        data: { status: PaymentStatus.FAILED, metadata: response as any }
                    });
             }
             return { status: 'FAILED', data: response };
        }
        return { status: response.state, data: response };
    } catch (error) {
        logger.error("Error Checking Payment Status", error);
        return null;
    }
};

const processPaymentSuccess = async (payment: any, metadata: any) => {
    let invoiceUrl = null;
    try {
        // Generate Invoice
        const invoiceData:any = {
            invoiceNumber: payment.providerTxId,
            date: new Date(),
            studentName: payment.student.name,
            studentId: payment.student.applicationId,
            paymentMethod: payment.method || 'ONLINE',
            transactionId: payment.providerTxId,
            amount: payment.amount,
            description: payment.component === 'APPLICATION_FEE' ? 'Entrance Exam Application Fee' : 'Payment',
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
    } catch (err) {
        logger.error(`Failed to generate/upload invoice for ${payment.providerTxId}: ${err}`);
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
                feeStatus: FeeStatus.PARTIAL,
                paidFee: { increment: payment.amount }
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

        // Generate Allotment Order
        try {
            const studentWithDetails = await prisma.student.findUnique({
                where: { id: payment.studentId },
                include: { admissionDetails: true }
            });

            if (studentWithDetails && studentWithDetails.admissionDetails) {
                const allotmentData = {
                    applicationId: studentWithDetails.applicationId,
                    studentName: studentWithDetails.name,
                    fatherName: studentWithDetails.fatherName,
                    category: studentWithDetails.category,
                    allottedCourse: studentWithDetails.admissionDetails.allottedSpecialization || 'N/A',
                    allottedCollege: 'VVIT University',
                    admissionFee: studentWithDetails.admissionDetails.paidFee,
                    tuitionFee: studentWithDetails.admissionDetails.totalFee,
                    date: new Date(),
                    academicYear: `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`
                };

                const pdfBuffer = await generateAllotmentOrderPDF(allotmentData);
                const s3Key = `student/${studentWithDetails.applicationId}/documents/AllotmentOrder.pdf`;
                const url = await uploadFileToS3(pdfBuffer, s3Key, 'application/pdf');

                await prisma.studentDocument.upsert({
                    where: {
                        studentId_documentKey: {
                            studentId: payment.studentId,
                            documentKey: 'ALLOTMENT_ORDER'
                        }
                    },
                    create: {
                        studentId: payment.studentId,
                        documentKey: 'ALLOTMENT_ORDER',
                        url: url,
                        status: StudentDocumentStatus.APPROVED,
                        remarks: 'Generated after College Fee Payment'
                    },
                    update: {
                        url: url,
                        updatedAt: new Date()
                    }
                });
                logger.info(`Allotment order generated and saved for student ${payment.studentId}`);
            }
        } catch (err) {
            logger.error(`Failed to generate/upload allotment order for ${payment.studentId}: ${err}`);
        }
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
        logger.info(`Scholarship locked for student ${payment.studentId}`);
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
    let collegeFee = student.admissionDetails.totalFee > 0 ? student.admissionDetails.totalFee : 25000;
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
                hostelFee = room.cost;
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

export const requestDiscount = async (studentId: string, reason: string, documentUrl?: string, userId?: string | null) => {
     return prisma.discountRequest.create({
            data: {
                studentId,
                reason,
                documentUrl,
                status: DiscountStatus.REQUESTED
            }
        });
};

export const getInvoiceUrl = async (paymentId: string) => {
    const payment = await prisma.payment.findUnique({
        where: { id: paymentId }
    });

    if (!payment) {
        throw new AppError('Payment not found', 404);
    }

    if (!payment.invoiceUrl) {
        throw new AppError('Invoice not generated yet', 404);
    }

    // Extract Key from URL
    const keyMatch = payment.invoiceUrl.match(/(student\/.*\.pdf)/);
    
    let key = keyMatch ? keyMatch[1] : null;
    if (!key) {
        const parts = payment.invoiceUrl.split('amazonaws.com/');
        if (parts.length > 1) key = parts[1];
    }

    if (!key) {
         throw new AppError('Invalid invoice URL format', 500);
    }
    
    const presignedUrl = await getPresignedUrl(key);
    return presignedUrl;
};

export const getAllotmentOrderUrl = async (studentId: string) => {
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

export const initiateTokenPayment = async (studentId: string) => {
    const TOKEN_AMOUNT = 10000; // Fixed Token Amount
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', 404);

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

        // Lock Scholarship
        await ScholarshipService.lockAllocation(studentId);

        // Update Admission
        await prisma.studentAdmission.update({
             where: { studentId },
             data: { 
                 paidFee: { increment: TOKEN_AMOUNT },
                 feeStatus: FeeStatus.PARTIAL,
                 status: AdmissionStatus.ADMISSION_CONFIRMED
             }
        });

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

    // 4. Merge Data
    const history = ledger.map(entry => {
        let enrichment = {};
        
        if (entry.referenceType === 'PAYMENT' && entry.referenceId) {
            const payment = paymentMap.get(entry.referenceId);
            if (payment) {
                enrichment = {
                    category: payment.component, // e.g., APPLICATION_FEE, TUITION
                    paymentMethod: payment.method,
                    transactionId: payment.providerTxId,
                    invoiceUrl: payment.invoiceUrl,
                    status: payment.status
                };
            }
        }

        return {
            ...entry,
            ...enrichment
        };
    });

    return { history };
};
