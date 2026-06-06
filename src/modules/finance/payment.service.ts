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
import { getOrCreateAccommodationPricing, resolveFeeDemandContext, getActiveAcademicYear, recomputeStudentTotals, getStudentYearOfStudy } from '../../utils/studentContext';
import { uploadFileToS3, getPresignedUrl, convertToPresignedUrl } from '../../utils/s3Utils';
import { ScholarshipService } from './scholarship.service';
import { generateAllotmentOrderPDF, generateHostelAllotmentOrderPDF } from '../../utils/allotmentGenerator';
import { StudentDocumentStatus } from '@prisma/client';

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

/** Return a PhonePe SDK client for the given merchant bucket (ADMISSION / HOSTEL / MESS each have separate merchant credentials). */
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
/** Decide which PhonePe merchant bucket a payment routes to, based on its fee component (hostel/mess vs admission). */
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
/** Internal: normalize a free-text component name (+ optional feeHeadId) into a canonical PaymentComponent enum. */
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

/** Low-level: create a PhonePe pay request and return the gateway redirect URL for a prepared transaction. */
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

/**
 * Start an online application-fee payment. Reuses a fresh PENDING payment if
 * one exists within PhonePe's ~20-min order window, else marks it FAILED and
 * creates a new one (year-tagged). Returns the gateway redirect URL.
 */
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
        const activeYear = await tx.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });
        const yearOfStudy = await getStudentYearOfStudy(studentId, tx);
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
                        method: PaymentMethod.UPI,
                        academicYearId: activeYear.id,
                        yearOfStudy
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
                    method: PaymentMethod.UPI,
                    academicYearId: activeYear.id,
                    yearOfStudy
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
/** Start a single online payment covering multiple fee components (e.g. tuition + hostel + mess) under one transaction. */
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

    // 2. Validate Fee Heads.
    // For hostel/transport components that omit feeHeadId, auto-resolve from the FeeHead table
    // so the Payment row is never created with feeHeadId=null for these components.
    for (const item of components) {
        if (!item.feeHeadId && COMPONENT_RESOLVABLE.has(item.component)) {
            const feeHead = await prisma.feeHead.findFirst({
                where: { component: item.component, isDeleted: false },
                select: { id: true },
            });
            if (feeHead) item.feeHeadId = feeHead.id;
        }

        if (!item.feeHeadId && item.component !== PaymentComponent.OTHER && item.component !== PaymentComponent.COURSE_CHANGE_FEE) {
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
        const activeYear = await tx.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });

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
            // Resolve feeDemandId + yearOfStudy before creating the row so these
            // fields are never null on the Payment record for hostel/transport.
            let feeDemandId: string | undefined;
            let yearOfStudy: number | undefined;
            if (item.feeHeadId) {
                const demand = await tx.studentFeeDemand.findFirst({
                    where: {
                        studentId,
                        isDeleted: false,
                        status: { in: [FeeStatus.PENDING, FeeStatus.PARTIAL] },
                        OR: [
                            { feeHeadId: item.feeHeadId },
                            { feeStructure: { feeHeadId: item.feeHeadId } },
                        ],
                    },
                    orderBy: { dueDate: 'asc' },
                    select: { id: true, yearOfStudy: true, academicYearId: true },
                });
                if (demand) {
                    feeDemandId = demand.id;
                    yearOfStudy = demand.yearOfStudy ?? undefined;
                }
            }
            // If yearOfStudy still not resolved (no demand found or demand.yearOfStudy is null),
            // fall back to enrollment → entryYearOfStudy so the Payment row is never wrong.
            if (!yearOfStudy) {
                yearOfStudy = await getStudentYearOfStudy(studentId, tx);
            }

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
                    feeHeadId: item.feeHeadId,
                    feeDemandId,
                    yearOfStudy,
                    academicYearId: activeYear.id,
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

/** Poll PhonePe for a transaction's status and reconcile the local Payment row(s) (SUCCESS/FAILED). */
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

/** Internal: post-success pipeline for one payment — settle demands, write ledger, run component logic, fire triggers. */
const processSinglePaymentSuccess = async (payment: any, metadata: any) => {
    logger.info(`[processSinglePaymentSuccess] Delegating to processMultiPaymentSuccess for Payment ${payment.id}`);
    return await processMultiPaymentSuccess([payment], metadata);
};

/** Internal: post-success pipeline for a bundle of payments sharing one transaction (unified invoice + per-payment settle). */
const processMultiPaymentSuccess = async (payments: any[], metadata: any) => {
    if (!payments || payments.length === 0) return;
    const txnId = payments[0].providerTxId;
    const studentId = payments[0].studentId;
    const applicationId = payments[0].student?.applicationId;
    payLog.info('PROCESSING', `Processing ${payments.length} payment(s)`, { txnId, studentId, applicationId, count: payments.length });
    logger.info(`[processMultiPaymentSuccess] Processing ${payments.length} payments. Ref=${txnId}`);

    // Idempotency guard — only process payments that are still PENDING. Anything
    // already SUCCESS (duplicate callback) or FAILED must NOT be settled/ledgered again.
    const pendingPayments = payments.filter(p => p.status === PaymentStatus.PENDING);
    if (pendingPayments.length === 0) {
        logger.info(`[processMultiPaymentSuccess] No PENDING payments to process (already handled) — skipping. Ref=${payments[0].providerTxId}`);
        return;
    }
    if (pendingPayments.length < payments.length) {
        logger.warn(`[processMultiPaymentSuccess] ${payments.length - pendingPayments.length} payment(s) not PENDING, processing remaining ${pendingPayments.length}. Ref=${payments[0].providerTxId}`);
    }

    // 1. ATOMIC money pipeline — status flip + per-payment settle + ledger in ONE
    //    transaction. The status flip is gated on status:PENDING (idempotency vs
    //    duplicate/concurrent callbacks). If ANY step throws, the whole bundle rolls
    //    back (payments stay PENDING) so the webhook retry re-processes cleanly — no
    //    payment is ever left SUCCESS with settlement/ledger half-done.
    let flippedCount = 0;
    await prisma.$transaction(async (tx) => {
        const statusFlip = await tx.payment.updateMany({
            where: { id: { in: pendingPayments.map((p: any) => p.id) }, status: PaymentStatus.PENDING },
            data: { status: PaymentStatus.SUCCESS, metadata }
        });
        flippedCount = statusFlip.count;
        if (flippedCount === 0) return; // a concurrent callback already transitioned them

        for (const payment of pendingPayments) {
            if (payment.component !== PaymentComponent.APPLICATION_FEE) {
                await _settleFeeDemands(payment, tx);
            }
            await _createPaymentLedger(payment, tx);
        }
    }, { timeout: 20000, maxWait: 10000 });

    if (flippedCount === 0) {
        logger.info(`[processMultiPaymentSuccess] No PENDING payments transitioned (concurrent callback already processed them) — skipping. Ref=${txnId}`);
        return;
    }
    payLog.info('SUCCESS', `${pendingPayments.length} payment(s) marked SUCCESS + settled + ledgered (atomic)`, { txnId, studentId, applicationId, amount: payments.reduce((s: number, p: any) => s + p.amount, 0) });

    // 2. Post-commit side effects (best-effort — must NOT roll back committed money).
    //    Component side effects (status advancement, scholarship lock, provisional ledger).
    for (const payment of pendingPayments) {
        try {
            await _processComponentLogic(payment);
        } catch (e) {
            payLog.error('COMPONENT_LOGIC_FAILED', `Post-success component logic failed: ${e}`, { studentId, component: payment.component });
        }
    }

    // 3. Pre-generate Allotment Order for admission payments (before invoice so email can attach it)
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

    // 4. Generate Invoice (Unified) via InvoiceService — slow S3/PDF, kept OUT of the tx.
    let invoiceUrl = null;
    try {
        const invoiceResult = await InvoiceService.generateInvoiceForPayment(payments[0].id);
        invoiceUrl = invoiceResult.invoiceUrl;
        payLog.info('INVOICE_GENERATED', `Invoice generated`, { studentId, applicationId, txnId, invoiceNumber: invoiceResult.invoiceNumber });
    } catch (e) {
        payLog.error('INVOICE_FAILED', `Invoice generation failed: ${e}`, { studentId, applicationId, txnId });
    }

    // 5. Triggers (FINALIZE_ADMISSION runs its own transaction)
    await _handleTriggers(payments);

    payLog.info('COMPLETED', `Payment processing completed`, { txnId, studentId, applicationId, totalAmount: payments.reduce((s: number, p: any) => s + p.amount, 0) });
    return { invoiceUrl };
};

/** Internal: component-specific side effects after success (e.g. APPLICATION_FEE advances admission status, hostel triggers allotment order). */
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
             const existingDemands = await prisma.studentFeeDemand.count({ where: { studentId, isDeleted: false } });
             if (existingDemands === 0) {
                 const detailedStudent = await prisma.student.findUnique({ where: { id: studentId }, include: { admissionDetails: { include: { hostel: true, transportRoute: true } }, scholarshipAllocation: { include: { rule: true } } }});
                 if (detailedStudent?.admissionDetails) {
                     const ledgers: any[] = [];
                     const admission = detailedStudent.admissionDetails;
                     const tuitionFee = admission.totalFee ?? 0;
                     const legacyAcademicYearId = admission.academicYearId ?? payment.academicYearId;
                     const ledgerYearOfStudy = await getStudentYearOfStudy(studentId);
                     if (tuitionFee <= 0) {
                         logger.warn(`[_processComponentLogic] totalFee is ${tuitionFee} for student=${studentId} — skipping tuition ledger entry`);
                     }
                     if (tuitionFee > 0) ledgers.push({ studentId, type: 'DEBIT', amount: tuitionFee, description: 'Tuition Fee (Annual)', referenceId: payment.id, referenceType: 'FEE_GENERATION', academicYearId: legacyAcademicYearId, yearOfStudy: ledgerYearOfStudy, date: new Date() });
                     if (admission.transportRouteId && admission.transportRoute) { ledgers.push({ studentId, type: 'DEBIT', amount: admission.transportRoute.cost, description: `Transport Fee - ${admission.transportRoute.name}`, referenceId: payment.id, referenceType: 'FEE_GENERATION', academicYearId: legacyAcademicYearId, yearOfStudy: ledgerYearOfStudy, date: new Date() }); }
                     if (detailedStudent.scholarshipAllocation?.status === 'LOCKED' && detailedStudent.scholarshipAllocation.rule) { const rule = detailedStudent.scholarshipAllocation.rule; const discount = (tuitionFee * rule.discountPercentage) / 100; if (discount > 0) { ledgers.push({ studentId, type: 'CREDIT', amount: discount, description: `Scholarship Discount - ${rule.name} (${rule.discountPercentage}%)`, referenceId: detailedStudent.scholarshipAllocation.id, referenceType: 'SCHOLARSHIP', academicYearId: legacyAcademicYearId, yearOfStudy: ledgerYearOfStudy, date: new Date() }); } }
                     if (ledgers.length > 0) await prisma.studentLedger.createMany({ data: ledgers });
                 }
             } else {
                 logger.info(`[_processComponentLogic] Skipping FEE_GENERATION for student=${studentId} — ${existingDemands} fee demands already exist`);
             }
        }
        // Guard: a payment for a student with no admission row (manual/bulk import, or a
        // deleted admission) would otherwise throw P2025 here and abort the (non-atomic)
        // success loop, leaving the payment SUCCESS but unsettled. Log-and-continue instead.
        try {
            await prisma.studentAdmission.update({
                where: { studentId },
                data: { feeStatus: FeeStatus.PARTIAL }
            });
        } catch (err) {
            logger.warn(`[_processComponentLogic] Could not set feeStatus=PARTIAL for student=${studentId} (no admission row?): ${err}`);
        }
    }
};


// Components whose FeeHead + FeeDemand can be auto-resolved by component name
// when the caller did not supply feeHeadId. Kept in sync with exemptComponents above.
const COMPONENT_RESOLVABLE = new Set<PaymentComponent>([
    PaymentComponent.HOSTEL,
    PaymentComponent.HOSTEL_ACCOMMODATION,
    PaymentComponent.HOSTEL_MESS,
    PaymentComponent.HOSTEL_LAUNDRY,
    PaymentComponent.HOSTEL_REGISTRATION,
    PaymentComponent.TRANSPORT,
]);

/**
 * Internal: apply a successful payment against matching StudentFeeDemand rows.
 * Accepts a Prisma client/tx (`db`) so it can run inside the atomic success transaction.
 * Errors PROPAGATE (no swallow) so a failure rolls the whole bundle back rather than
 * leaving a payment SUCCESS with settlement half-done.
 */
const _settleFeeDemands = async (payment: any, db: any = prisma) => {
    let targetDemandId = payment.feeDemandId;
    let resolvedFeeHeadId = payment.feeHeadId ?? null;

    // Step 1: if feeHeadId is missing but the component is hostel/transport,
    // auto-resolve the FeeHead from the FeeHead table by component so we can
    // find the exact matching StudentFeeDemand (fixes feeHeadId + feeDemandId + yearOfStudy).
    if (!resolvedFeeHeadId && COMPONENT_RESOLVABLE.has(payment.component)) {
        const feeHead = await db.feeHead.findFirst({
            where: { component: payment.component, isDeleted: false },
            select: { id: true },
        });
        if (feeHead) {
            resolvedFeeHeadId = feeHead.id;
            // Persist the resolved feeHeadId onto the Payment row immediately so it is
            // never null for hostel/transport payments going forward.
            await db.payment.update({
                where: { id: payment.id },
                data: { feeHeadId: resolvedFeeHeadId },
            });
            payment.feeHeadId = resolvedFeeHeadId;
        }
    }

    // Step 2: resolve feeDemandId via feeHeadId when not explicitly provided
    if (!targetDemandId && resolvedFeeHeadId) {
         const matchingDemand = await db.studentFeeDemand.findFirst({
             where: {
                 studentId: payment.studentId,
                 isDeleted: false,
                 status: { in: [FeeStatus.PENDING, FeeStatus.PARTIAL] },
                 OR: [
                      { feeHeadId: resolvedFeeHeadId },
                      { feeStructure: { feeHeadId: resolvedFeeHeadId } }
                 ]
             },
             orderBy: { dueDate: 'asc' }
         });
         if (matchingDemand) targetDemandId = matchingDemand.id;
    }

    // Strict Settlement — exact demand known
    if (targetDemandId) {
        const demand = await db.studentFeeDemand.findUnique({ where: { id: targetDemandId } });
        if (demand) {
            // Compare against the NET payable (amount − discount − scholarship + fine),
            // not the gross amount. Mirrors admission.ts settlement.
            const targetAmount = demand.netAmount ?? demand.amount;
            const newStatus = payment.amount >= targetAmount ? 'FULL' : 'PARTIAL';
            await db.studentFeeDemand.update({
                where: { id: demand.id },
                data: { status: newStatus as any }
            });
            // demand.yearOfStudy may be null for legacy rows; fall back to enrollment/admission
            const resolvedYear = demand.yearOfStudy ?? await getStudentYearOfStudy(payment.studentId, db);
            // Copy feeDemandId + academicYearId + yearOfStudy onto the Payment row
            await db.payment.update({
                where: { id: payment.id },
                data: {
                    feeDemandId: targetDemandId,
                    feeHeadId: resolvedFeeHeadId ?? undefined,
                    academicYearId: demand.academicYearId ?? undefined,
                    yearOfStudy: resolvedYear,
                }
            });
            // Mutate in-memory so the subsequent _createPaymentLedger() picks up the year context
            payment.feeDemandId = targetDemandId;
            payment.feeHeadId = resolvedFeeHeadId;
            payment.academicYearId = demand.academicYearId ?? null;
            payment.yearOfStudy = resolvedYear;
        }
    }
    // Waterfall Settlement — no specific demand identified; filter by component if possible
    else {
        const demandWhere: any = {
            studentId: payment.studentId,
            isDeleted: false,
            status: FeeStatus.PENDING,
        };
        // Narrow the waterfall to demands that match this component's feeHead so a hostel
        // payment doesn't accidentally settle a tuition demand and vice-versa.
        if (resolvedFeeHeadId) {
            demandWhere.OR = [
                { feeHeadId: resolvedFeeHeadId },
                { feeStructure: { feeHeadId: resolvedFeeHeadId } },
            ];
        }

        const pendingDemands = await db.studentFeeDemand.findMany({
            where: demandWhere,
            orderBy: { dueDate: 'asc' }
        });

        // Use the first matching demand's year + link feeDemandId to Payment
        if (pendingDemands.length > 0) {
            const first = pendingDemands[0];
            // first.yearOfStudy may be null for legacy rows; fall back to enrollment/admission
            const resolvedYear = first.yearOfStudy ?? await getStudentYearOfStudy(payment.studentId, db);
            await db.payment.update({
                where: { id: payment.id },
                data: {
                    feeDemandId: first.id,
                    feeHeadId: resolvedFeeHeadId ?? undefined,
                    academicYearId: first.academicYearId ?? undefined,
                    yearOfStudy: resolvedYear,
                }
            });
            payment.feeDemandId = first.id;
            payment.feeHeadId = resolvedFeeHeadId;
            payment.academicYearId = first.academicYearId ?? null;
            payment.yearOfStudy = resolvedYear;
        }

        let remaining = payment.amount;
        for (const demand of pendingDemands) {
            if (remaining <= 0) break;
            // Settle against NET payable (amount − discount − scholarship), not gross.
            const target = demand.netAmount ?? demand.amount;
            if (remaining >= target) {
                await db.studentFeeDemand.update({ where: { id: demand.id }, data: { status: FeeStatus.FULL } });
                remaining -= target;
            } else {
                await db.studentFeeDemand.update({ where: { id: demand.id }, data: { status: FeeStatus.PARTIAL } });
                break;
            }
        }
    }

    // Recompute paidFee/totalFee from the source-of-truth (within the same tx).
    await recomputeStudentTotals(payment.studentId, db);
};

/**
 * Internal: write the CREDIT ledger entry for a successful payment (year-tagged).
 * Accepts `db` so it participates in the atomic transaction; errors propagate.
 */
const _createPaymentLedger = async (payment: any, db: any = prisma) => {
    // Idempotency guard — one CREDIT per payment. Prevents a duplicate ledger
    // entry if the success pipeline ever re-runs for the same payment. Mirrors
    // admission.ts:processPaymentSuccess.
    const existingLedger = await db.studentLedger.findFirst({
        where: { referenceId: payment.id, referenceType: 'PAYMENT', studentId: payment.studentId }
    });
    if (existingLedger) {
        logger.warn(`[_createPaymentLedger] CREDIT ledger already exists for payment ${payment.id} — skipping duplicate.`);
        return;
    }
    await db.studentLedger.create({
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
};

/** Internal: fire post-payment triggers flagged in metadata (e.g. FINALIZE_ADMISSION runs executeAdmissionUpdates). */
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


/** Record a cash/offline application-fee payment (admin-entered). Creates a SUCCESS Payment (year-tagged) and runs the success pipeline. */
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
        const activeYear = await tx.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });
        const yearOfStudy = await getStudentYearOfStudy(studentId, tx);

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
                metadata: { remarks, mode: 'OFFLINE_ENTRY' },
                academicYearId: activeYear.id,
                yearOfStudy
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

/** Handle the legacy PhonePe redirect callback: verify the X-VERIFY checksum, decode payload, reconcile the payment. */
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
    // Fail closed if the salt is not configured — otherwise the checksum is computable
    // by anyone and a forged PAYMENT_SUCCESS callback would be accepted.
    if (!saltKey) {
        webhookLog.error('CHECKSUM_MISCONFIG', `Salt key not configured — rejecting callback`, { txnId: merchantTransactionId, merchantId });
        throw new AppError('Payment verification not configured', 500);
    }

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
/** Handle the new PhonePe server-to-server webhook: validate auth header, then reconcile the payment status. */
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
/** Controller-facing wrapper: initiate the application ("test") fee payment. */
export const payTestFee = async (studentId: string, _userId: string | null) => {
    const { redirectUrl, paymentId } = await initiateApplicationFeePayment(studentId);
    return { redirectUrl, paymentId };
};

/** Controller-facing: compute the student's outstanding college/hostel/transport fees and initiate a multi-component payment. */
export const payCollegeFee = async (studentId: string, data: any, _userId: string | null) => {
    const { hostelSelection, transportSelection, paymentDetails } = data;
    const { } = paymentDetails || {};

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

    // 5. Create Payment Record — resolve feeHeadId + feeDemandId + yearOfStudy upfront
    let { feeHeadId: callerFeeHeadId, feeDemandId: callerFeeDemandId } = paymentDetails || {};

    // Auto-resolve feeHeadId if caller omitted it
    if (!callerFeeHeadId) {
        const feeHead = await prisma.feeHead.findFirst({
            where: { component: paymentComponent as any, isDeleted: false },
            select: { id: true },
        });
        if (feeHead) callerFeeHeadId = feeHead.id;
    }

    // Resolve feeDemandId from the matching PENDING/PARTIAL demand when caller omits it
    if (!callerFeeDemandId && callerFeeHeadId) {
        const demand = await prisma.studentFeeDemand.findFirst({
            where: {
                studentId,
                isDeleted: false,
                status: { in: [FeeStatus.PENDING, FeeStatus.PARTIAL] },
                OR: [{ feeHeadId: callerFeeHeadId }, { feeStructure: { feeHeadId: callerFeeHeadId } }],
            },
            orderBy: { dueDate: 'asc' },
            select: { id: true },
        });
        if (demand) callerFeeDemandId = demand.id;
    }

    const yearCtx = await resolveFeeDemandContext(callerFeeDemandId);
    const resolvedYearOfStudy = yearCtx.yearOfStudy ?? await getStudentYearOfStudy(studentId);

    const payment = await prisma.payment.create({
        data: {
            studentId,
            amount: amountToPay,
            status: PaymentStatus.PENDING,
            component: paymentComponent,
            providerTxId: transactionId,
            idempotencyKey: `${transactionId}_${paymentComponent}`,
            method: paymentDetails?.paymentMode === 'PHONEPE' ? PaymentMethod.UPI : PaymentMethod.CASH,
            feeHeadId: callerFeeHeadId || undefined,
            feeDemandId: callerFeeDemandId || undefined,
            academicYearId: yearCtx.academicYearId,
            yearOfStudy: resolvedYearOfStudy,
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
/** Paginated, filterable list of all SUCCESS payments for the finance reconciliation screen. */
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
/** List the distinct payment components present (for the report filter dropdown). */
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
/** List the distinct admins who recorded payments (for the "collected by" report filter). */
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
/** Same filters as getAllSuccessPayments but returns a CSV string for download. */
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

/** Student/admin-facing thin wrapper to file a discount request (delegates to the discount-request flow). */
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

/** Legacy discount-approval path: marks the request APPROVED and writes a CREDIT ledger entry (year-tagged). */
export const approveDiscount = async (requestId: string, approvedAmount: number, component: string, adminId: string, remarks?: string) => {
    const request = await prisma.discountRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppError('Discount Request not found', 404);
    if (request.status !== DiscountStatus.REQUESTED) throw new AppError('Request already processed', 400);

    const approvedItems = [{ component, approvedAmount }];

    return await prisma.$transaction(async (tx) => {
         const activeYear = await tx.academicYear.findFirstOrThrow({
             where: { isActive: true, isDeleted: false }
         });

         // Resolve feeHeadId + yearOfStudy from the student's matching demand
         const discountDemand = await tx.studentFeeDemand.findFirst({
             where: {
                 studentId: request.studentId,
                 isDeleted: false,
                 OR: [
                     { feeHead: { component: component as any } },
                     { feeHead: { name: { contains: component, mode: 'insensitive' } } },
                 ],
             },
             orderBy: { createdAt: 'desc' },
             select: { feeHeadId: true, yearOfStudy: true },
         });
         const discountFeeHeadId = discountDemand?.feeHeadId ?? undefined;
         const discountYear = discountDemand?.yearOfStudy
             ?? await getStudentYearOfStudy(request.studentId, tx);

         const updated = await tx.discountRequest.update({
            where: { id: requestId },
            data: {
                status: DiscountStatus.APPROVED,
                approvedAmount,
                component,
                items: approvedItems as any,
                remarks,
                approvedBy: adminId,
                approvedAt: new Date()
            } as any
         });

         await tx.studentLedger.create({
            data: {
                studentId: request.studentId,
                type: 'CREDIT' as any,
                amount: approvedAmount,
                description: `Discount Approved - ${component} (${remarks || 'Admin Approval'})`,
                referenceId: updated.id,
                referenceType: 'DISCOUNT',
                createdBy: adminId,
                academicYearId: activeYear.id,
                feeHeadId: discountFeeHeadId,
                yearOfStudy: discountYear,
                date: new Date()
            }
         });

         return updated;
    });
};

/** Mark a discount request REJECTED with remarks. */
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

/** Return a presigned URL for a payment's invoice PDF (generates it if missing). */
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
/** Internal: extract the S3 object key from a full S3 URL (null if it doesn't look like one). */
const getS3KeyFromUrl = (url: string): string | null => {
    const keyMatch = url.match(/(student\/.*\.pdf)/);
    if (keyMatch) return keyMatch[1];
    
    const parts = url.split('amazonaws.com/');
    if (parts.length > 1) return parts[1];

    return null;
};

/** Return a presigned URL for the student's provisional allotment-order PDF; pass `regenerate` to rebuild it. */
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

/** Start the scholarship-token online payment (records hostel/transport selections first if provided). */
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

    const activeYear = await getActiveAcademicYear();
    const tokenYearOfStudy = await getStudentYearOfStudy(studentId);
    const createdPayment = await prisma.payment.create({
        data: {
            studentId,
            amount: TOKEN_AMOUNT,
            status: PaymentStatus.PENDING,
            component: PaymentComponent.SCHOLARSHIP_TOKEN,
            providerTxId: transactionId,
            idempotencyKey: `${transactionId}_SCHOLARSHIP_TOKEN`,
            method: PaymentMethod.UPI,
            academicYearId: activeYear.id,
            yearOfStudy: tokenYearOfStudy,
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


/** High-level financial summary card for one student (total demand / paid / balance / scholarship). */
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
/** Render the provisional allotment-order PDF, upload to S3, and upsert the StudentDocument record (year-tagged). */
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
             // Read the scholarship portion (breakdown.discount is now manual-only).
             let scholarshipDiscount = breakdown['TUITION']?.scholarshipAmount || 0;
             
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

            const allotmentYear = await getActiveAcademicYear();
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
                    remarks: 'Generated after Fee Payment',
                    academicYearId: allotmentYear.id
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
/** Render the hostel allotment-order PDF (bed/room/warden details), upload to S3, upsert the StudentDocument (year-tagged). */
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

        const hostelDocYear = await getActiveAcademicYear();
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
                academicYearId: hostelDocYear.id,
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
/** Unified entrypoint for any payment: validates fee head, generates a transaction id, creates the Payment (year-tagged), and processes offline ones immediately. */
export const processUnifiedPayment = async (data: any) => {
    const { studentId, amount, mode, method, component: rawComponent, feeHeadId: rawFeeHeadId, remarks, initiatedBy, referenceNumber, redirectUrl } = data;
    logger.info(`[processUnifiedPayment] START - StudentId=${studentId}, Amount=${amount}, Mode=${mode}, Method=${method}, Component=${rawComponent}, InitiatedBy=${initiatedBy}`);
   
    // Resolve Component
    logger.debug(`[processUnifiedPayment] Resolving component: ${rawComponent}`);
    const { component, feeHeadId: _feeHeadId } = await resolveComponent(rawComponent, rawFeeHeadId);
    let feeHeadId: string | null = _feeHeadId ?? null;
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
    
    // Auto-resolve feeHeadId for hostel/transport components when caller omits it
    if (!feeHeadId && COMPONENT_RESOLVABLE.has(component)) {
        const feeHead = await prisma.feeHead.findFirst({
            where: { component, isDeleted: false },
            select: { id: true },
        });
        if (feeHead) feeHeadId = feeHead.id;
    }

    if (feeHeadId) {
        const feeHead = await prisma.feeHead.findUnique({ where: { id: feeHeadId } });
        if (!feeHead) {
            throw new AppError(`Invalid Fee Head ID: ${feeHeadId}`, 400);
        }
    }

    // Resolve feeDemandId + yearOfStudy upfront so the Payment row is never null
    // for these fields (mirrors the payMultiComponentFee path).
    let resolvedFeeDemandId: string | undefined;
    let resolvedYearOfStudy: number | undefined;
    if (feeHeadId) {
        const demand = await prisma.studentFeeDemand.findFirst({
            where: {
                studentId,
                isDeleted: false,
                status: { in: [FeeStatus.PENDING, FeeStatus.PARTIAL] },
                OR: [
                    { feeHeadId },
                    { feeStructure: { feeHeadId } },
                ],
            },
            orderBy: { dueDate: 'asc' },
            select: { id: true, yearOfStudy: true, academicYearId: true },
        });
        if (demand) {
            resolvedFeeDemandId = demand.id;
            resolvedYearOfStudy = demand.yearOfStudy ?? undefined;
        }
    }
    if (!resolvedYearOfStudy) {
        resolvedYearOfStudy = await getStudentYearOfStudy(studentId);
    }

    // 3. Generate Transaction ID
    const providerTxId = mode === PaymentMode.OFFLINE 
        ? (referenceNumber || `CASH_${Date.now()}_${studentId.substring(0, 8)}`)
        : `TXN_${Date.now()}_${studentId.substring(0, 8)}`;
    logger.info(`[processUnifiedPayment] Transaction ID generated: ${providerTxId}`);

    // 4. Create Payment Record
    logger.info(`[processUnifiedPayment] Creating payment record with status=PENDING`);

    const unifiedYear = await getActiveAcademicYear();
    // idempotencyKey is globally @unique. For ONLINE the providerTxId is already
    // unique per attempt. For OFFLINE, providerTxId derives from the human-entered
    // referenceNumber (e.g. a cash receipt no.), which is freely reused across
    // students and re-attempts — so `${ref}_${component}` collides and Prisma throws
    // P2002 (HTTP 500). Offline manual entries aren't auto-retried, so scope the key
    // to the student + a per-attempt timestamp to guarantee uniqueness.
    const idempotencyKey = mode === PaymentMode.OFFLINE
        ? `OFF_${studentId}_${component}_${Date.now()}`
        : `${providerTxId}_${component}`;

    let payment;
    try {
        payment = await prisma.payment.create({
            data: {
                studentId,
                amount,
                mode,
                method: method || (mode === PaymentMode.ONLINE ? PaymentMethod.UPI : PaymentMethod.CASH),
                status: PaymentStatus.PENDING,
                component,
                referenceNumber,
                feeHeadId,
                feeDemandId: resolvedFeeDemandId,
                yearOfStudy: resolvedYearOfStudy,
                providerTxId,
                idempotencyKey,
                collectedBy: initiatedBy,
                createdBy: initiatedBy, // Strict data
                metadata: { remarks, source: 'UNIFIED_API' },
                academicYearId: unifiedYear.id
            }
        });
    } catch (e: any) {
        // Safety net: surface a duplicate key as a clean 409 instead of a raw 500.
        if (e?.code === 'P2002') {
            throw new AppError('A payment with this reference is already in progress for this student. Please refresh and try again.', 409);
        }
        throw e;
    }

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
/** Full per-year financial history for a student: ledgers + payments + demands + corrections, scoped by optional academicYearId. */
export const getStudentFinancialHistory = async (
    studentId: string,
    options: { academicYearId?: string; yearOfStudy?: number } = {}
) => {
    const { academicYearId, yearOfStudy } = options;

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
    // academicYearId is now NOT NULL on every financial table (Payment, StudentLedger,
    // StudentFeeDemand) after the year-tag migration — so a strict year filter is enough,
    // no NULL-fallback OR-branch needed.
    const yearFilter = {
        ...(academicYearId ? { academicYearId } : {}),
        ...(yearOfStudy    ? { yearOfStudy }    : {}),
    };
    // FeeCorrection has no yearOfStudy column — scope it to academicYearId only
    const correctionFilter = {
        ...(academicYearId ? { academicYearId } : {}),
    };

    const [ledgers, payments, feeDemands, feeCorrections, activeAccPricing] = await Promise.all([
        prisma.studentLedger.findMany({
            where: { studentId, isDeleted: false, ...yearFilter },
            orderBy: { date: 'desc' }
        }),
        prisma.payment.findMany({
            where: { studentId, status: PaymentStatus.SUCCESS, isDeleted: false, ...yearFilter },
            include: {
                feeDemand: {
                    include: { feeStructure: { include: { feeHead: true } } }
                }
            }
        }),
        prisma.studentFeeDemand.findMany({
            where: { studentId, isDeleted: false, ...yearFilter },
            include: {
                feeStructure: { include: { feeHead: true } },
                feeHead: true
            }
        }),
        (prisma as any).feeCorrection.findMany({
            where: { studentId, ...correctionFilter },
            orderBy: { createdAt: 'desc' },
        }),
        // Active accommodation snapshot — used as the cutoff for "pre-cycle" hostel
        // payments (made before the current hostel cycle started).
        (prisma as any).studentAccommodationPricing.findFirst({
            where: { studentId, isActive: true },
            select: { createdAt: true }
        }),
    ]);

    logger.info(`[FinancialHistory] Data Fetched. Ledgers: ${ledgers.length}, Payments: ${payments.length}, Demands: ${feeDemands.length}, FeeCorrections: ${feeCorrections.length}`);

    // ─── Constants ─────────────────────────────────────────────────────────────────
    const BREAKDOWN_CATEGORIES = [
        'HOSTEL_ACCOMMODATION',
        'HOSTEL_MESS',
        'HOSTEL_LAUNDRY',
        'HOSTEL_REGISTRATION',
        'TRANSPORT',
        'TUITION',
        'BOOK_BANK',
        'ADMISSION',
        'OTHER',
    ] as const;

    const REFUND_LIKE_REFERENCE_TYPES = new Set([
        'CANCELLATION',
        'HOSTEL_REASSIGNMENT',
        'HOSTEL_CANCELLATION',
        'TRANSPORT_REASSIGNMENT',
        'TRANSPORT_CANCELLATION',
        'ACCOMMODATION_SWITCH',
        'HOSTEL_TO_TRANSPORT_SWITCH',
        'TRANSPORT_TO_HOSTEL_SWITCH',
        'WAIVER',
    ]);

    const HOSTEL_PAYMENT_COMPONENTS: PaymentComponent[] = [
        PaymentComponent.HOSTEL,
        PaymentComponent.HOSTEL_ACCOMMODATION,
        PaymentComponent.HOSTEL_MESS,
        PaymentComponent.HOSTEL_LAUNDRY,
        PaymentComponent.HOSTEL_REGISTRATION,
    ];
    const HOSTEL_BREAKDOWN_KEYS = ['HOSTEL_ACCOMMODATION', 'HOSTEL_MESS', 'HOSTEL_LAUNDRY', 'HOSTEL_REGISTRATION'] as const;

    // ─── Setup: breakdown, fee-head map, accommodation state ───────────────────────
    type Bucket = { demanded: number; paid: number; fine: number; discount: number; scholarshipAmount: number; feeHeadId: string };
    const breakdown: Record<string, Bucket> = Object.fromEntries(
        BREAKDOWN_CATEGORIES.map(c => [c, { demanded: 0, paid: 0, fine: 0, discount: 0, scholarshipAmount: 0, feeHeadId: '' }])
    );

    const feeHeadComponentMap = new Map<string, PaymentComponent | null>(
        allFeeHeads.map((h: any) => [h.id, h.component ?? null])
    );

    const accType = student?.admissionDetails?.accommodationType ?? null;
    const suppressedAccComponents = new Set<PaymentComponent>();
    if (accType !== AccommodationType.HOSTEL) HOSTEL_PAYMENT_COMPONENTS.forEach(c => suppressedAccComponents.add(c));
    if (accType !== AccommodationType.TRANSPORT) suppressedAccComponents.add(PaymentComponent.TRANSPORT);

    // ─── Helpers ───────────────────────────────────────────────────────────────────
    // SCHOLARSHIP_TOKEN and bare HOSTEL are enum-level aliases preserved for legacy data.
    const bucketKey = (comp: PaymentComponent | string | null | undefined): string => {
        if (!comp) return 'OTHER';
        if (comp === PaymentComponent.SCHOLARSHIP_TOKEN) return 'ADMISSION';
        if (comp === PaymentComponent.HOSTEL) return 'HOSTEL_ACCOMMODATION';
        return breakdown[comp as string] ? (comp as string) : 'OTHER';
    };

    const componentOfDemand = (d: any): PaymentComponent | null | undefined => {
        const headId = d.feeHeadId ?? d.feeStructure?.feeHeadId;
        return d.feeHead?.component
            ?? d.feeStructure?.feeHead?.component
            ?? (headId ? feeHeadComponentMap.get(headId) : null);
    };

    const componentOfPayment = (p: any): PaymentComponent | null | undefined =>
        p.feeDemand?.feeStructure?.feeHead?.component
        ?? (p.feeHeadId ? feeHeadComponentMap.get(p.feeHeadId) : undefined)
        ?? p.component;

    // Cutoff for "pre-cycle" stale payments: any unlinked accommodation payment that
    // predates the start of the current cycle was for an earlier stint (already
    // accounted for via an ACCOMMODATION_CHANGE_REFUND from that stint). HOSTEL uses
    // the active StudentAccommodationPricing snapshot's createdAt; TRANSPORT uses the
    // earliest currently-active TRANSPORT demand's createdAt.
    const activeAccCycleStart: Date | null = (() => {
        if (accType === AccommodationType.HOSTEL) {
            return activeAccPricing?.createdAt ?? null;
        }
        if (accType === AccommodationType.TRANSPORT) {
            const transportDemands = feeDemands
                .filter((d: any) =>
                    (d.feeHead?.component === PaymentComponent.TRANSPORT
                     || d.feeStructure?.feeHead?.component === PaymentComponent.TRANSPORT)
                )
                .map((d: any) => new Date(d.createdAt).getTime());
            return transportDemands.length > 0 ? new Date(Math.min(...transportDemands)) : null;
        }
        return null;
    })();

    const isAccommodationComponent = (c: PaymentComponent | null | undefined): boolean =>
        c === PaymentComponent.HOSTEL
        || c === PaymentComponent.HOSTEL_ACCOMMODATION
        || c === PaymentComponent.HOSTEL_MESS
        || c === PaymentComponent.HOSTEL_LAUNDRY
        || c === PaymentComponent.HOSTEL_REGISTRATION
        || c === PaymentComponent.TRANSPORT;

    const isExternalPayment    = (p: any) => p.component === PaymentComponent.APPLICATION_FEE
                                          || p.component === PaymentComponent.COURSE_CHANGE_FEE;
    const isStalePayment       = (p: any): boolean => {
        if (p.feeDemand && p.feeDemand.isDeleted) return true;
        // Unlinked accommodation payment that predates the current cycle → stale.
        if (!activeAccCycleStart || p.feeDemandId) return false;
        if (!isAccommodationComponent(p.component)) return false;
        return new Date(p.createdAt) < activeAccCycleStart;
    };
    const isAccSuppressedPayment = (p: any) => suppressedAccComponents.has(p.component);
    const isCurrentPayment     = (p: any) => !isExternalPayment(p) && !isAccSuppressedPayment(p) && !isStalePayment(p);

    const isAccommodationRefund = (fc: any) => fc.type === 'ACCOMMODATION_CHANGE_REFUND';

    const sumPayments = (pred: (p: any) => boolean) =>
        payments.filter(pred).reduce((s, p) => s + p.amount, 0);
    const sumCorrections = (pred: (fc: any) => boolean, field: 'amount' | 'retainedAmount') =>
        (feeCorrections as any[]).filter(pred).reduce((s, fc) => s + ((fc as any)[field] ?? 0), 0);

    // ─── 1. Apply demands ──────────────────────────────────────────────────────────
    feeDemands.forEach((demand: any) => {
        const headId = demand.feeHeadId ?? demand.feeStructure?.feeHeadId;
        const target = breakdown[bucketKey(componentOfDemand(demand))];
        target.demanded += demand.amount;
        target.discount += demand.discountAmount ?? 0;
        if (demand.scholarshipAmount) target.scholarshipAmount += demand.scholarshipAmount;
        if (demand.fineAmount) target.fine += demand.fineAmount;
        if (headId && !target.feeHeadId) target.feeHeadId = headId;
    });

    // ─── 2. Apply ledger adjustments (course-change DEBIT only) ────────────────────
    ledgers.forEach((entry: any) => {
        if (REFUND_LIKE_REFERENCE_TYPES.has(entry.referenceType)) return;
        if (entry.referenceType !== 'COURSE_CHANGE' || entry.type !== 'DEBIT') return;
        const comp = entry.feeHeadId ? feeHeadComponentMap.get(entry.feeHeadId) : null;
        breakdown[bucketKey(comp)].paid -= entry.amount;
    });

    // ─── 3. Apply payments ─────────────────────────────────────────────────────────
    payments.forEach((p: any) => {
        if (!isCurrentPayment(p)) return;
        const target = breakdown[bucketKey(componentOfPayment(p))];
        target.paid += p.amount;
        if (p.feeHeadId && !target.feeHeadId) target.feeHeadId = p.feeHeadId;
    });

    // ─── 4. Roll up totals ─────────────────────────────────────────────────────────
    const totalDemanded = Object.values(breakdown).reduce((s, b) => s + b.demanded, 0);
    const totalDiscount = Object.values(breakdown).reduce((s, b) => s + b.discount, 0);

    const courseChangeDeduction = ledgers
        .filter((l: any) => l.referenceType === 'COURSE_CHANGE' && l.type === 'DEBIT')
        .reduce((s, l: any) => s + l.amount, 0);
    const courseChangeFeePaid = sumPayments(p => p.component === PaymentComponent.COURSE_CHANGE_FEE);
    const totalPaid           = sumPayments(isCurrentPayment) - courseChangeDeduction;

    // ─── 5. Unrefunded accommodation credit (money paid on a now-removed acc.) ─────
    const suppressedAccPaid  = sumPayments(p => !isExternalPayment(p) && (isAccSuppressedPayment(p) || isStalePayment(p)));
    const issuedAccRefunds   = sumCorrections(isAccommodationRefund, 'amount');
    const issuedAccRetained  = sumCorrections(isAccommodationRefund, 'retainedAmount');
    const currentAccBucketKeys: readonly string[] =
        accType === AccommodationType.HOSTEL    ? HOSTEL_BREAKDOWN_KEYS :
        accType === AccommodationType.TRANSPORT ? ['TRANSPORT']         : [];
    const currentAccDiscount = currentAccBucketKeys.reduce((s, c) => s + (breakdown[c]?.discount ?? 0), 0);
    const unrefundedAccommodationCredit = Math.max(0,
        suppressedAccPaid - issuedAccRefunds - issuedAccRetained - currentAccDiscount
    );

    // ─── 6. Build summary ──────────────────────────────────────────────────────────
    const summary = {
        totalDemanded,
        totalPaid,
        totalDiscount,
        courseChangeFee: courseChangeDeduction,
        courseChangeFeePaid,
        totalPending: Math.max(0, totalDemanded - totalPaid - totalDiscount),
        unrefundedAccommodationCredit,
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
        Scholarship: breakdown[key].scholarshipAmount,
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
        feeDemands,
        feeCorrections,
        correctionSummary,
    };
};

/**
 * COMPLETE, audit-grade student history — the single source of truth.
 *
 * Aggregates EVERY record across every source the student touched, WITHOUT an
 * isDeleted/status filter, so deleted / reversed / superseded rows are included and
 * flagged (this is the whole point: see what was actually done, not just what survives).
 *
 * Returns:
 *   - sections: complete per-source arrays (payments, demands, ledger, scholarships,
 *               corrections, accommodation, courseChanges, cancellations, auditLog)
 *   - timeline: every event interleaved in chronological order, normalized + flagged
 *   - summary:  one reconciled summary (demand-sourced, option-B discount), plus the
 *               refund liability and counts of deleted/reversed rows.
 *
 * Read-only. Never mutates.
 */
export const getStudentCompleteHistory = async (studentId: string) => {
    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: {
            admissionDetails: {
                include: {
                    allottedCourse: { select: { name: true, degree: true } },
                    hostel: { select: { name: true } },
                    transportRoute: { select: { name: true, cost: true } },
                },
            },
        },
    }) as any;
    if (!student) throw new AppError('Student not found', 404);

    // Soft-fail each source independently so a single missing table/relation never
    // blanks the whole history.
    const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

    const [
        feeHeads, payments, demands, ledger, corrections,
        scholarship, scholarshipAlloc, courseChanges, cancellations,
        hostelAllocs, transportAllocs, accommodationSnapshots, auditLogs,
    ] = await Promise.all([
        safe(prisma.feeHead.findMany({ select: { id: true, name: true, component: true } }), [] as any[]),
        safe(prisma.payment.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } }), [] as any[]),                       // ALL statuses
        safe(prisma.studentFeeDemand.findMany({ where: { studentId }, include: { feeHead: true, feeStructure: { include: { feeHead: true } } }, orderBy: { createdAt: 'asc' } }), [] as any[]), // incl deleted
        safe(prisma.studentLedger.findMany({ where: { studentId }, orderBy: { date: 'asc' } }), [] as any[]),                      // incl deleted
        safe((prisma as any).feeCorrection.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } }), [] as any[]),
        safe(prisma.studentScholarship.findUnique({ where: { studentId } }), null as any),
        safe((prisma as any).scholarshipAllocation.findUnique({ where: { studentId }, include: { rule: true } }), null as any),
        safe(prisma.courseChangeLog.findMany({ where: { studentId }, orderBy: { date: 'asc' } }), [] as any[]),
        safe((prisma as any).cancellationRequest.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } }), [] as any[]),
        safe((prisma as any).hostelAllocation.findMany({ where: { studentId }, orderBy: { startDate: 'asc' } }), [] as any[]),
        safe((prisma as any).transportAllocation.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } }), [] as any[]),
        safe((prisma as any).studentAccommodationPricing.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } }), [] as any[]),
        safe(prisma.auditLog.findMany({ where: { entityId: studentId }, orderBy: { timestamp: 'asc' } }), [] as any[]),
    ]);

    const headName = new Map<string, string>();
    (feeHeads as any[]).forEach(h => headName.set(h.id, h.name));
    const activeDemandIds = new Set((demands as any[]).filter(d => !d.isDeleted).map(d => d.id));

    // ---- SECTIONS (raw rows + audit flags) ----
    const paymentsSection = (payments as any[]).map(p => ({
        ...p,
        isApplicationFee: p.component === PaymentComponent.APPLICATION_FEE,
        countsToPaid: p.status === PaymentStatus.SUCCESS && p.component !== PaymentComponent.APPLICATION_FEE,
    }));

    const demandsSection = (demands as any[]).map(d => ({
        ...d,
        active: !d.isDeleted,
        // when deleted, the remark usually records why (course change / cancellation / reassign)
        removedReason: d.isDeleted ? (d.remarks ?? null) : null,
    }));

    const ledgerSection = (ledger as any[]).map(l => {
        const demandKeyed = l.referenceType === 'FEE_DEMAND' || l.referenceType === 'SCHOLARSHIP';
        const orphaned = demandKeyed && !!l.referenceId && !activeDemandIds.has(l.referenceId);
        return { ...l, active: !l.isDeleted, orphaned };
    });

    // ---- RECONCILED SUMMARY (demand-sourced; option-B discount) ----
    const active = (demands as any[]).filter(d => !d.isDeleted);
    const grossDemanded   = active.reduce((s, d) => s + (d.amount ?? 0), 0);
    const totalDiscount   = active.reduce((s, d) => s + (d.discountAmount ?? 0), 0);      // manual + scholarship
    const scholarshipTotal = active.reduce((s, d) => s + (d.scholarshipAmount ?? 0), 0);
    const netPayable      = active.reduce((s, d) => s + (d.netAmount ?? d.amount ?? 0), 0);
    const paid = (payments as any[])
        .filter(p => p.status === PaymentStatus.SUCCESS && p.component !== PaymentComponent.APPLICATION_FEE)
        .reduce((s, p) => s + (p.amount ?? 0), 0);
    const applicationFeePaid = (payments as any[])
        .filter(p => p.status === PaymentStatus.SUCCESS && p.component === PaymentComponent.APPLICATION_FEE)
        .reduce((s, p) => s + (p.amount ?? 0), 0);
    const refundedPaymentsTotal = (payments as any[])
        .filter(p => p.status === PaymentStatus.REFUNDED)
        .reduce((s, p) => s + (p.amount ?? 0), 0);
    // Money owed back to the student: unsettled fee corrections + cancellation refund credits.
    const pendingCorrectionRefunds = (corrections as any[])
        .filter(c => !c.isSettled).reduce((s, c) => s + (c.amount ?? 0), 0);
    const cancellationRefunds = (ledger as any[])
        .filter(l => l.referenceType === 'CANCELLATION' && l.type === 'CREDIT' && !l.isDeleted)
        .reduce((s, l) => s + (l.amount ?? 0), 0);

    const summary = {
        grossDemanded,
        totalDiscount,
        scholarshipTotal,
        netPayable,
        paid,
        applicationFeePaid,
        pending: Math.max(0, netPayable - paid),
        refundDue: pendingCorrectionRefunds + cancellationRefunds,
        // audit counts — what was changed/removed over the lifetime
        counts: {
            demandsTotal: (demands as any[]).length,
            demandsActive: active.length,
            demandsDeleted: (demands as any[]).length - active.length,
            ledgerTotal: (ledger as any[]).length,
            ledgerOrphaned: ledgerSection.filter(l => l.orphaned).length,
            paymentsTotal: (payments as any[]).length,
            paymentsRefunded: (payments as any[]).filter(p => p.status === PaymentStatus.REFUNDED).length,
            corrections: (corrections as any[]).length,
            courseChanges: (courseChanges as any[]).length,
            cancellations: (cancellations as any[]).length,
        },
        refundedPaymentsTotal,
    };

    // ---- MERGED CHRONOLOGICAL TIMELINE ----
    const timeline: Array<any> = [];
    const at = (...c: any[]) => { for (const d of c) if (d) return new Date(d).toISOString(); return new Date(0).toISOString(); };
    const push = (e: any) => timeline.push(e);

    (payments as any[]).forEach(p => push({
        date: at(p.createdAt), source: 'PAYMENT', type: p.component,
        amount: p.amount, sign: '+', status: p.status,
        flags: { refunded: p.status === PaymentStatus.REFUNDED, applicationFee: p.component === PaymentComponent.APPLICATION_FEE },
        description: `Payment ${p.amount} (${p.component} / ${p.method ?? p.mode}) — ${p.status}`, ref: p.id,
    }));
    demandsSection.forEach(d => push({
        date: at(d.createdAt), source: 'FEE_DEMAND', type: headName.get(d.feeHeadId) ?? d.feeStructure?.feeHead?.name ?? 'Fee',
        amount: d.amount, sign: '-', status: d.status,
        flags: { deleted: d.isDeleted, scholarship: d.scholarshipAmount ?? 0, discount: d.discountAmount ?? 0 },
        description: `Demand ${d.amount} (net ${d.netAmount}) ${d.isDeleted ? '[DELETED: ' + (d.removedReason ?? '') + ']' : ''}`.trim(), ref: d.id,
    }));
    ledgerSection.forEach(l => push({
        date: at(l.date, l.createdAt), source: `LEDGER:${l.referenceType}`, type: l.type,
        amount: l.amount, sign: l.type === 'CREDIT' ? '+' : '-', status: l.isDeleted ? 'DELETED' : 'ACTIVE',
        flags: { deleted: l.isDeleted, orphaned: l.orphaned },
        description: l.description ?? '', ref: l.id,
    }));
    (corrections as any[]).forEach(c => push({
        date: at(c.createdAt), source: 'FEE_CORRECTION', type: c.type,
        amount: c.amount, sign: '+', status: c.isSettled ? 'SETTLED' : 'PENDING',
        flags: { settled: c.isSettled, carryForward: c.carryForward },
        description: `${c.reason ?? c.type} — ${c.isSettled ? 'settled' : 'pending refund'}`, ref: c.id,
    }));
    (courseChanges as any[]).forEach(c => push({
        date: at(c.date, c.createdAt), source: 'COURSE_CHANGE', type: 'COURSE_CHANGE',
        amount: null, sign: null, status: 'DONE', flags: {},
        description: `Course change ${c.oldCourse} → ${c.newCourse}${c.oldDegree ? ` (${c.oldDegree}→${c.newDegree})` : ''}`, ref: c.id,
    }));
    (cancellations as any[]).forEach(c => push({
        date: at(c.approvedAt, c.updatedAt, c.createdAt), source: 'CANCELLATION', type: c.conditionType ?? 'CANCELLATION',
        amount: c.refundAmount ?? null, sign: c.refundAmount ? '+' : null, status: c.status,
        flags: { deduction: c.deductionAmount, cancellationFee: c.cancellationFee },
        description: `Seat cancellation (${c.status}) — refund ${c.refundAmount ?? 0}, deduction ${c.deductionAmount ?? 0}`, ref: c.id,
    }));
    (accommodationSnapshots as any[]).forEach(s => push({
        date: at(s.createdAt), source: 'ACCOMMODATION_PRICING', type: `${s.sharing ? 'SHARING_' + s.sharing : ''} ${s.roomType ?? ''}`.trim(),
        amount: s.effectiveTotal ?? null, sign: '-', status: s.isActive ? 'ACTIVE' : 'SUPERSEDED',
        flags: { active: s.isActive, paymentMode: s.paymentMode, pricingSource: s.pricingSource },
        description: `Hostel pricing snapshot ${s.effectiveTotal} (${s.paymentMode}) ${s.isActive ? '' : '[superseded]'}`.trim(), ref: s.id,
    }));
    (hostelAllocs as any[]).forEach(h => push({
        date: at(h.startDate, h.createdAt), source: 'HOSTEL_ALLOCATION', type: 'BED',
        amount: null, sign: null, status: h.status, flags: { bedId: h.bedId },
        description: `Hostel bed allocation — ${h.status}`, ref: h.id,
    }));
    (transportAllocs as any[]).forEach(tr => push({
        date: at(tr.createdAt, tr.startDate), source: 'TRANSPORT_ALLOCATION', type: 'ROUTE',
        amount: null, sign: null, status: tr.status, flags: {},
        description: `Transport allocation — ${tr.status}`, ref: tr.id,
    }));
    (auditLogs as any[]).forEach(a => push({
        date: at(a.timestamp), source: `AUDIT:${a.entity}`, type: a.action,
        amount: null, sign: null, status: 'INFO', flags: {},
        description: typeof a.details === 'object' ? JSON.stringify(a.details).slice(0, 160) : String(a.details ?? ''), ref: a.id,
    }));

    timeline.sort((a, b) => a.date.localeCompare(b.date));

    // Presigned invoice URLs for payments (best-effort).
    const paymentsWithUrls = await Promise.all(paymentsSection.map(async p => ({
        ...p, invoiceUrl: p.invoiceUrl ? await convertToPresignedUrl(p.invoiceUrl).catch(() => p.invoiceUrl) : null,
    })));

    return {
        student: {
            id: student.id,
            name: student.name,
            applicationId: student.applicationId,
            admissionStatus: student.admissionDetails?.status ?? null,
            course: student.admissionDetails?.allottedCourse?.name ?? null,
            accommodationType: student.admissionDetails?.accommodationType ?? null,
        },
        summary,
        scholarship: scholarship
            ? { percentage: scholarship.scholarshipPercentage, isEligible: scholarship.isEligible, type: scholarship.type, remarks: scholarship.remarks, allocation: scholarshipAlloc }
            : null,
        sections: {
            payments: paymentsWithUrls,
            demands: demandsSection,
            ledger: ledgerSection,
            corrections,
            accommodation: { snapshots: accommodationSnapshots, hostelAllocations: hostelAllocs, transportAllocations: transportAllocs },
            courseChanges,
            cancellations,
            auditLog: auditLogs,
        },
        timeline,
    };
};

/**
 * Get a chronological flowchart of all financial events for a student.
 * Returns a timeline that clearly explains: what happened, when, how much, and the running balance.
 */
/** Chronological money-flow timeline (debits/credits in order) for a student's account statement view. */
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
