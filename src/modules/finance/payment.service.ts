import axios from 'axios';
import crypto from 'crypto';
import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger, { createModuleLogger } from '../../utils/logger';
const payLog = createModuleLogger('PAYMENT');
const webhookLog = createModuleLogger('WEBHOOK');
const ledgerLog = createModuleLogger('LEDGER');
import { format } from 'date-fns';
import { AdmissionStatus, PaymentStatus, PaymentComponent, DiscountStatus, FeeStatus, PaymentMethod, PaymentMode, HostelPaymentMode, AccommodationType } from '@prisma/client';
import { getApplicationFeeAmount } from './fee.service';
import { getOrCreateAccommodationPricing, resolveFeeDemandContext } from '../../utils/studentContext';
import { generateInvoicePDF } from '../../utils/invoiceGenerator';
import { uploadFileToS3, getPresignedUrl, convertToPresignedUrl } from '../../utils/s3Utils';
import { ScholarshipService } from './scholarship.service';
import { generateAllotmentOrderPDF, generateHostelAllotmentOrderPDF } from '../../utils/allotmentGenerator';
import { StudentDocumentStatus } from '@prisma/client';
import { sendPaymentReceipt } from '../../utils/emailService';

import { InvoiceService } from './invoice.service';
import { StandardCheckoutClient, Env, StandardCheckoutPayRequest } from 'pg-sdk-node';

const MERCHANT_ID_ADMISSION = (process.env.PHONEPE_MERCHANT_ID || '').trim();
const SALT_KEY_ADMISSION = (process.env.PHONEPE_SALT_KEY || '').trim();
const SALT_INDEX_ADMISSION = (process.env.PHONEPE_SALT_INDEX || '1').trim();

const MERCHANT_ID_HOSTEL = (process.env.HOSTEL_PHONEPE_MERCHANT_ID || '').trim();
const SALT_KEY_HOSTEL = (process.env.HOSTEL_PHONEPE_SALT_KEY || '').trim();
const SALT_INDEX_HOSTEL = (process.env.HOSTEL_PHONEPE_SALT_INDEX || '1').trim();

const MERCHANT_ID_MESS = (process.env.MESS_PHONEPE_MERCHANT_ID || '').trim();
const SALT_KEY_MESS = (process.env.MESS_PHONEPE_SALT_KEY || '').trim();
const SALT_INDEX_MESS = (process.env.MESS_PHONEPE_SALT_INDEX || '1').trim();

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
    },
    MESS: {
        MERCHANT_ID: MERCHANT_ID_MESS,
        SALT_KEY: SALT_KEY_MESS,
        SALT_INDEX: SALT_INDEX_MESS
    }
};

const clients: Record<string, any> = {};

export const getPhonePeClient = (type: 'ADMISSION' | 'HOSTEL' | 'MESS' = 'ADMISSION') => {
    if (clients[type]) {
        return clients[type];
    }

    const creds = PHONEPE_CREDENTIALS[type] || PHONEPE_CREDENTIALS.ADMISSION;
    logger.info(`[PhonePe] Initializing client for ${type} (Merchant: ${creds.MERCHANT_ID})`);

    // Using 'new' to create independent instances if supported, avoiding the global singleton issue of getInstance
    // If 'new' is not available (protected constructor), we might have to fallback or rethink,
    // but usually Node SDKs allow new.
    // @ts-ignore
    clients[type] = new StandardCheckoutClient(creds.MERCHANT_ID, creds.SALT_KEY, creds.SALT_INDEX as any, ENV);

    return clients[type];
};

/**
 * Resolve which PhonePe merchant (ADMISSION / HOSTEL=TRUST / MESS=LLP) a payment should
 * route through, based on the student's hostel banking config in the DB.
 *
 * Mapping: each hostel-related component reads its corresponding bank field on Hostel:
 *   - HOSTEL / HOSTEL_ACCOMMODATION → hostel.accommodationBank
 *   - HOSTEL_MESS                   → hostel.messBank
 *   - HOSTEL_LAUNDRY                → hostel.laundryBank
 *   - HOSTEL_REGISTRATION           → hostel.registrationBank
 *   - TRANSPORT                     → defaults to HOSTEL merchant (no per-route bank field)
 *
 * Bank value translation:
 *   TRUST → 'HOSTEL' merchant
 *   LLP   → 'MESS' merchant
 *
 * Non-hostel components (TUITION, ADMISSION, BOOK_BANK, etc.) → 'ADMISSION' merchant.
 */
export const resolvePhonePeClientType = async (
    studentId: string,
    component: PaymentComponent
): Promise<'ADMISSION' | 'HOSTEL' | 'MESS'> => {
    const hostelComponents: PaymentComponent[] = [
        PaymentComponent.HOSTEL,
        PaymentComponent.HOSTEL_ACCOMMODATION,
        PaymentComponent.HOSTEL_MESS,
        PaymentComponent.HOSTEL_LAUNDRY,
        PaymentComponent.HOSTEL_REGISTRATION,
    ];

    if (component === PaymentComponent.TRANSPORT) {
        return 'HOSTEL';
    }
    if (!hostelComponents.includes(component)) {
        return 'ADMISSION';
    }
    // Note: legacy `PaymentComponent.HOSTEL` (no sub-component suffix) is treated as
    // HOSTEL_ACCOMMODATION for routing purposes. New code never writes 'HOSTEL'.

    const admission = await prisma.studentAdmission.findUnique({
        where: { studentId },
        select: { hostelId: true }
    });
    if (!admission?.hostelId) {
        logger.warn(`[resolvePhonePeClientType] Student ${studentId} has no hostelId — defaulting to HOSTEL merchant for ${component}`);
        return 'HOSTEL';
    }

    const hostel = await prisma.hostel.findUnique({
        where: { id: admission.hostelId },
        select: {
            accommodationBank: true,
            messBank: true,
            laundryBank: true,
            registrationBank: true
        }
    });
    if (!hostel) {
        logger.warn(`[resolvePhonePeClientType] Hostel ${admission.hostelId} not found — defaulting to HOSTEL merchant for ${component}`);
        return 'HOSTEL';
    }

    let bank: string | null = null;
    switch (component) {
        case PaymentComponent.HOSTEL:
        case PaymentComponent.HOSTEL_ACCOMMODATION:
            bank = hostel.accommodationBank; break;
        case PaymentComponent.HOSTEL_MESS:
            bank = hostel.messBank; break;
        case PaymentComponent.HOSTEL_LAUNDRY:
            bank = hostel.laundryBank; break;
        case PaymentComponent.HOSTEL_REGISTRATION:
            bank = hostel.registrationBank; break;
    }

    const upper = (bank || '').toUpperCase();
    if (upper === 'LLP') return 'MESS';
    if (upper === 'TRUST') return 'HOSTEL';

    logger.warn(`[resolvePhonePeClientType] Hostel ${admission.hostelId} has no/unknown bank "${bank}" for ${component} — defaulting to HOSTEL merchant`);
    return 'HOSTEL';
};

// Reusable PhonePe Initialization
const resolveComponent = async (componentName: string, feeHeadId?: string): Promise<{ component: PaymentComponent, feeHeadId?: string }> => {
    const normalize = (s: string) => s.toUpperCase().replace(/ /g, '_');
    const input = normalize(componentName);

    // 1. Map Display Names/Aliases to Enums.
    // Note: legacy 'HOSTEL FEE' input is now routed to HOSTEL_ACCOMMODATION (the bare HOSTEL
    // enum value is being phased out — backfill SQL renames existing rows).
    const nameMap: Record<string, PaymentComponent> = {
        'APPLICATION FEE': PaymentComponent.APPLICATION_FEE,
        'TUITION FEE': PaymentComponent.TUITION,
        'HOSTEL FEE': PaymentComponent.HOSTEL_ACCOMMODATION,
        'HOSTEL ACCOMMODATION FEE': PaymentComponent.HOSTEL_ACCOMMODATION,
        'HOSTEL ACCOMMODATION': PaymentComponent.HOSTEL_ACCOMMODATION,
        'MESS FEE': PaymentComponent.HOSTEL_MESS,
        'HOSTEL MESS': PaymentComponent.HOSTEL_MESS,
        'LAUNDRY FEE': PaymentComponent.HOSTEL_LAUNDRY,
        'HOSTEL LAUNDRY': PaymentComponent.HOSTEL_LAUNDRY,
        'REGISTRATION FEE': PaymentComponent.HOSTEL_REGISTRATION,
        'HOSTEL REGISTRATION': PaymentComponent.HOSTEL_REGISTRATION,
        'TRANSPORT FEE': PaymentComponent.TRANSPORT,
        'TOKEN FEE': PaymentComponent.SCHOLARSHIP_TOKEN,
        'BOOK BANK FEE': PaymentComponent.BOOK_BANK,
        'SKILL DEVELOPMENT FEE': PaymentComponent.SKILL_DEVELOPMENT,
        'OTHER FEE': PaymentComponent.OTHER
    };

    // Try underscore format (TUITION_FEE) or space format (TUITION FEE)
    const mapped = nameMap[input] || nameMap[input.replace(/_/g, ' ')];
    if (mapped) return { component: mapped, feeHeadId };

    // 2. Direct Enum Match (Case Insensitive)
    const validComponents = Object.values(PaymentComponent) as string[];
    if (validComponents.includes(input)) {
        return { component: input as PaymentComponent, feeHeadId };
    }

    // 3. Try to find FeeHead by Name
    try {
        const feeHead = await prisma.feeHead.findFirst({
            where: { name: { equals: componentName, mode: 'insensitive' } }
        });

        if (feeHead) {
             // If found, treat as OTHER with resolved ID
            return { component: PaymentComponent.OTHER, feeHeadId: feeHead.id };
        }
    } catch (e) {
        logger.warn(`FeeHead lookup failed for ${componentName}: ${e}`);
    }

    throw new AppError(`Invalid Payment Component or Fee Head Name: ${componentName}`, 400);
};

export const initiatePhonePePayment = async (studentId: string, amount: number, transactionId: string, redirectUrl: string, feeType: 'ADMISSION' | 'HOSTEL' | 'MESS' = 'ADMISSION') => {
    try {
        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError('Student not found for payment', 404);

        const client = getPhonePeClient(feeType);

        const config = PHONEPE_CREDENTIALS[feeType];
        logger.info(`[initiatePhonePePayment] Type=${feeType}, Env=${ENV === Env.PRODUCTION ? 'PROD' : 'SANDBOX'}, Merchant=${config.MERCHANT_ID}, SaltIndex=${config.SALT_INDEX}, RedirectUrl=${redirectUrl}`);

        const request = StandardCheckoutPayRequest.builder()
            .merchantOrderId(transactionId)
            .amount(amount * 100)
            .redirectUrl(redirectUrl)
            .build();

        const response = await client.pay(request);
        return { redirectUrl: response.redirectUrl };
    } catch (error: any) {
        logger.error(`PhonePe Initiation Error [${transactionId}]: ${error?.message || error}`, {
            stack: error?.stack,
            response: error?.response?.data,
            code: error?.code,
            status: error?.status
        });
        throw new AppError('Failed to initiate payment gateway', 502);
    }
};

export const initiateApplicationFeePayment = async (studentId: string) => {
    const amount = await getApplicationFeeAmount();
    const student = await prisma.student.findUnique({
        where: { id: studentId }
    });
    
    // Step 1: Check Student Existence and Payment Status
    payLog.info('INITIATE', `Application fee payment started`, { studentId, amount, applicationId: student?.applicationId });

    if (!student) {
        payLog.error('INITIATE_FAILED', `Student not found`, { studentId });
        throw new AppError('Student not found', 404);
    }
    
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

    // Step 2: Reuse existing PENDING payment only if it is still fresh (within PhonePe's
    // ~20-minute order expiry window). If stale, mark it FAILED and create a fresh one.
    // This prevents sending expired merchantOrderIds to PhonePe → INVALID_TRANSACTION_ID.
    // Entire block runs inside a serializable transaction to prevent race conditions where
    // two simultaneous requests create duplicate PENDING records for the same student.
    const PHONEPE_ORDER_EXPIRY_MS = 20 * 60 * 1000; // 20 minutes
    logger.info(`[initiateApplicationFeePayment] Step 2: Checking for existing PENDING payment`);

    let transactionId: string = '';
    let createdPayment: any = null;

    await prisma.$transaction(async (tx) => {
        const existingPending = await tx.payment.findFirst({
            where: {
                studentId,
                component: PaymentComponent.APPLICATION_FEE,
                status: PaymentStatus.PENDING
            },
            orderBy: { createdAt: 'desc' }
        });

        if (existingPending) {
            const ageMs = Date.now() - new Date(existingPending.createdAt ?? Date.now()).getTime();
            const isFresh = ageMs <= PHONEPE_ORDER_EXPIRY_MS;

            if (isFresh && existingPending.providerTxId) {
                // Fresh PENDING (< 20 min) — reuse same transaction ID, PhonePe order is still alive
                transactionId = existingPending.providerTxId;
                createdPayment = existingPending;
                logger.info(`[initiateApplicationFeePayment] Reusing fresh PENDING payment ${existingPending.id} (age: ${Math.round(ageMs / 1000)}s) txnId=${transactionId}`);
            } else {
                // Stale PENDING (> 20 min) — PhonePe order has expired, mark FAILED and create fresh
                logger.warn(`[initiateApplicationFeePayment] Stale PENDING payment found (age: ${Math.round(ageMs / 60000)} mins). Marking FAILED and creating fresh payment.`);
                await tx.payment.update({
                    where: { id: existingPending.id },
                    data: { status: PaymentStatus.FAILED, metadata: { reason: 'EXPIRED_ORDER_RECREATED' } as any }
                });
                transactionId = `TXN_${Date.now()}_${studentId.replace(/-/g, '').substring(0, 6)}`;
                createdPayment = await tx.payment.create({
                    data: {
                        studentId,
                        amount,
                        status: PaymentStatus.PENDING,
                        component: PaymentComponent.APPLICATION_FEE,
                        providerTxId: transactionId,
                        idempotencyKey: `${transactionId}_APPLICATION_FEE`,
                        method: PaymentMethod.UPI
                    }
                });
                logger.info(`[initiateApplicationFeePayment] Created fresh payment ${createdPayment.id} txnId=${transactionId}`);
            }
        } else {
            // No existing PENDING — create brand new payment
            transactionId = `TXN_${Date.now()}_${studentId.replace(/-/g, '').substring(0, 6)}`;
            createdPayment = await tx.payment.create({
                data: {
                    studentId,
                    amount,
                    status: PaymentStatus.PENDING,
                    component: PaymentComponent.APPLICATION_FEE,
                    providerTxId: transactionId,
                    idempotencyKey: `${transactionId}_APPLICATION_FEE`,
                    method: PaymentMethod.UPI
                }
            });
            logger.info(`[initiateApplicationFeePayment] Created new PENDING payment ${createdPayment.id} txnId=${transactionId}`);
        }
    }, { isolationLevel: 'Serializable' });

    // Step 3: Initiate PhonePe Request
    payLog.info('GATEWAY_INIT', `Initiating PhonePe payment`, { studentId, applicationId: student.applicationId, txnId: transactionId, amount });
    const redirectUrl = `${process.env.FRONTEND_URL}/student/payment?txnId=${transactionId}`;

    // Explicitly use 'ADMISSION' credentials for Application Fee
    try {
        const result = await initiatePhonePePayment(studentId, amount, transactionId, redirectUrl, 'ADMISSION');
        payLog.info('GATEWAY_REDIRECT', `PhonePe redirect URL generated`, { studentId, applicationId: student.applicationId, txnId: transactionId, paymentId: createdPayment.id });
        return { redirectUrl: result.redirectUrl, paymentId: createdPayment.id, expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString() };
    } catch (err) {
        await prisma.payment.update({
            where: { id: createdPayment.id },
            data: { status: PaymentStatus.FAILED, metadata: { reason: 'GATEWAY_INIT_FAILED' } as any }
        });
        throw err;
    }
};

/**
 * initiateMultiComponentPayment
 *
 * Handles payment for multiple fee components in a single transaction.
 * Used by POST /multi-component route.
 *
 * IMPORTANT — mode vs paymentMethod:
 *   The `mode` param (ONLINE/OFFLINE) is accepted from the caller but intentionally IGNORED here.
 *   Payment mode is derived automatically from `paymentMethod`:
 *     - CASH, CHEQUE, DEMAND_DRAFT, NEFT, RTGS, NEFT_RTGS, IMPS → OFFLINE
 *     - UPI (or anything else) → ONLINE
 *   Do NOT rely on `mode` to control offline/online behavior in this function.
 *   Use `paymentMethod` instead.
 *
 * Bundle rule: all components must route to the SAME PhonePe merchant.
 *   - Each hostel component routes per the student's hostel bank config:
 *       accommodationBank=TRUST → HOSTEL merchant; messBank=LLP → MESS merchant; etc.
 *   - Non-hostel/transport (TUITION, ADMISSION, BOOK_BANK, etc.) → ADMISSION merchant.
 *   - TRANSPORT → HOSTEL merchant.
 *   - If the bundle spans merchants, the request is rejected — split into per-merchant calls.
 *
 * Online flow:
 *   - All components share a single PhonePe transaction (total amount charged at once).
 *   - Routes to the merchant the bundle resolves to (validated above).
 *   - Individual payment records are created as PENDING; finalized via webhook callback.
 *
 * Offline flow:
 *   - All component payments are immediately marked SUCCESS in the same call.
 *   - A single combined invoice is generated for all components.
 *   - Fee demands are settled per component individually.
 */
export const initiateMultiComponentPayment = async (
    studentId: string,
    rawComponents: { component: string | PaymentComponent, amount: number, feeHeadId?: string }[],
    userId?: string,
    paymentMethod: PaymentMethod = PaymentMethod.UPI,
    remarks?: string,
    referenceNumber?: string,
    mode?: string // NOTE: ignored — mode is derived from paymentMethod above
) => {
    logger.info(`[initiateMultiComponentPayment] Student=${studentId}, Components=${JSON.stringify(rawComponents)}, Method=${paymentMethod}, Mode=${mode}, Ref=${referenceNumber}`);

    // Resolve Names to IDs
    const components: { component: PaymentComponent, amount: number, feeHeadId?: string }[] = [];
    for (const c of rawComponents) {
        logger.debug(`[initiateMultiComponentPayment] Resolving component: ${c.component}`);
        const r = await resolveComponent(c.component as string, c.feeHeadId);
        components.push({ ...c, ...r });
    }

    // 1. Validate: bundle must route to a single PhonePe merchant.
    // Hostel sub-components can route to ADMISSION / HOSTEL (TRUST) / MESS (LLP)
    // depending on the student's hostel banking config. Components going to the
    // same merchant CAN be bundled; mixing merchants is a hard error because
    // PhonePe initiates one transaction at one merchant.
    const merchants = new Set<string>();
    const merchantPerComponent: Record<string, string> = {};
    for (const c of components) {
        const m = await resolvePhonePeClientType(studentId, c.component);
        merchants.add(m);
        merchantPerComponent[c.component] = m;
    }
    if (merchants.size > 1) {
        const breakdown = Object.entries(merchantPerComponent)
            .map(([comp, m]) => `${comp}→${m}`)
            .join(', ');
        throw new AppError(
            `Components in this bundle route to different bank merchants (${breakdown}). Pay each merchant group separately.`,
            400
        );
    }

    // 2. Validate Fee Heads - Mandate Fee Head ID (Exempting specific types)
    const exemptComponents: PaymentComponent[] = [
        PaymentComponent.TRANSPORT,
        PaymentComponent.OTHER,
        PaymentComponent.HOSTEL_ACCOMMODATION,
        PaymentComponent.HOSTEL_MESS,
        PaymentComponent.HOSTEL_LAUNDRY,
        PaymentComponent.HOSTEL_REGISTRATION,
        PaymentComponent.HOSTEL,
        PaymentComponent.COURSE_CHANGE_FEE
    ];

    for (const item of components) {
        if (!item.feeHeadId && !exemptComponents.includes(item.component)) {
            throw new AppError(`Fee Head ID is mandatory for ${item.component}`, 400);
        }
        if (item.feeHeadId) {
            const feeHead = await prisma.feeHead.findUnique({ where: { id: item.feeHeadId } });
            if (!feeHead) {
                throw new AppError(`Invalid Fee Head ID: ${item.feeHeadId}`, 400);
            }
        }
    }

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) {
        throw new AppError('Student not found', 404);
    }

    const totalAmount = components.reduce((sum, c) => sum + c.amount, 0);
    if (totalAmount <= 0) throw new AppError('Total amount must be greater than zero', 400);

    // Mode is derived from paymentMethod — the `mode` parameter passed in is NOT used.
    // Any non-cash method (UPI etc.) is treated as ONLINE; all cash/bank-transfer methods as OFFLINE.
    const isOffline = [
        PaymentMethod.CASH,
        PaymentMethod.CHEQUE,
        PaymentMethod.DEMAND_DRAFT,
        PaymentMethod.NEFT_RTGS,
        PaymentMethod.IMPS,
        PaymentMethod.NEFT,
        PaymentMethod.RTGS
    ].includes(paymentMethod as any);

    const transactionId = isOffline 
        ? (referenceNumber || `OFFLINE_${Date.now()}_${studentId.replace(/-/g, '').substring(0, 6)}`)
        : `TXN_${Date.now()}_${studentId.replace(/-/g, '').substring(0, 6)}`;
    
    const paymentStatus = PaymentStatus.PENDING;
    const paymentMode = isOffline ? PaymentMode.OFFLINE : PaymentMode.ONLINE;

    // 3. Duplicate check for offline payments with reference numbers (skip for CASH)
    if (isOffline && referenceNumber && paymentMethod !== PaymentMethod.CASH) {
        const existingPayment = await prisma.payment.findFirst({
            where: { referenceNumber, studentId, status: PaymentStatus.SUCCESS }
        });
        if (existingPayment) {
            throw new AppError(`Duplicate payment: reference number '${referenceNumber}' already used for this student`, 409);
        }
    }

    // 4. Create Payment Records
    const paymentIds: string[] = [];
    const createdPayments: any[] = [];

    await prisma.$transaction(async (tx) => {
        // Double-check inside transaction to prevent race condition (skip for CASH)
        if (isOffline && referenceNumber && paymentMethod !== PaymentMethod.CASH) {
            const duplicate = await tx.payment.findFirst({
                where: { referenceNumber, studentId, status: { in: [PaymentStatus.SUCCESS, PaymentStatus.PENDING] } }
            });
            if (duplicate) {
                throw new AppError(`Duplicate payment: reference number '${referenceNumber}' already used`, 409);
            }
        }

        for (const item of components) {
            const payment = await tx.payment.create({
                data: {
                    studentId,
                    amount: item.amount,
                    status: paymentStatus,
                    component: item.component,
                    providerTxId: transactionId,
                    idempotencyKey: `${transactionId}_${item.component}`,
                    method: paymentMethod,
                    mode: paymentMode,
                    referenceNumber,
                    createdBy: userId,
                    collectedBy: paymentMethod === PaymentMethod.CASH ? userId : undefined,
                    metadata: remarks ? { remarks, mode: 'OFFLINE_ENTRY' } : undefined,
                    feeHeadId: item.feeHeadId
                }
            });
            paymentIds.push(payment.id);
            createdPayments.push(payment);
        }
    });

    // 4. Handle Payment Flow
    if (isOffline) {
        const paymentsWithStudent = createdPayments.map(p => ({ ...p, student }));
        const successResult = await processMultiPaymentSuccess(paymentsWithStudent, { remarks, mode: 'OFFLINE_ENTRY', collectedBy: userId });
        const presignedInvoiceUrl = successResult?.invoiceUrl ? await convertToPresignedUrl(successResult.invoiceUrl) : null;

        return { 
            success: true, 
            message: "Payment recorded successfully", 
            paymentIds, 
            transactionId,
            invoiceUrl: presignedInvoiceUrl
        };
    } else {
        const redirectUrl = `${process.env.FRONTEND_URL_ADMISSION}/admin/fees/offlinepayments?appId=${student.applicationId}&paymentId=${paymentIds.join(',')}`;
        // Route to the merchant that matches the bundle. Validated above to be a single merchant.
        const targetMerchant = (Array.from(merchants)[0] ?? 'ADMISSION') as 'ADMISSION' | 'HOSTEL' | 'MESS';
        try {
            const result = await initiatePhonePePayment(studentId, totalAmount, transactionId, redirectUrl, targetMerchant);
            return { redirectUrl: result.redirectUrl, paymentIds, expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString() };
        } catch (err) {
            await prisma.payment.updateMany({
                where: { id: { in: paymentIds } },
                data: { status: PaymentStatus.FAILED, metadata: { reason: 'GATEWAY_INIT_FAILED' } as any }
            });
            throw err;
        }
    }
};

export const checkPaymentStatus = async (merchantTransactionId: string) => {
    logger.info(`[checkPaymentStatus] Request for MerchantTxId=${merchantTransactionId}`);
    try {
        const payments = await prisma.payment.findMany({ 
             where: { providerTxId: merchantTransactionId },
             include: { student: true }
        });

        if (payments.length === 0) {
            logger.warn(`[checkPaymentStatus] No payment records found locally for ${merchantTransactionId}`);
        }

        const primaryPayment = payments[0];
        let clientToCheck = getPhonePeClient('ADMISSION');

        if (primaryPayment) {
            const clientType = await resolvePhonePeClientType(
                primaryPayment.studentId,
                primaryPayment.component as PaymentComponent
            );
            clientToCheck = getPhonePeClient(clientType);
        }
        
        logger.info(`[checkPaymentStatus] Querying PhonePe with component-resolved client for txnId=${merchantTransactionId}`);
        const response = await clientToCheck.getOrderStatus(merchantTransactionId);

        logger.debug(`[checkPaymentStatus] PhonePe Response: ${JSON.stringify(response)}`);
        
        if (response.state === 'COMPLETED' || response.state === 'PAYMENT_SUCCESS') {
             const needsUpdate = payments.some(p => p.status !== PaymentStatus.SUCCESS);
             if (needsUpdate) {
                 const isAdmissionPayment = payments.some((p: any) => p.metadata?.targetAction === 'FINALIZE_ADMISSION');
                 if (isAdmissionPayment) {
                     const { AdminStudentService } = await import('../studentManagement/adminStudent.service');
                     await AdminStudentService._completeAdmissionTransaction(payments, 'system', merchantTransactionId, response);
                 } else {
                     await processMultiPaymentSuccess(payments, response);
                 }
             }
             return { status: 'SUCCESS', data: response, paymentIds: payments.map(p => p.id) };

        } else if (response.state === 'FAILED') {
             const pendingPayments = payments.filter(p => p.status === PaymentStatus.PENDING);
             if (pendingPayments.length > 0) {
                  await prisma.payment.updateMany({
                        where: { providerTxId: merchantTransactionId },
                        data: { status: PaymentStatus.FAILED, metadata: response as any }
                    });
             }
             return { status: 'FAILED', data: response, paymentIds: payments.map(p => p.id) };
        }
        return { status: response.state, data: response, paymentIds: payments.map(p => p.id) };
    } catch (error: any) {
        logger.error(`[checkPaymentStatus] Failed for txnId=${merchantTransactionId}: ${error?.message}`);
        throw new AppError('Failed to check payment status with PhonePe', 502);
    }
};

const processSinglePaymentSuccess = async (payment: any, metadata: any) => {
    logger.info(`[processSinglePaymentSuccess] Delegating to processMultiPaymentSuccess for Payment ${payment.id}`);
    return await processMultiPaymentSuccess([payment], metadata);
};

const processMultiPaymentSuccess = async (payments: any[], metadata: any) => {
    if (!payments || payments.length === 0) return;
    const txnId = payments[0].providerTxId;
    const studentId = payments[0].studentId;
    const applicationId = payments[0].student?.applicationId;
    payLog.info('PROCESSING', `Processing ${payments.length} payment(s)`, { txnId, studentId, applicationId, count: payments.length });
    logger.info(`[processMultiPaymentSuccess] Processing ${payments.length} payments. Ref=${txnId}`);

    // Idempotency guard — skip payments already marked SUCCESS to prevent
    // double ledger entries and double fee settlement on duplicate callbacks
    const pendingPayments = payments.filter(p => p.status !== PaymentStatus.SUCCESS);
    if (pendingPayments.length === 0) {
        logger.info(`[processMultiPaymentSuccess] All payments already SUCCESS — skipping duplicate processing. Ref=${payments[0].providerTxId}`);
        return;
    }
    if (pendingPayments.length < payments.length) {
        logger.warn(`[processMultiPaymentSuccess] ${payments.length - pendingPayments.length} payment(s) already SUCCESS, processing remaining ${pendingPayments.length}. Ref=${payments[0].providerTxId}`);
    }

    // 1. Update Status FIRST (So InvoiceService sees them as SUCCESS)
    await prisma.payment.updateMany({
        where: { id: { in: pendingPayments.map((p: any) => p.id) } },
        data: { status: PaymentStatus.SUCCESS, metadata }
    });
    payLog.info('SUCCESS', `${pendingPayments.length} payment(s) marked SUCCESS`, { txnId, studentId, applicationId, amount: payments.reduce((s: number, p: any) => s + p.amount, 0) });

    // 2. Pre-generate Allotment Order for admission payments (must happen before invoice so email can attach it)
    const admissionComponents = [PaymentComponent.SCHOLARSHIP_TOKEN, PaymentComponent.TUITION];
    const hasAdmissionPayment = payments.some((p: any) => admissionComponents.includes(p.component));
    if (hasAdmissionPayment) {
        try {
            const existingAllotment = await prisma.studentDocument.findUnique({
                where: { studentId_documentKey: { studentId: payments[0].studentId, documentKey: 'ALLOTMENT_ORDER' } }
            });
            if (!existingAllotment?.url) {
                await generateAndSaveAllotmentOrder(payments[0].studentId);
                payLog.info('ALLOTMENT_GENERATED', `Allotment order generated`, { studentId });
            }
        } catch (e) {
            payLog.error('ALLOTMENT_FAILED', `Allotment order generation failed: ${e}`, { studentId });
        }
    }

    // 3. Generate Invoice (Unified) via InvoiceService
    let invoiceUrl = null;
    try {
        const invoiceResult = await InvoiceService.generateInvoiceForPayment(payments[0].id);
        invoiceUrl = invoiceResult.invoiceUrl;
        payLog.info('INVOICE_GENERATED', `Invoice generated`, { studentId, applicationId, txnId, invoiceNumber: invoiceResult.invoiceNumber });
    } catch (e) {
        payLog.error('INVOICE_FAILED', `Invoice generation failed: ${e}`, { studentId, applicationId, txnId });
    }

    // 3. Process Logic (Iterate)
    for (const payment of payments) {
        await _processComponentLogic(payment);
        if (payment.component !== PaymentComponent.APPLICATION_FEE) {
            await _settleFeeDemands(payment);
            payLog.info('FEE_SETTLED', `Fee demand settled`, { studentId, component: payment.component, amount: payment.amount });
        }
        await _createPaymentLedger(payment);
        ledgerLog.info('CREATED', `Ledger entry created`, { studentId, type: 'CREDIT', amount: payment.amount, component: payment.component });
    }

    // 4. Triggers
    await _handleTriggers(payments);

    payLog.info('COMPLETED', `Payment processing completed`, { txnId, studentId, applicationId, totalAmount: payments.reduce((s: number, p: any) => s + p.amount, 0) });
    return { invoiceUrl };
};

const _processComponentLogic = async (payment: any) => {
    const { studentId, component } = payment;
    const currentStatus = await prisma.studentAdmission.findUnique({
        where: { studentId },
        select: { status: true }
    });

    if (component === PaymentComponent.APPLICATION_FEE) {
         if (currentStatus?.status !== AdmissionStatus.ADMISSION_CONFIRMED && currentStatus?.status !== AdmissionStatus.ENROLLED) {
            try {
                await prisma.studentAdmission.update({
                    where: { studentId },
                    data: { status: AdmissionStatus.ENTRANCE_FEE_PAID, feeStatus: FeeStatus.PARTIAL }
                });
                logger.info(`[processComponentLogic] Updated student ${studentId} status to ENTRANCE_FEE_PAID`);
            } catch (error) {
                logger.error(`[processComponentLogic] Failed to update admission status for student ${studentId}: ${error}`);
                // Don't fail the payment, but log the issue
            }
         }
    } else if (component === PaymentComponent.TUITION || component === PaymentComponent.ADMISSION || component === PaymentComponent.SCHOLARSHIP_TOKEN) {
        if ((component === PaymentComponent.SCHOLARSHIP_TOKEN || component === PaymentComponent.TUITION) && currentStatus?.status !== AdmissionStatus.ADMISSION_CONFIRMED && currentStatus?.status !== AdmissionStatus.ENROLLED) {
             await ScholarshipService.lockAllocation(studentId);

             // Skip FEE_GENERATION ledger if fee demands already exist (finalize admission flow handles this)
             const existingDemands = await prisma.studentFeeDemand.count({ where: { studentId } });
             if (existingDemands === 0) {
                 const detailedStudent = await prisma.student.findUnique({ where: { id: studentId }, include: { admissionDetails: { include: { hostel: true, transportRoute: true } }, scholarshipAllocation: { include: { rule: true } } }});
                 if (detailedStudent?.admissionDetails) {
                     const ledgers: any[] = [];
                     const admission = detailedStudent.admissionDetails;
                     const tuitionFee = admission.totalFee ?? 0;
                     if (tuitionFee <= 0) {
                         logger.warn(`[_processComponentLogic] totalFee is ${tuitionFee} for student=${studentId} — skipping tuition ledger entry`);
                     }
                     if (tuitionFee > 0) ledgers.push({ studentId, type: 'DEBIT', amount: tuitionFee, description: 'Tuition Fee (Annual)', referenceId: payment.id, referenceType: 'FEE_GENERATION', date: new Date() });
                     if (admission.transportRouteId && admission.transportRoute) { ledgers.push({ studentId, type: 'DEBIT', amount: admission.transportRoute.cost, description: `Transport Fee - ${admission.transportRoute.name}`, referenceId: payment.id, referenceType: 'FEE_GENERATION', date: new Date() }); }
                     if (detailedStudent.scholarshipAllocation?.status === 'LOCKED' && detailedStudent.scholarshipAllocation.rule) { const rule = detailedStudent.scholarshipAllocation.rule; const discount = (tuitionFee * rule.discountPercentage) / 100; if (discount > 0) { ledgers.push({ studentId, type: 'CREDIT', amount: discount, description: `Scholarship Discount - ${rule.name} (${rule.discountPercentage}%)`, referenceId: detailedStudent.scholarshipAllocation.id, referenceType: 'SCHOLARSHIP', date: new Date() }); } }
                     if (ledgers.length > 0) await prisma.studentLedger.createMany({ data: ledgers });
                 }
             } else {
                 logger.info(`[_processComponentLogic] Skipping FEE_GENERATION for student=${studentId} — ${existingDemands} fee demands already exist`);
             }
        }
        await prisma.studentAdmission.update({
            where: { studentId },
            data: { feeStatus: FeeStatus.PARTIAL }
        });
    }
};


const _settleFeeDemands = async (payment: any) => {
    await prisma.studentAdmission.update({
         where: { studentId: payment.studentId },
         data: { paidFee: { increment: payment.amount } }
    });

    try {
        let targetDemandId = payment.feeDemandId;

        // Resolve via FeeHead if missing
        if (!targetDemandId && payment.feeHeadId) {
             const matchingDemand = await prisma.studentFeeDemand.findFirst({
                 where: {
                     studentId: payment.studentId,
                     status: { in: [FeeStatus.PENDING, FeeStatus.PARTIAL] },
                     OR: [
                          { feeHeadId: payment.feeHeadId },
                          { feeStructure: { feeHeadId: payment.feeHeadId } }
                     ]
                 },
                 orderBy: { dueDate: 'asc' }
             });
             if (matchingDemand) targetDemandId = matchingDemand.id;
        }

        // Strict Settlement
        if (targetDemandId) {
            const demand = await prisma.studentFeeDemand.findUnique({ where: { id: targetDemandId } });
            if (demand) {
                const newStatus = payment.amount >= demand.amount ? 'FULL' : 'PARTIAL';
                await prisma.studentFeeDemand.update({
                    where: { id: demand.id },
                    data: { status: newStatus as any }
                });
                // Copy academicYearId + yearOfStudy onto the Payment row so reports filter by year cheaply
                await prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        feeDemandId: targetDemandId,
                        academicYearId: demand.academicYearId ?? undefined,
                        yearOfStudy: demand.yearOfStudy ?? undefined,
                    }
                });
                // Mutate in-memory so the subsequent _createPaymentLedger() picks up the year context
                payment.feeDemandId = targetDemandId;
                payment.academicYearId = demand.academicYearId ?? null;
                payment.yearOfStudy = demand.yearOfStudy ?? null;
            }
        }
        // Waterfall Settlement
        else {
            const pendingDemands = await prisma.studentFeeDemand.findMany({
                where: { studentId: payment.studentId, status: FeeStatus.PENDING },
                orderBy: { dueDate: 'asc' }
            });

            // Use the first (oldest) demand's year as the payment's year. Best proxy when
            // a generic payment splits across multiple demands.
            if (pendingDemands.length > 0) {
                const first = pendingDemands[0];
                await prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        academicYearId: first.academicYearId ?? undefined,
                        yearOfStudy: first.yearOfStudy ?? undefined,
                    }
                });
                payment.academicYearId = first.academicYearId ?? null;
                payment.yearOfStudy = first.yearOfStudy ?? null;
            }

            let remaining = payment.amount;
            for (const demand of pendingDemands) {
                if (remaining <= 0) break;
                if (remaining >= demand.amount) {
                    await prisma.studentFeeDemand.update({ where: { id: demand.id }, data: { status: FeeStatus.FULL } });
                    remaining -= demand.amount;
                } else {
                    await prisma.studentFeeDemand.update({ where: { id: demand.id }, data: { status: FeeStatus.PARTIAL } });
                    break;
                }
            }
        }
    } catch (err) {
        logger.error(`Fee Settlement Error: ${err}`);
    }
};

const _createPaymentLedger = async (payment: any) => {
    try {
        await prisma.studentLedger.create({
            data: {
                studentId: payment.studentId,
                type: 'CREDIT',
                amount: payment.amount,
                description: `Payment Received via ${payment.method || 'ONLINE'} (${payment.component})`,
                referenceId: payment.id,
                referenceType: 'PAYMENT',
                feeHeadId: payment.feeHeadId || undefined,
                academicYearId: payment.academicYearId || undefined,
                yearOfStudy: payment.yearOfStudy || undefined,
                createdBy: payment.createdBy || payment.collectedBy || 'SYSTEM',
                date: new Date()
            } as any
        });
    } catch (err) {
        logger.error(`Ledger Creation Failed for ${payment.id}: ${err}`);
    }
};

const _sendPaymentNotification = async (student: any, payments: any[], invoiceResult: any) => {
    if (!student.email || !invoiceResult.invoiceUrl) return;

    let emailType = 'DEFAULT';
    if (payments.length === 1 && payments[0].component === PaymentComponent.APPLICATION_FEE) {
         emailType = 'APPLICATION_FEE';
    }

    const { invoiceNumber, realTransactionId, invoiceData, invoiceItems } = invoiceResult;
    
    await sendPaymentReceipt(student.email, {
        studentName: student.name,
        invoiceNumber,
        applicationId: student.applicationId,
        transactionId: realTransactionId,
        amount: invoiceData.amount,
        date: new Date(),
        paymentType: emailType as any,
        customFeeType: `Fee Payment (${invoiceItems.map((i: any) => i.description).join(', ')})`,
        invoiceUrl: invoiceResult.invoiceUrl,
        address: invoiceData.address
    });
};

const _handleTriggers = async (payments: any[]) => {
    const finalizeTrigger = payments.find(p => p.metadata?.targetAction === 'FINALIZE_ADMISSION');
    if (finalizeTrigger) {
         try {
            const { AdminStudentService } = require('../studentManagement/adminStudent.service');
            await prisma.$transaction(async (tx) => {
                 await AdminStudentService.executeAdmissionUpdates(finalizeTrigger.studentId, finalizeTrigger.metadata, finalizeTrigger.id, 'SYSTEM', tx);
            });
        } catch (err) {
            logger.error(`Admission Finalization Error: ${err}`);
        }
    }
};


export const recordOfflineApplicationFeePayment = async (studentId: string, paymentMethod: PaymentMethod, transactionId?: string, remarks?: string, adminId?: string, referenceNumber?: string) => {
    const amount = await getApplicationFeeAmount();

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', 404);

    const admission = await prisma.studentAdmission.findUnique({ where: { studentId } });
    if (!admission) throw new AppError('Student admission record not found. Please ensure the student has completed registration.', 400);

    // If CASH, generate a system transaction ID
    const providerTxId = transactionId || `CASH_${Date.now()}_${studentId.substring(0, 8)}`;

    // Transaction to prevent race conditions and ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
        // Duplicate check inside transaction to prevent race conditions
        const existingPayment = await tx.payment.findFirst({
            where: {
                studentId,
                component: PaymentComponent.APPLICATION_FEE,
                status: { in: [PaymentStatus.SUCCESS, PaymentStatus.PENDING] }
            }
        });

        if (existingPayment) {
            throw new AppError('Application fee already paid', 400);
        }

        const payment = await tx.payment.create({
            data: {
                studentId,
                amount,
                status: PaymentStatus.PENDING,
                component: PaymentComponent.APPLICATION_FEE,
                providerTxId,
                idempotencyKey: `${providerTxId}_APPLICATION_FEE`,
                referenceNumber: referenceNumber || null,
                method: paymentMethod,
                mode: PaymentMode.OFFLINE,
                collectedBy: adminId,
                createdBy: adminId,
                updatedBy: adminId,
                metadata: { remarks, mode: 'OFFLINE_ENTRY' }
            }
        });

        return payment;
    });

    // Process success logic (Invoice, Admission Status, Ledger)
    // Outside transaction since it has its own DB writes + external calls (S3)
    await processSinglePaymentSuccess({ ...result, student }, { remarks, adminId });

    // Verify critical side-effects completed
    const updatedPayment = await prisma.payment.findUnique({ where: { id: result.id } });

    if (!updatedPayment || updatedPayment.status !== PaymentStatus.SUCCESS) {
        logger.error(`[recordOfflineApplicationFeePayment] Payment ${result.id} processing failed — status is ${updatedPayment?.status}`);
        throw new AppError('Payment recorded but processing failed. Please contact admin.', 500);
    }

    if (updatedPayment.invoiceUrl) {
        updatedPayment.invoiceUrl = await convertToPresignedUrl(updatedPayment.invoiceUrl) as string;
    }

    return updatedPayment;
};

export const handlePaymentCallback = async (base64Payload: string, xVerify: string) => {
    webhookLog.info('RECEIVED', `Legacy callback received`);

    // 1. Decode Payload first to identify Merchant
    const decodedBuffer = Buffer.from(base64Payload, 'base64');
    const decodedString = decodedBuffer.toString('utf-8');
    const decodedPayload = JSON.parse(decodedString);
    const { merchantTransactionId, code, merchantId } = decodedPayload;

    webhookLog.info('DECODED', `Callback decoded`, { txnId: merchantTransactionId, code, merchantId });

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
        webhookLog.error('CHECKSUM_FAILED', `Invalid checksum`, { txnId: merchantTransactionId, merchantId });
        throw new AppError("Invalid checksum", 400);
    }

    webhookLog.info('VERIFIED', `Checksum verified`, { txnId: merchantTransactionId });

    const payments = await prisma.payment.findMany({
        where: { providerTxId: merchantTransactionId },
        include: { student: true }
    });

    if (payments.length === 0) {
        webhookLog.error('NOT_FOUND', `No payments found for transaction`, { txnId: merchantTransactionId });
        return;
    }

    if (code === 'PAYMENT_SUCCESS') {
        webhookLog.info('PAYMENT_SUCCESS', `Payment success callback`, { txnId: merchantTransactionId, count: payments.length });
        const needsUpdate = payments.some(p => p.status !== PaymentStatus.SUCCESS);
        if (needsUpdate) {
            await processMultiPaymentSuccess(payments, decodedPayload);
        } else {
            webhookLog.info('ALREADY_PROCESSED', `Payments already SUCCESS (idempotent)`, { txnId: merchantTransactionId });
        }
    } else {
        webhookLog.warn('PAYMENT_FAILED', `Payment failed callback`, { txnId: merchantTransactionId, code });
        await prisma.payment.updateMany({
            where: { providerTxId: merchantTransactionId },
            data: {
                status: PaymentStatus.FAILED,
                metadata: decodedPayload
            }
        });
    }

    return { status: 'OK' };
};

/**
 * New Standard Checkout Webhook Handler
 * PhonePe sends: { type, payload } with Authorization: SHA256(username:password)
 * Events: checkout.order.completed, checkout.order.failed, pg.refund.completed, pg.refund.failed
 */
export const handleNewWebhook = async (body: any, authHeader: string) => {
    // 1. Verify Authorization
    const webhookUsername = process.env.PHONEPE_WEBHOOK_USERNAME || '';
    const webhookPassword = process.env.PHONEPE_WEBHOOK_PASSWORD || '';

    if (!webhookUsername || !webhookPassword) {
        logger.error('[Webhook] PHONEPE_WEBHOOK_USERNAME or PHONEPE_WEBHOOK_PASSWORD not configured');
        throw new AppError('Webhook not configured', 500);
    }

    const expectedAuth = crypto.createHash('sha256').update(`${webhookUsername}:${webhookPassword}`).digest('hex');

    if (authHeader !== expectedAuth) {
        logger.error(`[Webhook] Invalid authorization. Received: ${authHeader?.substring(0, 20)}...`);
        throw new AppError('Invalid authorization', 401);
    }

    const { type, payload } = body;
    if (!type || !payload) {
        throw new AppError('Invalid webhook body: missing type or payload', 400);
    }

    const merchantOrderId = payload.merchantOrderId;
    const merchantId = payload.merchantId;

    logger.info(`[Webhook] Received event=${type} merchantOrderId=${merchantOrderId} merchantId=${merchantId}`);

    // 2. Find payments by merchantOrderId (this is our providerTxId)
    const payments = await prisma.payment.findMany({
        where: { providerTxId: merchantOrderId },
        include: { student: true }
    });

    if (payments.length === 0) {
        logger.warn(`[Webhook] No payments found for merchantOrderId=${merchantOrderId}`);
        return { status: 'OK', message: 'No matching payments' };
    }

    logger.info(`[Webhook] Found ${payments.length} payment(s) for merchantOrderId=${merchantOrderId}`);

    // 3. Process based on event type
    switch (type) {
        case 'checkout.order.completed': {
            const needsUpdate = payments.some(p => p.status !== PaymentStatus.SUCCESS);
            if (needsUpdate) {
                logger.info(`[Webhook] Processing SUCCESS for ${merchantOrderId}`);
                await processMultiPaymentSuccess(payments, payload);
            } else {
                logger.info(`[Webhook] Payments already SUCCESS for ${merchantOrderId} (idempotent)`);
            }
            break;
        }

        case 'checkout.order.failed': {
            const pendingPayments = payments.filter(p => p.status === PaymentStatus.PENDING);
            if (pendingPayments.length > 0) {
                logger.warn(`[Webhook] Processing FAILURE for ${merchantOrderId}, errorCode=${payload.errorCode}`);
                await prisma.payment.updateMany({
                    where: { providerTxId: merchantOrderId, status: PaymentStatus.PENDING },
                    data: {
                        status: PaymentStatus.FAILED,
                        metadata: { webhookEvent: type, errorCode: payload.errorCode, detailedErrorCode: payload.detailedErrorCode }
                    }
                });
            } else {
                logger.info(`[Webhook] No pending payments to fail for ${merchantOrderId}`);
            }
            break;
        }

        case 'pg.refund.completed': {
            logger.info(`[Webhook] Refund completed: refundId=${payload.refundId}, originalOrder=${payload.originalMerchantOrderId}, amount=${payload.amount}`);
            // TODO: Implement refund processing when refund flow is built
            break;
        }

        case 'pg.refund.failed': {
            logger.warn(`[Webhook] Refund failed: refundId=${payload.refundId}, originalOrder=${payload.originalMerchantOrderId}, error=${payload.errorCode}`);
            // TODO: Implement refund failure handling
            break;
        }

        default:
            logger.warn(`[Webhook] Unknown event type: ${type}`);
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
    const transactionId = `TXN_${Date.now()}_${studentId.replace(/-/g, '').substring(0, 6)}`;

    // 3. Calculate Dynamic Fees (Logic Updated for Split)
    const pendingDemands = await prisma.studentFeeDemand.findMany({
        where: { studentId, status: { not: 'FULL' } } // Fetch all pending/partial
    });
    
    // Check what is already paid logic might be complex if we use Ledger/Demands.
    // Simplifying: Check DB for successful payments OF SPECIFIC COMPONENTS.
    const paidComponents = await prisma.payment.findMany({
        where: { studentId, status: PaymentStatus.SUCCESS },
        select: { component: true, amount: true }
    });

    const paidAccommodation = paidComponents
        .filter(p => p.component === PaymentComponent.HOSTEL || p.component === PaymentComponent.HOSTEL_ACCOMMODATION)
        .reduce((sum, p) => sum + p.amount, 0);

    const paidMess = paidComponents
        .filter(p => p.component === PaymentComponent.HOSTEL_MESS)
        .reduce((sum, p) => sum + p.amount, 0);

    let collegeFee = (student.admissionDetails.totalFee ?? 0) > 0 ? (student.admissionDetails.totalFee ?? 0) : 25000;
    const paidCollege = paidComponents.filter(p => p.component === PaymentComponent.TUITION || p.component === PaymentComponent.SCHOLARSHIP_TOKEN).reduce((s,p) => s + p.amount, 0);
    collegeFee = Math.max(0, collegeFee - paidCollege);

    let accommodationFee = 0;
    let messFee = 0;
    let transportFee = 0;
    
    // Validate & Calculate Hostel Fee — pricing comes from HostelPriceCategory keyed by (sharing, roomType)
    if (hostelSelection?.hostelId) {
        const hostel = await prisma.hostel.findUnique({ where: { id: hostelSelection.hostelId } });
        if (!hostel) throw new AppError('Selected hostel not found', 404);

        if (hostelSelection.hostelType || hostelSelection.roomType) {
             const sharing = hostelSelection.hostelType === 'SHARING_4' ? 4 :
                             hostelSelection.hostelType === 'SHARING_8' ? 8 : 4;

             const priceCategory = await prisma.hostelPriceCategory.findFirst({
                 where: {
                     sharing: sharing,
                     roomType: hostelSelection.roomType
                 }
             });

             if (priceCategory) {
                 const isSemwise = student.admissionDetails.hostelPaymentMode === HostelPaymentMode.SEMWISE;
                 accommodationFee = (isSemwise ? priceCategory.accommodationSemwise : priceCategory.accommodationYearwise) ?? 0;
                 messFee = (isSemwise ? priceCategory.messSemwise : priceCategory.messYearwise) ?? 0;
             }
        }

        // Deduct paid
        accommodationFee = Math.max(0, accommodationFee - paidAccommodation);
        messFee = Math.max(0, messFee - paidMess);
    }

    if (transportSelection?.routeId) {
        const route = await prisma.transportRoute.findUnique({ where: { id: transportSelection.routeId } });
        if (!route) throw new AppError('Selected transport route not found', 404);
        // Check paid transport
        const paidTransport = paidComponents.filter(p => p.component === PaymentComponent.TRANSPORT).reduce((s,p) => s + p.amount, 0);
        transportFee = Math.max(0, route.cost - paidTransport);
    }

    // SEQUENTIAL PAYMENT LOGIC
    // Preference: 1. Tuition, 2. Transport, 3. Accommodation, 4. Mess
    // Actually, usually user pays "College Fee" (Tuition) first.
    // If user is selecting Hostel, they want to pay Hostel most likely.
    
    let amountToPay = 0;
    let paymentComponent: PaymentComponent = PaymentComponent.TUITION;

    // Logic: If Tuition/Transport is PENDING, pay that first? Or if user explicitly selected hostel?
    // The current input `data` has `hostelSelection`. If present, we assume Hostel Payment intent.
    // But usually this API pays EVERYTHING.
    // We must split.

    if (collegeFee > 0) {
        amountToPay = collegeFee;
        paymentComponent = PaymentComponent.TUITION;
    } else if (transportFee > 0) {
        amountToPay = transportFee;
        paymentComponent = PaymentComponent.TRANSPORT;
    } else if (accommodationFee > 0) {
        amountToPay = accommodationFee;
        paymentComponent = PaymentComponent.HOSTEL_ACCOMMODATION;
    } else if (messFee > 0) {
        amountToPay = messFee;
        paymentComponent = PaymentComponent.HOSTEL_MESS;
    } else {
        // Nothing to pay
        return { redirectUrl: null, message: "All fees paid" };
    }

    // 4. Process Logic (Update Selections if needed)
    await prisma.$transaction(async (tx) => {
        // Update Hostel/Transport Selections (Only if not already set/confirmed)
        // ... (Existing logic to update admissionDetails if provided) ...
        if (hostelSelection || transportSelection) {
            const updateData: any = {};
            if (hostelSelection?.hostelId) { updateData.hostelId = hostelSelection.hostelId; updateData.accommodationType = 'HOSTEL'; }
            if (transportSelection?.routeId) { updateData.accommodationType = 'TRANSPORT'; updateData.transportRouteId = transportSelection.routeId; }
            if (Object.keys(updateData).length > 0) {
                 await tx.studentAdmission.update({ where: { studentId }, data: updateData });
            }
        }
    });

    // 5. Create Payment Record
    const { feeHeadId, feeDemandId } = paymentDetails || {};
    const yearCtx = await resolveFeeDemandContext(feeDemandId);

    const payment = await prisma.payment.create({
        data: {
            studentId,
            amount: amountToPay,
            status: PaymentStatus.PENDING,
            component: paymentComponent,
            providerTxId: transactionId,
            idempotencyKey: `${transactionId}_${paymentComponent}`,
            method: paymentDetails?.paymentMode === 'PHONEPE' ? PaymentMethod.UPI : PaymentMethod.CASH,
            feeHeadId: feeHeadId || undefined,
            feeDemandId: feeDemandId || undefined,
            academicYearId: yearCtx.academicYearId,
            yearOfStudy: yearCtx.yearOfStudy,
        } as any
    });

    // PhonePe Integration — pick merchant from DB-driven banking config
    try {
        const redirectUrl = `${process.env.FRONTEND_URL}/payment/status?txnId=${transactionId}`;
        const feeType = await resolvePhonePeClientType(studentId, paymentComponent);
        const client = getPhonePeClient(feeType);

        const request = StandardCheckoutPayRequest.builder()
            .merchantOrderId(transactionId)
            // .amount(amountToPay * 100) // Original
            .amount(Math.round(amountToPay * 100)) // Safety round
            .redirectUrl(redirectUrl)
            .build();

        const response = await client.pay(request);
        return { redirectUrl: response.redirectUrl, totalAmount: amountToPay, paymentId: payment.id, component: paymentComponent };
    } catch (error: any) {
        logger.error(`PhonePe Payment Initiation Error (${paymentComponent}): ${error.message}`, error);
        await prisma.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.FAILED, metadata: { reason: 'GATEWAY_INIT_FAILED' } as any }
        });
        throw new AppError('Failed to initiate payment gateway', 502);
    }

};

// [Removed initiateAdminOnlinePayment] - Use processUnifiedPayment instead

/**
 * Admin: List all SUCCESS payments with pagination and filters.
 * Filters: search (applicationId/name/phone), component (feeType), mode,
 *          method, createdBy, dateRange (today|yesterday|7d|15d|30d|custom),
 *          startDate + endDate (if dateRange=custom), page, limit.
 */
export const getAllSuccessPayments = async (query: any) => {
    const page = Math.max(1, parseInt(String(query.page || 1)));
    const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || 25))));
    const skip = (page - 1) * limit;

    const where: any = {
        status: PaymentStatus.SUCCESS,
        isDeleted: false
    };

    // Global search — applicationId OR name OR phone
    const searchTerm = query.search || query.applicationId;
    if (searchTerm) {
        where.student = {
            OR: [
                { applicationId: { contains: String(searchTerm), mode: 'insensitive' } },
                { name: { contains: String(searchTerm), mode: 'insensitive' } },
                { phone: { contains: String(searchTerm) } }
            ]
        };
    }

    // Fee type / Component filter (supports comma-separated values, validate against enum)
    if (query.component || query.feeType) {
        const val = String(query.component || query.feeType);
        const values = val.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        const allowed = Object.values(PaymentComponent);
        const invalid = values.filter(v => !allowed.includes(v as PaymentComponent));
        if (invalid.length > 0) {
            throw new AppError(`Invalid fee type: ${invalid.join(', ')}. Allowed: ${allowed.join(', ')}`, 400);
        }
        where.component = values.length > 1 ? { in: values as PaymentComponent[] } : values[0] as PaymentComponent;
    }

    if (query.mode) {
        const v = String(query.mode).toUpperCase();
        if (!Object.values(PaymentMode).includes(v as PaymentMode)) {
            throw new AppError(`Invalid payment mode: ${v}. Allowed: ${Object.values(PaymentMode).join(', ')}`, 400);
        }
        where.mode = v;
    }

    if (query.method) {
        const v = String(query.method).toUpperCase();
        if (!Object.values(PaymentMethod).includes(v as PaymentMethod)) {
            throw new AppError(`Invalid payment method: ${v}. Allowed: ${Object.values(PaymentMethod).join(', ')}`, 400);
        }
        where.method = v;
    }

    if (query.createdBy) where.createdBy = String(query.createdBy);

    // Date range — preset or custom
    const dateRange = query.dateRange ? String(query.dateRange).toLowerCase() : null;
    if (dateRange && dateRange !== 'custom' && dateRange !== 'all') {
        const now = new Date();
        const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
        const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
        let gte: Date | undefined, lte: Date | undefined;

        if (dateRange === 'today') {
            gte = startOfDay(now); lte = endOfDay(now);
        } else if (dateRange === 'yesterday') {
            const y = new Date(now); y.setDate(now.getDate() - 1);
            gte = startOfDay(y); lte = endOfDay(y);
        } else if (dateRange === '7d') {
            const d = new Date(now); d.setDate(now.getDate() - 7);
            gte = startOfDay(d); lte = endOfDay(now);
        } else if (dateRange === '15d') {
            const d = new Date(now); d.setDate(now.getDate() - 15);
            gte = startOfDay(d); lte = endOfDay(now);
        } else if (dateRange === '30d') {
            const d = new Date(now); d.setDate(now.getDate() - 30);
            gte = startOfDay(d); lte = endOfDay(now);
        }
        if (gte && lte) where.createdAt = { gte, lte };
    } else if (query.startDate || query.endDate) {
        where.createdAt = {};
        if (query.startDate) {
            const s = new Date(String(query.startDate));
            s.setHours(0, 0, 0, 0);
            where.createdAt.gte = s;
        }
        if (query.endDate) {
            const e = new Date(String(query.endDate));
            e.setHours(23, 59, 59, 999);
            where.createdAt.lte = e;
        }
    }

    const [total, payments, totalSum] = await Promise.all([
        prisma.payment.count({ where }),
        prisma.payment.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            include: {
                student: {
                    select: {
                        id: true,
                        applicationId: true,
                        name: true,
                        phone: true,
                        email: true,
                        degreeType: true,
                        admissionDetails: {
                            select: {
                                allottedCourse: { select: { id: true, name: true } }
                            }
                        }
                    }
                },
                feeHead: { select: { id: true, name: true } }
            }
        }),
        prisma.payment.aggregate({ where, _sum: { amount: true } })
    ]);

    // Resolve createdBy user names in a single query
    const creatorIds = [...new Set(payments.map(p => p.createdBy).filter(Boolean) as string[])];
    const creators = creatorIds.length > 0
        ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } })
        : [];
    const creatorMap = Object.fromEntries(creators.map(c => [c.id, c.name]));

    // Convert invoice URLs to presigned + attach creator name + flatten allottedCourse
    const paymentsWithUrls = await Promise.all(payments.map(async p => {
        const allottedCourse = (p.student as any)?.admissionDetails?.allottedCourse ?? null;
        return {
            ...p,
            invoiceUrl: await convertToPresignedUrl(p.invoiceUrl),
            createdByName: p.createdBy ? (creatorMap[p.createdBy] || null) : null,
            allottedCourseName: allottedCourse?.name ?? null,
            allottedCourseId: allottedCourse?.id ?? null,
        };
    }));

    return {
        data: paymentsWithUrls,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        },
        summary: {
            totalTransactions: total,
            totalAmount: totalSum._sum.amount || 0
        }
    };
};

/**
 * Admin: Distinct payment components that actually have SUCCESS payments (for fee type dropdown).
 */
export const getPaymentComponents = async () => {
    const rows = await prisma.payment.findMany({
        where: { status: PaymentStatus.SUCCESS, isDeleted: false },
        select: { component: true },
        distinct: ['component']
    });
    return rows
        .map(r => r.component)
        .filter(Boolean)
        .sort();
};

/**
 * Admin: Get distinct list of users who have recorded SUCCESS payments (for filter dropdown).
 */
export const getPaymentCreators = async () => {
    const creatorIds = await prisma.payment.findMany({
        where: { status: PaymentStatus.SUCCESS, isDeleted: false, createdBy: { not: null } },
        select: { createdBy: true },
        distinct: ['createdBy']
    });
    const ids = creatorIds.map(c => c.createdBy!).filter(Boolean);
    if (ids.length === 0) return [];
    return prisma.user.findMany({
        where: {
            id: { in: ids },
            role: { not: 'STUDENT' }
        },
        select: { id: true, name: true, role: true },
        orderBy: { name: 'asc' }
    });
};

/**
 * Admin: Export SUCCESS payments to CSV (respects same filters as getAllSuccessPayments).
 */
export const exportSuccessPaymentsCsv = async (query: any) => {
    // Fetch all matching (no pagination)
    const result = await getAllSuccessPayments({ ...query, page: 1, limit: 100000 });
    const rows = result.data;

    const headers = [
        'UTR No', 'Application No', 'Full Name', 'Phone',
        'Fee Type', 'Mode', 'Method', 'Amount',
        'Date & Time', 'Created By', 'Remarks'
    ];

    const escape = (v: any) => {
        if (v === null || v === undefined) return '';
        const s = String(v).replace(/"/g, '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
    };

    const csvRows = rows.map((p: any) => [
        p.referenceNumber || p.providerTxId || '',
        p.student?.applicationId || '',
        p.student?.name || '',
        p.student?.phone || '',
        p.component || '',
        p.mode || '',
        p.method || '',
        p.amount,
        p.createdAt ? new Date(p.createdAt).toISOString() : '',
        p.createdByName || '',
        (p.metadata as any)?.remarks || ''
    ].map(escape).join(','));

    return [headers.join(','), ...csvRows].join('\n');
};

export const requestDiscount = async (studentId: string, reason: string, amount: number, documentUrl?: string, userId?: string | null) => {
     // Prevent duplicate pending discount requests
     const pendingRequest = await prisma.discountRequest.findFirst({
         where: {
             studentId,
             status: { in: [DiscountStatus.REQUESTED, DiscountStatus.FORWARDED_TO_SUPER_ADMIN] }
         },
         select: { id: true }
     });
     if (pendingRequest) {
         throw new AppError(`A discount request is already pending for this student (ID: ${pendingRequest.id}). Approve or reject it before raising a new one.`, 409);
     }

     // Default item structure for legacy requestDiscount
     const items = [{ component: 'OTHER', amount: Number(amount) }];

     return prisma.discountRequest.create({
            data: {
                studentId,
                reason,
                requestedAmount: Number(amount),
                documentUrl,
                items: items as any,
                status: DiscountStatus.REQUESTED,
                createdBy: userId || undefined
            } as any
        });
};

export const approveDiscount = async (requestId: string, approvedAmount: number, component: string, adminId: string, remarks?: string) => {
    const request = await prisma.discountRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppError('Discount Request not found', 404);
    if (request.status !== DiscountStatus.REQUESTED) throw new AppError('Request already processed', 400);

    const approvedItems = [{ component, approvedAmount }];

    return await prisma.$transaction(async (tx) => {
         const updated = await tx.discountRequest.update({
            where: { id: requestId },
            data: {
                status: DiscountStatus.APPROVED,
                approvedAmount,
                component, // Maintain legacy field if needed or ignore
                items: approvedItems as any,
                remarks,
                approvedBy: adminId,
                approvedAt: new Date()
            } as any
         });
         
         // Create Ledger Entry
         // Logic to find demand is skipped here for simplicity as this is legacy approve flow, 
         // but ideally should match FeeService logic.
         // Let's just create Ledger Entry as before.
         
         await tx.studentLedger.create({
            data: {
                studentId: request.studentId,
                type: 'CREDIT' as any,
                amount: approvedAmount,
                description: `Discount Approved - ${component} (${remarks || 'Admin Approval'})`,
                referenceId: updated.id,
                referenceType: 'DISCOUNT',
                createdBy: adminId,
                // feeHeadId: ??? Find it?
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
            await processSinglePaymentSuccess(payment, payment.metadata);
            
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

    const presignedUrl = await convertToPresignedUrl(payment.invoiceUrl);
    if (!presignedUrl) {
         throw new AppError('Invalid invoice URL format', 500);
    }
    
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
    return await convertToPresignedUrl(doc.url) || doc.url;
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

    const transactionId = `TOK_${Date.now()}_${studentId.replace(/-/g, '').substring(0, 6)}`;

    const createdPayment = await prisma.payment.create({
        data: {
            studentId,
            amount: TOKEN_AMOUNT,
            status: PaymentStatus.PENDING,
            component: PaymentComponent.SCHOLARSHIP_TOKEN,
            providerTxId: transactionId,
            idempotencyKey: `${transactionId}_SCHOLARSHIP_TOKEN`,
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
        await prisma.payment.update({
            where: { id: createdPayment.id },
            data: { status: PaymentStatus.FAILED, metadata: { reason: 'GATEWAY_INIT_FAILED' } as any }
        });
        throw new AppError('Failed to initiate payment gateway', 502);
    }
};

// [REMOVED] Old getStudentFinancialHistory replaced by enhanced version below


export const getStudentFinancialSummary = async (studentId: string) => {
    // 1. Fetch Student Config & Admission Details (incl. frozen pricing snapshot)
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            admissionDetails: {
                include: {
                    hostel: { include: { rooms: true } },
                    transportRoute: true
                }
            }
        }
    }) as any;

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

    logger.info(`[FinancialSummary] Student: ${studentId}, HostelType: ${student.admissionDetails.hostelType}, Mode: ${student.admissionDetails.hostelPaymentMode}`);

    // Hostel Cost — single source of truth via getOrCreateAccommodationPricing.
    // Auto-creates snapshot for fully-allocated students who don't have one yet;
    // returns null for students without a bed (hostelFee stays 0 — correct).
    const snap = await getOrCreateAccommodationPricing(studentId);
    if (snap) {
        hostelFee = (snap.accommodationPrice ?? 0)
                    + (snap.messPrice ?? 0)
                    + (snap.laundryPrice ?? 0)
                    + (snap.registrationFee ?? 0);
        logger.info(`[FinancialSummary] Snapshot used: total=${hostelFee} (mode=${snap.paymentMode})`);
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
        else if (p.component === PaymentComponent.HOSTEL
                 || p.component === PaymentComponent.HOSTEL_ACCOMMODATION
                 || p.component === PaymentComponent.HOSTEL_MESS
                 || p.component === PaymentComponent.HOSTEL_LAUNDRY
                 || p.component === PaymentComponent.HOSTEL_REGISTRATION) paidBreakdown.hostel += p.amount;
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
        PaymentComponent.HOSTEL_ACCOMMODATION,
        PaymentComponent.HOSTEL_MESS,
        PaymentComponent.HOSTEL_LAUNDRY,
        PaymentComponent.HOSTEL_REGISTRATION,
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
                convenorDetails: true,
                scholarshipAllocation: { include: { rule: true } },
                studentScholarship: true
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
             
             // Check Pending Fee
             const financialHistory = await getStudentFinancialHistory(studentId);
             const { summary, breakdown } = financialHistory;
             const totalPending = summary.totalPending;

             // Extract Fee and Scholarship Details
             const tuitionFee = breakdown['TUITION']?.demanded || 0;
             let scholarshipDiscount = breakdown['TUITION']?.discount || 0; // Discount applied to Tuition
             
             let scholarshipPercentage = student.scholarshipAllocation?.rule?.discountPercentage || 0;
             if (student.studentScholarship?.scholarshipPercentage) {
                scholarshipPercentage = student.studentScholarship.scholarshipPercentage;
             }

             if (scholarshipDiscount === 0 && scholarshipPercentage > 0 && tuitionFee > 0) {
                scholarshipDiscount = (tuitionFee * scholarshipPercentage) / 100;
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
                profilePhotoUrl: profilePhotoUrl,
                totalPending: totalPending,
                scholarshipPercentage,
                scholarshipDiscount,
                tuitionFee,
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

/**
 * Generate + save the Hostel Allotment Order PDF for a student.
 *
 * Reads the frozen pricing snapshot (StudentAccommodationPricing) so the document
 * shows what THIS student locked in at allocation time. Upserts under StudentDocument
 * key 'HOSTEL_ALLOTMENT_ORDER' — re-running (e.g. after re-assignment) replaces the
 * file at S3 and refreshes the row.
 *
 * Best-effort: never throws. Failure is logged and the calling flow continues.
 */
export async function generateAndSaveHostelAllotmentOrder(studentId: string) {
    try {
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                admissionDetails: true,
                accommodationPricing: { where: { isActive: true }, take: 1 },
            } as any,
        }) as any;

        if (!student?.admissionDetails) {
            logger.warn(`[HostelAllotment] Student ${studentId} has no admission record — skipping`);
            return;
        }
        const snap = student.accommodationPricing?.[0] ?? null;
        if (!snap) {
            logger.warn(`[HostelAllotment] Student ${studentId} has no active accommodation snapshot — skipping (bed not yet allocated?)`);
            return;
        }

        const admission = student.admissionDetails;

        // Pull hostel + the allocated bed for warden + floor + bed number
        const hostel = admission.hostelId
            ? await prisma.hostel.findUnique({ where: { id: admission.hostelId } })
            : null;

        const allocation = await (prisma.hostelAllocation as any).findFirst({
            where: { studentId, status: 'ACTIVE' },
            include: { bed: { include: { room: true } } }
        });

        let profilePhotoUrl: string | undefined;
        if (student.profilePhotoUrl) {
            profilePhotoUrl = (await convertToPresignedUrl(student.profilePhotoUrl)) || undefined;
        }

        const reportingDate = new Date();
        reportingDate.setDate(reportingDate.getDate() + 7);

        const allotmentData = {
            applicationId: student.applicationId ?? '',
            studentName: student.name,
            fatherName: student.fatherName,
            motherName: student.motherName,
            gender: student.gender,
            state: student.state || 'Andhra Pradesh',

            hostelName: hostel?.name || 'Hostel',
            hostelType: hostel?.type || 'BOYS',
            roomNumber: admission.roomNumber || allocation?.bed?.room?.number || '—',
            bedNumber: allocation?.bed?.number || '—',
            floor: allocation?.bed?.room?.floor,
            sharing: snap.sharing,
            roomType: snap.roomType,
            paymentMode: (snap.paymentMode as 'YEARWISE' | 'SEMWISE') || 'YEARWISE',
            wardenName: hostel?.wardenName || undefined,

            accommodationPrice: snap.accommodationPrice ?? 0,
            messPrice: snap.messPrice ?? 0,
            laundryPrice: snap.laundryPrice ?? 0,
            registrationFee: snap.registrationFee ?? 0,
            effectiveTotal: snap.effectiveTotal ?? 0,

            profilePhotoUrl,
            reportingDate: format(reportingDate, 'dd.MM.yyyy'),
        };

        const pdfBuffer = await generateHostelAllotmentOrderPDF(allotmentData);
        const timestamp = Date.now();
        const s3Key = `student/${student.phone}/documents/HostelAllotmentOrder_${timestamp}.pdf`;
        const url = await uploadFileToS3(pdfBuffer, s3Key, 'application/pdf');

        await prisma.studentDocument.upsert({
            where: {
                studentId_documentKey: {
                    studentId,
                    documentKey: 'HOSTEL_ALLOTMENT_ORDER',
                },
            },
            create: {
                studentId,
                documentKey: 'HOSTEL_ALLOTMENT_ORDER',
                url,
                status: StudentDocumentStatus.APPROVED,
                remarks: 'Generated on hostel bed allocation',
            },
            update: {
                url,
                status: StudentDocumentStatus.APPROVED,
                remarks: 'Refreshed on bed allocation / re-assignment',
            },
        });

        logger.info(`[HostelAllotment] Generated for student ${studentId}: ${url}`);
    } catch (err) {
        logger.error(`[HostelAllotment] Failed to generate for student ${studentId}: ${err}`);
    }
}

// Step 4. Unified Payment Processor
export const processUnifiedPayment = async (data: any) => {
    const { studentId, amount, mode, method, component: rawComponent, feeHeadId: rawFeeHeadId, remarks, initiatedBy, referenceNumber, redirectUrl } = data;
    logger.info(`[processUnifiedPayment] START - StudentId=${studentId}, Amount=${amount}, Mode=${mode}, Method=${method}, Component=${rawComponent}, InitiatedBy=${initiatedBy}`);
   
    // Resolve Component
    logger.debug(`[processUnifiedPayment] Resolving component: ${rawComponent}`);
    const { component, feeHeadId } = await resolveComponent(rawComponent, rawFeeHeadId);
    logger.info(`[processUnifiedPayment] Component resolved to: ${component}, FeeHeadId=${feeHeadId || 'N/A'}`);


    // 0. Strict Input Validation
    if (!studentId) throw new AppError('Student ID is required', 400);
    if (!amount || typeof amount !== 'number' || amount <= 0) throw new AppError('Amount must be a positive number', 400);
    
    if (!Object.values(PaymentMode).includes(mode)) {
        throw new AppError(`Invalid Payment Mode. Allowed: ${Object.values(PaymentMode).join(', ')}`, 400);
    }


    if (mode === PaymentMode.OFFLINE && !referenceNumber) {
        throw new AppError('Reference Number is required for OFFLINE payments', 400);
    }

    // Check for Duplicate Reference Number (OFFLINE ONLY, skip for CASH)
    if (mode === PaymentMode.OFFLINE && referenceNumber && data.method !== PaymentMethod.CASH) {
        const existingRef = await prisma.payment.findFirst({
            where: { referenceNumber: referenceNumber }
        });
        if (existingRef) {
            throw new AppError(`Payment with Reference Number '${referenceNumber}' already exists`, 409);
        }
    }



    // 1. Validate Student
    logger.debug(`[processUnifiedPayment] Looking up student: ${studentId}`);
    const student = await prisma.student.findUnique({ 
        where: { id: studentId },
        include: { admissionDetails: true }
    });
    if (!student) {
        logger.error(`[processUnifiedPayment] Student not found: ${studentId}`);
        throw new AppError('Student not found', 404);
    }
    logger.info(`[processUnifiedPayment] Student found: ${student.name} (${student.applicationId})`);


    // 2. Validate Fee Head - Mandatory (Exempting specific types)
    const exemptFromFeeHead: PaymentComponent[] = [
        PaymentComponent.HOSTEL,
        PaymentComponent.HOSTEL_ACCOMMODATION,
        PaymentComponent.HOSTEL_MESS,
        PaymentComponent.HOSTEL_LAUNDRY,
        PaymentComponent.HOSTEL_REGISTRATION,
        PaymentComponent.TRANSPORT,
        PaymentComponent.OTHER,
        PaymentComponent.COURSE_CHANGE_FEE
    ];

    if (!feeHeadId && !exemptFromFeeHead.includes(component)) {
        throw new AppError(`Fee Head ID is mandatory for ${component}`, 400);
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
    logger.info(`[processUnifiedPayment] Transaction ID generated: ${providerTxId}`);

    // 4. Create Payment Record
    logger.info(`[processUnifiedPayment] Creating payment record with status=PENDING`);

    const payment = await prisma.payment.create({
        data: {
            studentId,
            amount,
            mode,
            method: method || (mode === PaymentMode.ONLINE ? PaymentMethod.UPI : PaymentMethod.CASH),
            status: PaymentStatus.PENDING,
            component,
            referenceNumber,
            feeHeadId,
            providerTxId,
            idempotencyKey: `${providerTxId}_${component}`,
            collectedBy: initiatedBy,
            createdBy: initiatedBy, // Strict data
            metadata: { remarks, source: 'UNIFIED_API' }
        }
    });

    logger.info(`[processUnifiedPayment] Payment record created: ID=${payment.id}, Status=${payment.status}`);

    // 5. Handle Offline Success Immediate Processing
    if (mode === PaymentMode.OFFLINE) {
        logger.info(`[processUnifiedPayment] Processing OFFLINE payment immediately`);
        // Reuse Success Logic (Ledger, Invoice, Email)
        const successResult = await processSinglePaymentSuccess({ ...payment, student }, { remarks, adminId: initiatedBy });
        
        const presignedInvoiceUrl = await convertToPresignedUrl(successResult?.invoiceUrl);
        logger.info(`[processUnifiedPayment] OFFLINE payment processed successfully. InvoiceUrl=${presignedInvoiceUrl ? 'Generated' : 'N/A'}`);


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
            const path = redirectUrl ?? '/admin/fees/offlinepayments';
            const queryParams = redirectUrl 
                ? `studentId=${student.id}&paymentId=${payment.id}`
                : `appId=${student.applicationId}&paymentId=${payment.id}`;
            const finalRedirectUrl = `${process.env.FRONTEND_URL_ADMISSION}${path}?${queryParams}`;
            
            logger.info(`[processUnifiedPayment] Initiating online payment: Amount=₹${amount}, FinalUrl=${finalRedirectUrl}`);
            
            // Pick PhonePe merchant from DB-driven banking config (Hostel.<component>Bank)
            const feeType = await resolvePhonePeClientType(studentId, component);
            const client = getPhonePeClient(feeType);

            const request = StandardCheckoutPayRequest.builder()
                .merchantOrderId(providerTxId)
                .amount(Math.round(amount * 100))
                .redirectUrl(finalRedirectUrl)
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
// Enhanced History
export const getStudentFinancialHistory = async (
    studentId: string,
    options: { academicYearId?: string } = {}
) => {
    const { academicYearId } = options;

    // 1. Parallel Data Fetching
    // 1. Fetch Student Details First (Required for context)
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            admissionDetails: {
                include: {
                    hostel: { include: { rooms: true } },
                    transportRoute: true
                }
            }
        }
    }) as any;

    // 2. Fetch Configuration Data
    const allFeeHeads = await prisma.feeHead.findMany();

    // 3. Fetch Financial Records (Parallel).
    // When `academicYearId` is set, every per-year-tagged record is filtered to that
    // year. Records that have no `academicYearId` (older payments / ledger entries
    // pre-denormalization) are still included so reports remain complete.
    const yearFilter = academicYearId
        ? { academicYearId }
        : {};
    const yearOrNullFilter = academicYearId
        ? { OR: [{ academicYearId }, { academicYearId: null }] }
        : {};

    const [ledgers, payments, feeDemands, feeCorrections] = await Promise.all([
        prisma.studentLedger.findMany({
            where: { studentId, isDeleted: false, ...yearOrNullFilter },
            orderBy: { date: 'desc' }
        }),
        prisma.payment.findMany({
            where: { studentId, status: PaymentStatus.SUCCESS, isDeleted: false, ...yearOrNullFilter },
            include: {
                feeDemand: {
                    include: { feeStructure: { include: { feeHead: true } } }
                }
            }
        }),
        prisma.studentFeeDemand.findMany({
            where: { studentId, isDeleted: false, ...yearOrNullFilter },
            include: {
                feeStructure: { include: { feeHead: true } },
                feeHead: true
            }
        }),
        (prisma as any).feeCorrection.findMany({
            where: { studentId, ...yearFilter },
            orderBy: { createdAt: 'desc' },
        }),
    ]);

    logger.info(`[FinancialHistory] Data Fetched. Ledgers: ${ledgers.length}, Payments: ${payments.length}, Demands: ${feeDemands.length}, FeeCorrections: ${feeCorrections.length}`);

    // 2. Initialize Breakdown
    const categories = ['HOSTEL_ACCOMMODATION', 'HOSTEL_MESS', 'HOSTEL_LAUNDRY', 'HOSTEL_REGISTRATION', 'TRANSPORT', 'TUITION', 'BOOK_BANK', 'ADMISSION', 'OTHER'];
    const breakdown: Record<string, { demanded: number, paid: number, fine: number, discount: number, scholarshipAmount: number, feeHeadId: string }> = {};
    categories.forEach(cat => {
        breakdown[cat] = { demanded: 0, paid: 0, fine: 0, discount: 0, scholarshipAmount: 0, feeHeadId: '' };
    });

    // 3. Helper: Map FeeHead → category bucket.
    // Strict: only the explicit `feeHead.component` enum is honored. FeeHeads
    // without a component are bucketed as 'OTHER' (run the backfill SQL to tag them).
    const getCategoryForHead = (h: { component?: PaymentComponent | null }): string => {
        return h.component ? (h.component as string) : 'OTHER';
    };

    // Fee Head ID -> Category Map
    const feeHeadCategoryMap = new Map<string, string>();
    allFeeHeads.forEach((h: any) => feeHeadCategoryMap.set(h.id, getCategoryForHead(h)));

    // 4. DEMAND CALCULATION (From Fee Tables)
    feeDemands.forEach((demand: any) => {
        // Demands link a FeeHead either directly (hostel/transport) or via FeeStructure (course tuition).
        const headId = demand.feeHeadId ?? demand.feeStructure?.feeHeadId;
        const head = demand.feeHead ?? demand.feeStructure?.feeHead;
        let category: string | undefined;

        if (headId) category = feeHeadCategoryMap.get(headId);
        if (!category && head) {
             category = getCategoryForHead(head);
             if (headId) feeHeadCategoryMap.set(headId, category);
        }

        const catKey = category || 'OTHER';
        // Make sure catKey exists in breakdown (handle potential old 'HOSTEL' mapping)
        let targetKey = catKey;
        if (!breakdown[targetKey]) {
            if (targetKey === 'HOSTEL') targetKey = 'HOSTEL_ACCOMMODATION';
            else targetKey = 'OTHER';
        }

        const target = breakdown[targetKey];
        
        target.demanded += demand.amount;
        // Credit applied at demand creation (e.g. previously-paid amount carried into a reassign/switch demand).
        // Without this, "pending" miscounts demands that are already fully covered by prior payments.
        target.discount += demand.discountAmount ?? 0;
        if (demand.scholarshipAmount) target.scholarshipAmount += demand.scholarshipAmount;
        if (demand.fineAmount) target.fine += demand.fineAmount;
        if (headId && !target.feeHeadId) target.feeHeadId = headId;
    });

    // 5. Override hostel/transport demands using the per-student frozen snapshot.
    //    `getOrCreateAccommodationPricing` is the single source of truth — it returns
    //    the existing snapshot, auto-creates one for fully-allocated students who don't
    //    have one yet (legacy/manual data), or returns null when the student isn't yet
    //    bed-allocated (correct: hostel demand stays 0).
    if (student && student.admissionDetails) {
        const admission = student.admissionDetails;

        // When override fires, both `demanded` and `discount` come from the active demand
        // for the active snapshot/route — NOT the demand-row aggregation, which sums
        // historical reassign churn (FULL demands with discount=full amount, netAmount=0)
        // and would inflate `discount` past `demanded`. Active discount = sum of
        // discountAmount on PENDING/PARTIAL demands of the matching feeHead.
        const activeDiscountForFeeHead = (feeHeadId: string | undefined): number => {
            if (!feeHeadId) return 0;
            return feeDemands
                .filter((d: any) =>
                    d.feeHeadId === feeHeadId
                    && !d.isDeleted
                    && d.status !== FeeStatus.FULL
                )
                .reduce((sum: number, d: any) => sum + (d.discountAmount ?? 0), 0);
        };

        // Hostel override only when the student is currently on HOSTEL. If they switched to
        // TRANSPORT/NONE, an old snapshot must not synthesize HOSTEL_* demand lines — the
        // demand-row aggregation above is the authoritative source for those rows.
        if (admission.accommodationType === AccommodationType.HOSTEL) {
            const snapshot = await getOrCreateAccommodationPricing(studentId);
            if (snapshot) {
                breakdown.HOSTEL_ACCOMMODATION.demanded = snapshot.accommodationPrice ?? 0;
                breakdown.HOSTEL_ACCOMMODATION.discount = activeDiscountForFeeHead(breakdown.HOSTEL_ACCOMMODATION.feeHeadId);
                breakdown.HOSTEL_MESS.demanded          = snapshot.messPrice ?? 0;
                breakdown.HOSTEL_MESS.discount          = activeDiscountForFeeHead(breakdown.HOSTEL_MESS.feeHeadId);
                breakdown.HOSTEL_LAUNDRY.demanded       = snapshot.laundryPrice ?? 0;
                breakdown.HOSTEL_LAUNDRY.discount       = activeDiscountForFeeHead(breakdown.HOSTEL_LAUNDRY.feeHeadId);
                breakdown.HOSTEL_REGISTRATION.demanded  = snapshot.registrationFee ?? 0;
                breakdown.HOSTEL_REGISTRATION.discount  = activeDiscountForFeeHead(breakdown.HOSTEL_REGISTRATION.feeHeadId);
            }
            // else: student has no bed yet → all hostel buckets remain 0 (correct)

            // Student is on HOSTEL — any TRANSPORT demand rows are stale (from a prior
            // H→T switch that was reversed). Zero the bucket so it doesn't inflate totals.
            breakdown.TRANSPORT.demanded = 0;
            breakdown.TRANSPORT.discount = 0;
        }

        // Transport — uses live route.cost (no snapshot model for transport pricing).
        // Discount is reset to the active PENDING demand's discount, same reasoning as hostel.
        if (admission.accommodationType === AccommodationType.TRANSPORT
            && admission.transportRouteId && admission.transportRoute) {
            breakdown.TRANSPORT.demanded = admission.transportRoute.cost;
            breakdown.TRANSPORT.discount = activeDiscountForFeeHead(breakdown.TRANSPORT.feeHeadId);

            // Mirror inverse: zero hostel buckets so stale snapshots/demands don't leak
            breakdown.HOSTEL_ACCOMMODATION.demanded = 0;
            breakdown.HOSTEL_ACCOMMODATION.discount = 0;
            breakdown.HOSTEL_MESS.demanded          = 0;
            breakdown.HOSTEL_MESS.discount          = 0;
            breakdown.HOSTEL_LAUNDRY.demanded       = 0;
            breakdown.HOSTEL_LAUNDRY.discount       = 0;
            breakdown.HOSTEL_REGISTRATION.demanded  = 0;
            breakdown.HOSTEL_REGISTRATION.discount  = 0;
        }

        // NONE — student has no active accommodation; both buckets must be 0
        if (admission.accommodationType !== AccommodationType.HOSTEL
            && admission.accommodationType !== AccommodationType.TRANSPORT) {
            breakdown.HOSTEL_ACCOMMODATION.demanded = 0;
            breakdown.HOSTEL_ACCOMMODATION.discount = 0;
            breakdown.HOSTEL_MESS.demanded          = 0;
            breakdown.HOSTEL_MESS.discount          = 0;
            breakdown.HOSTEL_LAUNDRY.demanded       = 0;
            breakdown.HOSTEL_LAUNDRY.discount       = 0;
            breakdown.HOSTEL_REGISTRATION.demanded  = 0;
            breakdown.HOSTEL_REGISTRATION.discount  = 0;
            breakdown.TRANSPORT.demanded            = 0;
            breakdown.TRANSPORT.discount            = 0;
        }
    }

    // 6. LEDGER ADJUSTMENTS (Discounts, Scholarships)
    // Reassign/cancellation/switch CREDITs are mirrored as FeeCorrection refund rows;
    // counting them here would double-account against `correctionSummary`.
    const REFUND_LIKE_REFERENCE_TYPES = new Set([
        'CANCELLATION',
        'HOSTEL_REASSIGNMENT',
        'HOSTEL_CANCELLATION',
        'TRANSPORT_REASSIGNMENT',
        'TRANSPORT_CANCELLATION',
        'ACCOMMODATION_SWITCH',
        'WAIVER',  // app-fee waivers (e.g., lateral + management quota); shown separately, not as discount
    ]);
    ledgers.forEach(entry => {
        // Skip cancellation/reassign/switch — those are reflected in FeeCorrection, not here.
        if (REFUND_LIKE_REFERENCE_TYPES.has(entry.referenceType as string)) return;

        // Strict: bucket by feeHeadId only. Ledger entries without a feeHeadId
        // bucket as OTHER (no description keyword fallback).
        const category = entry.feeHeadId
            ? (feeHeadCategoryMap.get(entry.feeHeadId) ?? 'OTHER')
            : 'OTHER';

        let key = category;
        if (!breakdown[key]) {
             if (key === 'HOSTEL') key = 'HOSTEL_ACCOMMODATION';
             else key = 'OTHER';
        }

        const target = breakdown[key];

        // Fines (Skipped as per existing logic logic if in Deamnd)

        // Credits (Discounts/Scholarships) — FEE_CORRECTION is carry-forward adjustment, not a discount
        if (entry.type === 'CREDIT' && entry.referenceType !== 'PAYMENT' && entry.referenceType !== 'COURSE_CHANGE' && entry.referenceType !== 'FEE_CORRECTION') {
            target.discount += entry.amount;
        }

        // Scholarship reversal DEBIT — reduces discount
        if (entry.type === 'DEBIT' && entry.referenceType === 'SCHOLARSHIP') {
            target.discount -= entry.amount;
        }

        // Course change processing fee — DEBIT reduces paid on the source category (tuition)
        if (entry.referenceType === 'COURSE_CHANGE' && entry.type === 'DEBIT') {
            target.paid -= entry.amount;
        }
    });

    // 7. PAID CALCULATION
    payments.forEach(p => {
         if (p.component === PaymentComponent.APPLICATION_FEE) return; // Skip Application Fee

         let key = 'OTHER';
         if (p.feeDemand?.feeStructure?.feeHead) {
             key = getCategoryForHead(p.feeDemand.feeStructure.feeHead);
         } else if (p.feeHeadId && feeHeadCategoryMap.has(p.feeHeadId)) {
             key = feeHeadCategoryMap.get(p.feeHeadId) || 'OTHER';
         } else {
             const comp = p.component || 'OTHER';
             if (comp === PaymentComponent.SCHOLARSHIP_TOKEN) key = 'ADMISSION';
             else if (comp === PaymentComponent.HOSTEL_ACCOMMODATION) key = 'HOSTEL_ACCOMMODATION';
             else if (comp === PaymentComponent.HOSTEL_MESS) key = 'HOSTEL_MESS';
             else if (comp === PaymentComponent.HOSTEL) key = 'HOSTEL_ACCOMMODATION'; // Fallback
             else key = comp as string;
         }
         
         if (!breakdown[key]) {
             if (key.includes('HOSTEL')) key = 'HOSTEL_ACCOMMODATION';
             else if (key.includes('MESS')) key = 'HOSTEL_MESS';
             else key = 'OTHER';
         }
         
         const target = breakdown[key] || breakdown['OTHER'];
         target.paid += p.amount;
         if (p.feeHeadId && !target.feeHeadId) target.feeHeadId = p.feeHeadId;
    });

    // 8. FINAL SUMMARY
    const totalDemanded = Object.values(breakdown).reduce((sum, cat) => sum + cat.demanded, 0);

    // Course change DEBIT reduces effective paid (processing fee deducted from tuition)
    const courseChangeDeduction = ledgers
        .filter(l => l.referenceType === 'COURSE_CHANGE' && l.type === 'DEBIT')
        .reduce((sum, l) => sum + l.amount, 0);
    const totalPaid = payments
        .filter(p => p.component !== PaymentComponent.APPLICATION_FEE)
        .reduce((sum, p) => sum + p.amount, 0) - courseChangeDeduction;
    const scholarshipCredits = ledgers
        .filter(l =>
            l.type === 'CREDIT'
            && l.referenceType !== 'PAYMENT'
            && l.referenceType !== 'COURSE_CHANGE'
            && l.referenceType !== 'FEE_CORRECTION'
            && !REFUND_LIKE_REFERENCE_TYPES.has(l.referenceType as string)
        )
        .reduce((sum, l) => sum + l.amount, 0);
    const scholarshipReversals = ledgers
        .filter(l => l.type === 'DEBIT' && l.referenceType === 'SCHOLARSHIP')
        .reduce((sum, l) => sum + l.amount, 0);
    const totalDiscount = Math.max(0, scholarshipCredits - scholarshipReversals);

    const summary = {
        totalDemanded,
        totalPaid,
        totalDiscount,
        courseChangeFee: courseChangeDeduction,
        totalPending: Math.max(0, totalDemanded - totalPaid - totalDiscount)
    };
    
    // Generate presigned URLs for payments
    const paymentsWithUrls = await Promise.all(payments.map(async (p) => {
        return {
            ...p,
            invoiceUrl: await convertToPresignedUrl(p.invoiceUrl)
        };
    }));

    // Log formatted table for debugging
    const tableData = Object.keys(breakdown).map(key => ({
        Category: key,
        Demanded: breakdown[key].demanded,
        Paid: breakdown[key].paid,
        Discount: breakdown[key].discount,
        Fine: breakdown[key].fine, 
        Pending: Math.max(0, breakdown[key].demanded - breakdown[key].paid - breakdown[key].discount)
    }));
    
    console.log(`\n=== Financial History Table [Student: ${studentId}] ===`);
    console.table(tableData);
    console.log('======================================================\n');

    // Fee correction summary: pending refunds (isSettled=false) and total settled
    const pendingRefunds = (feeCorrections as any[]).filter(fc => !fc.isSettled);
    const settledRefunds = (feeCorrections as any[]).filter(fc => fc.isSettled);
    const correctionSummary = {
        total: feeCorrections.length,
        pendingCount: pendingRefunds.length,
        pendingTotal: pendingRefunds.reduce((s: number, fc: any) => s + (fc.amount ?? 0), 0),
        settledCount: settledRefunds.length,
        settledTotal: settledRefunds.reduce((s: number, fc: any) => s + (fc.amount ?? 0), 0),
    };

    return {
        summary,
        breakdown,
        ledger: ledgers,
        payments: paymentsWithUrls,
        feeCorrections,
        correctionSummary,
    };
};

/**
 * Get a chronological flowchart of all financial events for a student.
 * Returns a timeline that clearly explains: what happened, when, how much, and the running balance.
 */
export const getStudentFinancialFlow = async (studentId: string) => {
    // Fetch all data in parallel
    const [student, ledgers, allFeeHeads, courseChangeLogs, scholarship, scholarshipAuditLogs] = await Promise.all([
        prisma.student.findUnique({
            where: { id: studentId },
            select: {
                id: true,
                name: true,
                applicationId: true,
                admissionDetails: {
                    select: {
                        status: true,
                        seatAllottedAt: true,
                        allottedCourse: { select: { name: true, degree: true } },
                        hostelType: true,
                        accommodationType: true,
                    }
                }
            }
        }),
        prisma.studentLedger.findMany({
            where: { studentId, isDeleted: false },
            orderBy: { date: 'asc' },
        }),
        prisma.feeHead.findMany({ select: { id: true, name: true } }),
        prisma.courseChangeLog.findMany({
            where: { studentId },
            orderBy: { date: 'asc' }
        }),
        prisma.studentScholarship.findUnique({
            where: { studentId },
            select: { id: true, scholarshipPercentage: true, type: true, createdAt: true }
        }),
        // Fetch audit logs for scholarship changes (CREATE + UPDATE)
        prisma.auditLog.findMany({
            where: { entity: 'StudentScholarship', action: { in: ['CREATE', 'UPDATE'] } },
            orderBy: { timestamp: 'asc' },
            select: { action: true, timestamp: true, details: true, entityId: true }
        })
    ]);

    // Build feeHeadId -> name map for resolving ledger entries
    const feeHeadMap = new Map<string, string>();
    allFeeHeads.forEach(h => feeHeadMap.set(h.id, h.name));

    if (!student) throw new AppError('Student not found', 404);

    // Build timeline events
    const timeline: Array<{
        step: number;
        date: string;
        event: string;
        type: 'APPLICATION' | 'SEAT_ALLOTMENT' | 'FEE_DEMAND' | 'PAYMENT' | 'SCHOLARSHIP' | 'DISCOUNT' | 'COURSE_CHANGE' | 'FINE' | 'INFO';
        category: string;
        amount: number | null;
        sign: '+' | '-' | null;
        description: string;
    }> = [];

    // 1. Seat allotment event
    if (student.admissionDetails?.seatAllottedAt) {
        timeline.push({
            step: 0,
            date: student.admissionDetails.seatAllottedAt.toISOString(),
            event: 'Seat Allotted',
            type: 'SEAT_ALLOTMENT',
            category: '',
            amount: null,
            sign: null,
            description: `Course: ${student.admissionDetails.allottedCourse?.name || 'N/A'} (${student.admissionDetails.allottedCourse?.degree || 'N/A'})`
        });
    }

    // 2. Scholarship events (from AuditLog for CREATE/UPDATE on StudentScholarship)
    if (scholarship) {
        // Filter audit logs for this student's scholarship record
        const scholarshipLogs = scholarshipAuditLogs.filter(log => log.entityId === scholarship.id);

        if (scholarshipLogs.length > 0) {
            scholarshipLogs.forEach(log => {
                const details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
                const isCreate = log.action === 'CREATE';
                const pct = details?.data?.scholarshipPercentage || details?.changes?.scholarshipPercentage || scholarship.scholarshipPercentage;

                timeline.push({
                    step: 0,
                    date: (log.timestamp || new Date()).toISOString(),
                    event: isCreate ? 'Scholarship Allocated' : 'Scholarship Updated',
                    type: 'SCHOLARSHIP',
                    category: '',
                    amount: null,
                    sign: null,
                    description: isCreate
                        ? `${pct}% scholarship allocated (${scholarship.type})`
                        : `Scholarship updated to ${pct}% (${scholarship.type})`
                });
            });
        } else {
            // Fallback: no audit logs found, use createdAt from scholarship record
            timeline.push({
                step: 0,
                date: scholarship.createdAt.toISOString(),
                event: 'Scholarship Allocated',
                type: 'SCHOLARSHIP',
                category: '',
                amount: null,
                sign: null,
                description: `${scholarship.scholarshipPercentage}% scholarship allocated (${scholarship.type})`
            });
        }
    }

    // 3. Process each ledger entry into a timeline event
    ledgers.forEach(entry => {
        const feeHeadName = (entry.feeHeadId ? feeHeadMap.get(entry.feeHeadId) : '') || '';
        const refType = entry.referenceType || '';

        let event = '';
        let type: typeof timeline[0]['type'] = 'INFO';
        let sign: '+' | '-' | null = null;

        if (refType === 'FEE_DEMAND') {
            event = 'Fee Charged';
            type = 'FEE_DEMAND';
            sign = '-';
        } else if (refType === 'FEE_GENERATION') {
            event = 'Fee Generated';
            type = 'FEE_DEMAND';
            sign = '-';
        } else if (refType === 'PAYMENT') {
            event = 'Payment Received';
            type = 'PAYMENT';
            sign = '+';
        } else if (refType === 'SCHOLARSHIP') {
            event = 'Scholarship Applied';
            type = 'SCHOLARSHIP';
            sign = '+';
        } else if (refType === 'COURSE_CHANGE' && entry.type === 'DEBIT') {
            event = 'Course Change Fee';
            type = 'COURSE_CHANGE';
            sign = '-';
        } else if (entry.type === 'CREDIT' && refType !== 'PAYMENT') {
            event = 'Discount / Adjustment';
            type = 'DISCOUNT';
            sign = '+';
        } else if (entry.type === 'DEBIT') {
            event = 'Charge';
            type = 'FEE_DEMAND';
            sign = '-';
        }

        timeline.push({
            step: 0,
            date: entry.date.toISOString(),
            event,
            type,
            category: feeHeadName,
            amount: entry.amount,
            sign,
            description: entry.description || ''
        });
    });

    // 3. Course change events (from CourseChangeLog)
    courseChangeLogs.forEach(log => {
        timeline.push({
            step: 0,
            date: (log.date || new Date()).toISOString(),
            event: 'Course Changed',
            type: 'COURSE_CHANGE',
            category: '',
            amount: null,
            sign: null,
            description: `${log.oldDegree || ''} ${log.oldCourse} → ${log.newDegree || ''} ${log.newCourse}`
        });
    });

    // Sort by date ascending, then assign step numbers
    timeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    timeline.forEach((item, i) => { item.step = i + 1; });

    // 4. Compute running balance after each step
    let totalCharged = 0;
    let totalCredits = 0; // payments + scholarships + discounts
    const flow = timeline.map(item => {
        if (item.sign === '-' && item.amount) totalCharged += item.amount;
        if (item.sign === '+' && item.amount) totalCredits += item.amount;

        return {
            ...item,
            runningBalance: totalCharged - totalCredits
        };
    });

    // 5. Summary at the end
    const currentPending = Math.max(0, totalCharged - totalCredits);

    return {
        student: {
            id: student.id,
            name: student.name,
            applicationId: student.applicationId,
            course: student.admissionDetails?.allottedCourse?.name || null,
            degree: student.admissionDetails?.allottedCourse?.degree || null,
            scholarship: scholarship ? `${scholarship.scholarshipPercentage}% (${scholarship.type})` : null,
        },
        totalSteps: flow.length,
        currentPending,
        flow
    };
};
