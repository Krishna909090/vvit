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
import { sendHostelAllotmentEmail } from '../../utils/emailService';
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

export const getPhonePeClient = (type: 'ADMISSION' | 'HOSTEL' | 'MESS' = 'ADMISSION') => {
    if (clients[type]) {
        return clients[type];
    }

    const creds = PHONEPE_CREDENTIALS[type] || PHONEPE_CREDENTIALS.ADMISSION;
    logger.info(`[PhonePe] Initializing client for ${type} (Merchant: ${creds.MERCHANT_ID})`);

    // @ts-ignore — PhonePe SDK exposes constructor as private in typings but it is callable
    clients[type] = new StandardCheckoutClient(creds.MERCHANT_ID, creds.SALT_KEY, creds.SALT_INDEX as any, ENV);

    return clients[type];
};

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

const resolveComponent = async (componentName: string, feeHeadId?: string): Promise<{ component: PaymentComponent, feeHeadId?: string }> => {
    const normalize = (s: string) => s.toUpperCase().replace(/ /g, '_');
    const input = normalize(componentName);

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

    const mapped = nameMap[input] || nameMap[input.replace(/_/g, ' ')];
    if (mapped) return { component: mapped, feeHeadId };

    const validComponents = Object.values(PaymentComponent) as string[];
    if (validComponents.includes(input)) {
        return { component: input as PaymentComponent, feeHeadId };
    }

    try {
        const feeHead = await prisma.feeHead.findFirst({
            where: { name: { equals: componentName, mode: 'insensitive' } }
        });

        if (feeHead) {

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

    const PHONEPE_ORDER_EXPIRY_MS = 20 * 60 * 1000;
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

                transactionId = existingPending.providerTxId;
                createdPayment = existingPending;
                logger.info(`[initiateApplicationFeePayment] Reusing fresh PENDING payment ${existingPending.id} (age: ${Math.round(ageMs / 1000)}s) txnId=${transactionId}`);
            } else {

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

    payLog.info('GATEWAY_INIT', `Initiating PhonePe payment`, { studentId, applicationId: student.applicationId, txnId: transactionId, amount });
    const redirectUrl = `${process.env.FRONTEND_URL}/student/payment?txnId=${transactionId}`;

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

export const initiateMultiComponentPayment = async (
    studentId: string,
    rawComponents: { component: string | PaymentComponent, amount: number, feeHeadId?: string }[],
    userId?: string,
    paymentMethod: PaymentMethod = PaymentMethod.UPI,
    remarks?: string,
    referenceNumber?: string,
    mode?: string,
    payloadYearOfStudy?: number
) => {
    logger.info(`[initiateMultiComponentPayment] Student=${studentId}, Components=${JSON.stringify(rawComponents)}, Method=${paymentMethod}, Mode=${mode}, Ref=${referenceNumber}`);

    const components: { component: PaymentComponent, amount: number, feeHeadId?: string }[] = [];
    for (const c of rawComponents) {
        logger.debug(`[initiateMultiComponentPayment] Resolving component: ${c.component}`);
        const r = await resolveComponent(c.component as string, c.feeHeadId);
        components.push({ ...c, ...r });
    }

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

    if (isOffline && referenceNumber && paymentMethod !== PaymentMethod.CASH) {
        const existingPayment = await prisma.payment.findFirst({
            where: { referenceNumber, studentId, status: PaymentStatus.SUCCESS }
        });
        if (existingPayment) {
            throw new AppError(`Duplicate payment: reference number '${referenceNumber}' already used for this student`, 409);
        }
    }

    const paymentIds: string[] = [];
    const createdPayments: any[] = [];

    await prisma.$transaction(async (tx) => {
        const activeYear = await tx.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });

        if (isOffline && referenceNumber && paymentMethod !== PaymentMethod.CASH) {
            const duplicate = await tx.payment.findFirst({
                where: { referenceNumber, studentId, status: { in: [PaymentStatus.SUCCESS, PaymentStatus.PENDING] } }
            });
            if (duplicate) {
                throw new AppError(`Duplicate payment: reference number '${referenceNumber}' already used`, 409);
            }
        }

        for (const item of components) {

            let feeDemandId: string | undefined;
            let yearOfStudy: number | undefined;
            if (item.feeHeadId) {
                const demandOR = [
                    { feeHeadId: item.feeHeadId },
                    { feeStructure: { feeHeadId: item.feeHeadId } },
                ];

                let demand = await tx.studentFeeDemand.findFirst({
                    where: { studentId, isDeleted: false, status: { in: [FeeStatus.PENDING, FeeStatus.PARTIAL] }, OR: demandOR },
                    orderBy: { dueDate: 'asc' },
                    select: { id: true, yearOfStudy: true, academicYearId: true },
                });

                if (!demand) {
                    demand = await tx.studentFeeDemand.findFirst({
                        where: { studentId, isDeleted: false, status: FeeStatus.FULL, OR: demandOR },
                        orderBy: { dueDate: 'desc' },
                        select: { id: true, yearOfStudy: true, academicYearId: true },
                    });
                    if (demand) {
                        logger.warn(`[createPayment] No PENDING/PARTIAL demand for student=${studentId} component=${item.component} feeHeadId=${item.feeHeadId} — linking to existing FULL demand ${demand.id}`);
                    } else {
                        logger.warn(`[createPayment] No demand found at all for student=${studentId} component=${item.component} feeHeadId=${item.feeHeadId} — feeDemandId will be null`);
                    }
                }

                if (demand) {
                    feeDemandId = demand.id;
                    yearOfStudy = demand.yearOfStudy ?? undefined;
                }
            }

            if (!yearOfStudy) {
                yearOfStudy = payloadYearOfStudy ?? await getStudentYearOfStudy(studentId, tx);
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
                    collectedBy: userId,
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

const extractPhonePeUtr = (metadata: any): string | null => {
    if (!metadata) return null;
    // Old PhonePe S2S v1 format: data.paymentInstrument.utr / bankTransactionId
    const instr = metadata?.data?.paymentInstrument;
    if (instr?.utr) return instr.utr;
    if (instr?.bankTransactionId) return instr.bankTransactionId;
    if (metadata?.data?.transactionId) return metadata.data.transactionId;
    // New PhonePe webhook v2 format: paymentDetails[].utr / transactionId
    const detail = metadata?.paymentDetails?.[0];
    if (detail?.utr) return detail.utr;
    if (detail?.transactionId) return detail.transactionId;
    if (metadata?.orderId) return metadata.orderId;
    return null;
};

const processMultiPaymentSuccess = async (payments: any[], metadata: any) => {
    if (!payments || payments.length === 0) return;
    const txnId = payments[0].providerTxId;
    const studentId = payments[0].studentId;
    const applicationId = payments[0].student?.applicationId;
    payLog.info('PROCESSING', `Processing ${payments.length} payment(s)`, { txnId, studentId, applicationId, count: payments.length });
    logger.info(`[processMultiPaymentSuccess] Processing ${payments.length} payments. Ref=${txnId}`);

    const pendingPayments = payments.filter(p => p.status === PaymentStatus.PENDING);
    if (pendingPayments.length === 0) {
        logger.info(`[processMultiPaymentSuccess] No PENDING payments to process (already handled) — skipping. Ref=${payments[0].providerTxId}`);
        return;
    }
    if (pendingPayments.length < payments.length) {
        logger.warn(`[processMultiPaymentSuccess] ${payments.length - pendingPayments.length} payment(s) not PENDING, processing remaining ${pendingPayments.length}. Ref=${payments[0].providerTxId}`);
    }

    const utr = extractPhonePeUtr(metadata);

    let flippedCount = 0;
    await prisma.$transaction(async (tx) => {
        const statusFlip = await tx.payment.updateMany({
            where: { id: { in: pendingPayments.map((p: any) => p.id) }, status: PaymentStatus.PENDING },
            data: {
                status: PaymentStatus.SUCCESS,
                metadata,
                ...(utr ? { referenceNumber: utr } : {})
            }
        });
        flippedCount = statusFlip.count;
        if (flippedCount === 0) return;

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

    for (const payment of pendingPayments) {
        try {
            await _processComponentLogic(payment);
        } catch (e) {
            payLog.error('COMPONENT_LOGIC_FAILED', `Post-success component logic failed: ${e}`, { studentId, component: payment.component });
        }
    }

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

    let invoiceUrl = null;
    try {
        const invoiceResult = await InvoiceService.generateInvoiceForPayment(payments[0].id);
        invoiceUrl = invoiceResult.invoiceUrl;
        payLog.info('INVOICE_GENERATED', `Invoice generated`, { studentId, applicationId, txnId, invoiceNumber: invoiceResult.invoiceNumber });
    } catch (e) {
        payLog.error('INVOICE_FAILED', `Invoice generation failed: ${e}`, { studentId, applicationId, txnId });
    }

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

            }
         }
    } else if (component === PaymentComponent.TUITION || component === PaymentComponent.ADMISSION || component === PaymentComponent.SCHOLARSHIP_TOKEN) {
        if ((component === PaymentComponent.SCHOLARSHIP_TOKEN || component === PaymentComponent.TUITION) && currentStatus?.status !== AdmissionStatus.ADMISSION_CONFIRMED && currentStatus?.status !== AdmissionStatus.ENROLLED) {
             await ScholarshipService.lockAllocation(studentId);

             const existingDemands = await prisma.studentFeeDemand.count({ where: { studentId, isDeleted: false } });
             if (existingDemands === 0) {
                 const detailedStudent = await prisma.student.findUnique({ where: { id: studentId }, include: { admissionDetails: { include: { hostel: true, transportRoute: true } } }});
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
                     if (ledgers.length > 0) await prisma.studentLedger.createMany({ data: ledgers });
                 }
             } else {
                 logger.info(`[_processComponentLogic] Skipping FEE_GENERATION for student=${studentId} — ${existingDemands} fee demands already exist`);
             }
        }

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

const COMPONENT_RESOLVABLE = new Set<PaymentComponent>([
    PaymentComponent.HOSTEL,
    PaymentComponent.HOSTEL_ACCOMMODATION,
    PaymentComponent.HOSTEL_MESS,
    PaymentComponent.HOSTEL_LAUNDRY,
    PaymentComponent.HOSTEL_REGISTRATION,
    PaymentComponent.TRANSPORT,
]);

const _settleFeeDemands = async (payment: any, db: any = prisma) => {
    let targetDemandId = payment.feeDemandId;
    let resolvedFeeHeadId = payment.feeHeadId ?? null;

    if (!resolvedFeeHeadId && COMPONENT_RESOLVABLE.has(payment.component)) {
        const feeHead = await db.feeHead.findFirst({
            where: { component: payment.component, isDeleted: false },
            select: { id: true },
        });
        if (feeHead) {
            resolvedFeeHeadId = feeHead.id;

            await db.payment.update({
                where: { id: payment.id },
                data: { feeHeadId: resolvedFeeHeadId },
            });
            payment.feeHeadId = resolvedFeeHeadId;
        }
    }

    if (!targetDemandId && resolvedFeeHeadId) {
        const demandOR = [
            { feeHeadId: resolvedFeeHeadId },
            { feeStructure: { feeHeadId: resolvedFeeHeadId } },
        ];

        let matchingDemand = await db.studentFeeDemand.findFirst({
            where: { studentId: payment.studentId, isDeleted: false, status: { in: [FeeStatus.PENDING, FeeStatus.PARTIAL] }, OR: demandOR },
            orderBy: { dueDate: 'asc' },
        });

        if (!matchingDemand) {
            matchingDemand = await db.studentFeeDemand.findFirst({
                where: { studentId: payment.studentId, isDeleted: false, status: FeeStatus.FULL, OR: demandOR },
                orderBy: { dueDate: 'desc' },
            });
            if (matchingDemand) {
                logger.warn(`[_settleFeeDemands] No PENDING/PARTIAL demand for payment=${payment.id} component=${payment.component} — linking to FULL demand ${matchingDemand.id}`);
            } else {
                logger.warn(`[_settleFeeDemands] No demand found for payment=${payment.id} component=${payment.component} feeHeadId=${resolvedFeeHeadId} — feeDemandId will remain null`);
            }
        }

        if (matchingDemand) targetDemandId = matchingDemand.id;
    }

    if (targetDemandId) {
        const demand = await db.studentFeeDemand.findUnique({ where: { id: targetDemandId } });
        if (demand) {
            const resolvedYear = demand.yearOfStudy ?? await getStudentYearOfStudy(payment.studentId, db);

            await db.payment.update({
                where: { id: payment.id },
                data: {
                    feeDemandId: targetDemandId,
                    feeHeadId: resolvedFeeHeadId ?? undefined,
                    academicYearId: demand.academicYearId ?? undefined,
                    yearOfStudy: resolvedYear,
                }
            });

            payment.feeDemandId = targetDemandId;
            payment.feeHeadId = resolvedFeeHeadId;
            payment.academicYearId = demand.academicYearId ?? null;
            payment.yearOfStudy = resolvedYear;

            if (demand.status !== FeeStatus.FULL) {
                const priorPaid = await db.payment.aggregate({
                    where: { feeDemandId: targetDemandId, status: 'SUCCESS', isDeleted: false, id: { not: payment.id } },
                    _sum: { amount: true },
                });
                const paid = (priorPaid._sum.amount ?? 0) + payment.amount;
                const targetAmount = demand.netAmount ?? demand.amount;
                const newStatus = paid >= targetAmount ? FeeStatus.FULL : FeeStatus.PARTIAL;
                await db.studentFeeDemand.update({
                    where: { id: demand.id },
                    data: { status: newStatus as any },
                });
            }
        }
    }

    else {
        if (!resolvedFeeHeadId) {
            logger.warn(`[_settleFeeDemands] payment=${payment.id} component=${payment.component} has no feeHeadId — cannot link to a demand; skipping demand settlement to avoid cross-component sweep.`);
            await recomputeStudentTotals(payment.studentId, db);
            return;
        }

        const demandWhere: any = {
            studentId: payment.studentId,
            isDeleted: false,
            status: FeeStatus.PENDING,
            OR: [
                { feeHeadId: resolvedFeeHeadId },
                { feeStructure: { feeHeadId: resolvedFeeHeadId } },
            ],
        };

        const pendingDemands = await db.studentFeeDemand.findMany({
            where: demandWhere,
            orderBy: { dueDate: 'asc' }
        });

        if (pendingDemands.length > 0) {
            const first = pendingDemands[0];

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

    await recomputeStudentTotals(payment.studentId, db);
};

const _createPaymentLedger = async (payment: any, db: any = prisma) => {

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

    const convenorAllotTrigger = payments.find(p => p.metadata?.targetAction === 'CONVENOR_ALLOT');
    if (convenorAllotTrigger) {
        try {
            const { ConvenorAdmissionService } = require('../convenorAdmission/convenorAdmission.service');
            await ConvenorAdmissionService.completeAllotAfterPayment(convenorAllotTrigger);
        } catch (err) {
            logger.error(`[_handleTriggers] CONVENOR_ALLOT completion error: ${err}`);
        }
    }
};

export const recordOfflineApplicationFeePayment = async (studentId: string, paymentMethod: PaymentMethod, transactionId?: string, remarks?: string, adminId?: string, referenceNumber?: string) => {
    const amount = await getApplicationFeeAmount();

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', 404);

    const admission = await prisma.studentAdmission.findUnique({ where: { studentId } });
    if (!admission) throw new AppError('Student admission record not found. Please ensure the student has completed registration.', 400);

    const providerTxId = transactionId || `CASH_${Date.now()}_${studentId.substring(0, 8)}`;

    const result = await prisma.$transaction(async (tx) => {
        const activeYear = await tx.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });
        const yearOfStudy = await getStudentYearOfStudy(studentId, tx);

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

    await processSinglePaymentSuccess({ ...result, student }, { remarks, adminId });

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

    const decodedBuffer = Buffer.from(base64Payload, 'base64');
    const decodedString = decodedBuffer.toString('utf-8');
    const decodedPayload = JSON.parse(decodedString);
    const { merchantTransactionId, code, merchantId } = decodedPayload;

    webhookLog.info('DECODED', `Callback decoded`, { txnId: merchantTransactionId, code, merchantId });

    let saltKey = PHONEPE_CREDENTIALS.ADMISSION.SALT_KEY;
    let saltIndex = PHONEPE_CREDENTIALS.ADMISSION.SALT_INDEX;

    if (merchantId === PHONEPE_CREDENTIALS.HOSTEL.MERCHANT_ID) {
        saltKey = PHONEPE_CREDENTIALS.HOSTEL.SALT_KEY;
        saltIndex = PHONEPE_CREDENTIALS.HOSTEL.SALT_INDEX;
    }

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

export const handleNewWebhook = async (body: any, authHeader: string) => {

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

    const payments = await prisma.payment.findMany({
        where: { providerTxId: merchantOrderId },
        include: { student: true }
    });

    if (payments.length === 0) {
        logger.warn(`[Webhook] No payments found for merchantOrderId=${merchantOrderId}`);
        return { status: 'OK', message: 'No matching payments' };
    }

    logger.info(`[Webhook] Found ${payments.length} payment(s) for merchantOrderId=${merchantOrderId}`);

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

            break;
        }

        case 'pg.refund.failed': {
            logger.warn(`[Webhook] Refund failed: refundId=${payload.refundId}, originalOrder=${payload.originalMerchantOrderId}, error=${payload.errorCode}`);

            break;
        }

        default:
            logger.warn(`[Webhook] Unknown event type: ${type}`);
    }

    return { status: 'OK' };
};

export const payTestFee = async (studentId: string, _userId: string | null) => {
    const { redirectUrl, paymentId } = await initiateApplicationFeePayment(studentId);
    return { redirectUrl, paymentId };
};

export const payCollegeFee = async (studentId: string, data: any, _userId: string | null) => {
    const { hostelSelection, transportSelection, paymentDetails } = data;
    const { } = paymentDetails || {};

    const student = await prisma.student.findUnique({
        where: { id: studentId },
        include: { admissionDetails: true }
    });

    if (!student || !student.admissionDetails) {
        throw new AppError('Student admission details not found', 404);
    }

    if (student.admissionDetails.status !== AdmissionStatus.SEAT_ALLOTTED && 
        student.admissionDetails.status !== AdmissionStatus.ADMISSION_CONFIRMED) {
        throw new AppError('Seat not allotted yet. Cannot pay college fee.', 400);
    }

    const transactionId = `TXN_${Date.now()}_${studentId.replace(/-/g, '').substring(0, 6)}`;

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

        accommodationFee = Math.max(0, accommodationFee - paidAccommodation);
        messFee = Math.max(0, messFee - paidMess);
    }

    if (transportSelection?.routeId) {
        const route = await prisma.transportRoute.findUnique({ where: { id: transportSelection.routeId } });
        if (!route) throw new AppError('Selected transport route not found', 404);

        const paidTransport = paidComponents.filter(p => p.component === PaymentComponent.TRANSPORT).reduce((s,p) => s + p.amount, 0);
        transportFee = Math.max(0, route.cost - paidTransport);
    }

    let amountToPay = 0;
    let paymentComponent: PaymentComponent = PaymentComponent.TUITION;

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

        return { redirectUrl: null, message: "All fees paid" };
    }

    await prisma.$transaction(async (tx) => {

        if (hostelSelection || transportSelection) {
            const updateData: any = {};
            if (hostelSelection?.hostelId) { updateData.hostelId = hostelSelection.hostelId; updateData.accommodationType = 'HOSTEL'; }
            if (transportSelection?.routeId) { updateData.accommodationType = 'TRANSPORT'; updateData.transportRouteId = transportSelection.routeId; }
            if (Object.keys(updateData).length > 0) {
                 await tx.studentAdmission.update({ where: { studentId }, data: updateData });
            }
        }
    });

    let { feeHeadId: callerFeeHeadId, feeDemandId: callerFeeDemandId } = paymentDetails || {};

    if (!callerFeeHeadId) {
        const feeHead = await prisma.feeHead.findFirst({
            where: { component: paymentComponent as any, isDeleted: false },
            select: { id: true },
        });
        if (feeHead) callerFeeHeadId = feeHead.id;
    }

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

    try {
        const redirectUrl = `${process.env.FRONTEND_URL}/payment/status?txnId=${transactionId}`;
        const feeType = await resolvePhonePeClientType(studentId, paymentComponent);
        const client = getPhonePeClient(feeType);

        const request = StandardCheckoutPayRequest.builder()
            .merchantOrderId(transactionId)

            .amount(Math.round(amountToPay * 100))
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

export const getAllSuccessPayments = async (query: any) => {
    const page = Math.max(1, parseInt(String(query.page || 1)));
    const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || 25))));
    const skip = (page - 1) * limit;

    const where: any = {
        status: PaymentStatus.SUCCESS,
        isDeleted: false
    };

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

    const dateRange = query.dateRange ? String(query.dateRange).toLowerCase() : null;
    if (dateRange && dateRange !== 'custom' && dateRange !== 'all') {
        const IST_MS = 5.5 * 60 * 60 * 1000;
        const nowIST = new Date(new Date().getTime() + IST_MS);
        const istDayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_MS);
        const todayStart = istDayStart(nowIST);
        const DAY_MS = 24 * 60 * 60 * 1000;
        let gte: Date | undefined, lte: Date | undefined;

        if (dateRange === 'today') {
            gte = todayStart; lte = new Date(todayStart.getTime() + DAY_MS - 1);
        } else if (dateRange === 'yesterday') {
            gte = new Date(todayStart.getTime() - DAY_MS); lte = new Date(todayStart.getTime() - 1);
        } else if (dateRange === '7d') {
            gte = new Date(todayStart.getTime() - 7 * DAY_MS); lte = new Date(todayStart.getTime() + DAY_MS - 1);
        } else if (dateRange === '15d') {
            gte = new Date(todayStart.getTime() - 15 * DAY_MS); lte = new Date(todayStart.getTime() + DAY_MS - 1);
        } else if (dateRange === '30d') {
            gte = new Date(todayStart.getTime() - 30 * DAY_MS); lte = new Date(todayStart.getTime() + DAY_MS - 1);
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

    const creatorIds = [...new Set(payments.map(p => p.createdBy).filter(Boolean) as string[])];
    const creators = creatorIds.length > 0
        ? await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } })
        : [];
    const creatorMap = Object.fromEntries(creators.map(c => [c.id, c.name]));

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

export const exportSuccessPaymentsCsv = async (query: any) => {

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
         const activeYear = await tx.academicYear.findFirstOrThrow({
             where: { isActive: true, isDeleted: false }
         });

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

        if (payment.status === PaymentStatus.SUCCESS) {
            logger.warn(`Payment ${paymentId} is SUCCESS but missing invoiceUrl. Attempting to regenerate...`);
            await processSinglePaymentSuccess(payment, payment.metadata);

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

const getS3KeyFromUrl = (url: string): string | null => {
    const keyMatch = url.match(/(student\/.*\.pdf)/);
    if (keyMatch) return keyMatch[1];
    
    const parts = url.split('amazonaws.com/');
    if (parts.length > 1) return parts[1];

    return null;
};

export const getAllotmentOrderUrl = async (studentId: string, regenerate: boolean = false) => {

    let doc = await prisma.studentDocument.findUnique({
        where: {
            studentId_documentKey: {
                studentId,
                documentKey: 'ALLOTMENT_ORDER'
            }
        }
    });

    if (!doc || regenerate) {
        await generateAndSaveAllotmentOrder(studentId);

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

    return await convertToPresignedUrl(doc.url) || doc.url;
};

export const initiateTokenPayment = async (studentId: string, data: any = {}) => {
    const TOKEN_AMOUNT = 10000;

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student) throw new AppError('Student not found', 404);

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

export const getStudentFinancialSummary = async (studentId: string) => {

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

    const payments = await prisma.payment.findMany({
        where: {
            studentId,
            status: PaymentStatus.SUCCESS
        }
    });

    const summary = {
        applicationFee: { expected: 0, paid: 0, pending: 0, status: 'PENDING' },
        collegeFee: { expected: 0, paid: 0, pending: 0, breakdown: {}, status: 'PENDING' },
        totalPaid: 0
    };

    summary.applicationFee.expected = await getApplicationFeeAmount();
    summary.applicationFee.paid = payments
        .filter(p => p.component === PaymentComponent.APPLICATION_FEE)
        .reduce((sum, p) => sum + p.amount, 0);
    
    summary.applicationFee.pending = Math.max(0, summary.applicationFee.expected - summary.applicationFee.paid);
    summary.applicationFee.status = summary.applicationFee.pending === 0 ? 'PAID' : (summary.applicationFee.paid > 0 ? 'PARTIAL' : 'PENDING');

    const baseTuition = (student.admissionDetails.totalFee ?? 0) > 0 ? (student.admissionDetails.totalFee ?? 0) : 25000;
    let hostelFee = 0;
    let transportFee = 0;

    logger.info(`[FinancialSummary] Student: ${studentId}, HostelType: ${student.admissionDetails.hostelType}, Mode: ${student.admissionDetails.hostelPaymentMode}`);

    const snap = await getOrCreateAccommodationPricing(studentId);
    if (snap) {
        hostelFee = (snap.accommodationPrice ?? 0)
                    + (snap.messPrice ?? 0)
                    + (snap.laundryPrice ?? 0)
                    + (snap.registrationFee ?? 0);
        logger.info(`[FinancialSummary] Snapshot used: total=${hostelFee} (mode=${snap.paymentMode})`);
    }

    if (student.admissionDetails.transportRouteId) {
        transportFee = student.admissionDetails.transportRoute?.cost || 0;
    }

    summary.collegeFee.breakdown = {
        tuition: baseTuition,
        hostel: hostelFee,
        transport: transportFee
    };

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

    let scholarshipAmount = 0;

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

    (summary.collegeFee as any).discount = totalDiscount;
    (summary.collegeFee as any).scholarship = scholarshipAmount;
    (summary.collegeFee as any).manualDiscount = manualDiscountAmount;

    summary.collegeFee.pending = Math.max(0, summary.collegeFee.expected - (summary.collegeFee.paid + totalDiscount));
    summary.collegeFee.status = summary.collegeFee.pending === 0 ? 'PAID' : (summary.collegeFee.paid > 0 ? 'PARTIAL' : 'PENDING');

    summary.totalPaid = summary.collegeFee.paid;

    return summary;
};

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
                studentScholarship: true
            }
        });

        if (student && student.admissionDetails) {
             const reportingDate = new Date();
             reportingDate.setDate(reportingDate.getDate() + 7);

             let profilePhotoUrl = undefined;
             if (student.profilePhotoUrl) {
                 profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl) || undefined;
             }

             const financialHistory = await getStudentFinancialHistory(studentId);
             const { summary, breakdown } = financialHistory;
             const totalPending = summary.totalPending;

             const isFeesReimbursement = student.convenorDetails?.feesReimbursement === true;

             const tuitionFee = isFeesReimbursement ? 0 : (breakdown['TUITION']?.demanded || 0);

             let scholarshipDiscount = isFeesReimbursement ? 0 : (breakdown['TUITION']?.scholarshipAmount || 0);

             let scholarshipPercentage = 0;
             if (!isFeesReimbursement && student.studentScholarship?.scholarshipPercentage) {
                scholarshipPercentage = student.studentScholarship.scholarshipPercentage;
             }

             if (!isFeesReimbursement && scholarshipDiscount === 0 && scholarshipPercentage > 0 && tuitionFee > 0) {
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

                allottedCategory: student.convenorDetails?.category || `${student.category}_GEN_AU`,
                reportingDate: format(reportingDate, 'dd.MM.yyyy'),
                phase: 'First Phase',
                feeReimbursement: student.convenorDetails?.feesReimbursement === true ? 'YES' : undefined,
                profilePhotoUrl: profilePhotoUrl,
                totalPending: totalPending,
                scholarshipPercentage,
                scholarshipDiscount,
                tuitionFee,
            };

            const pdfBuffer = await generateAllotmentOrderPDF(allotmentData);

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

        if (student.email) {
            sendHostelAllotmentEmail(student.email, {
                studentName: allotmentData.studentName,
                applicationId: allotmentData.applicationId,
                hostelName: allotmentData.hostelName,
                roomNumber: allotmentData.roomNumber,
                bedNumber: allotmentData.bedNumber,
                floor: allotmentData.floor,
                sharing: allotmentData.sharing,
                roomType: allotmentData.roomType,
                paymentMode: allotmentData.paymentMode,
                effectiveTotal: allotmentData.effectiveTotal,
            }, pdfBuffer).catch((err: any) => {
                logger.warn(`[HostelAllotment] Email send failed for student ${studentId}: ${err?.message}`);
            });
        }

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

export const processUnifiedPayment = async (data: any) => {
    const { studentId, amount, mode, method, component: rawComponent, feeHeadId: rawFeeHeadId, remarks, initiatedBy, referenceNumber, redirectUrl, yearOfStudy: payloadYearOfStudy } = data;
    logger.info(`[processUnifiedPayment] START - StudentId=${studentId}, Amount=${amount}, Mode=${mode}, Method=${method}, Component=${rawComponent}, InitiatedBy=${initiatedBy}`);

    logger.debug(`[processUnifiedPayment] Resolving component: ${rawComponent}`);
    const { component, feeHeadId: _feeHeadId } = await resolveComponent(rawComponent, rawFeeHeadId);
    let feeHeadId: string | null = _feeHeadId ?? null;
    logger.info(`[processUnifiedPayment] Component resolved to: ${component}, FeeHeadId=${feeHeadId || 'N/A'}`);

    if (!studentId) throw new AppError('Student ID is required', 400);
    if (!amount || typeof amount !== 'number' || amount <= 0) throw new AppError('Amount must be a positive number', 400);
    
    if (!Object.values(PaymentMode).includes(mode)) {
        throw new AppError(`Invalid Payment Mode. Allowed: ${Object.values(PaymentMode).join(', ')}`, 400);
    }

    if (mode === PaymentMode.OFFLINE && !referenceNumber) {
        throw new AppError('Reference Number is required for OFFLINE payments', 400);
    }

    if (mode === PaymentMode.OFFLINE && referenceNumber && data.method !== PaymentMethod.CASH) {
        const existingRef = await prisma.payment.findFirst({
            where: { referenceNumber: referenceNumber }
        });
        if (existingRef) {
            throw new AppError(`Payment with Reference Number '${referenceNumber}' already exists`, 409);
        }
    }

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
        resolvedYearOfStudy = payloadYearOfStudy ?? await getStudentYearOfStudy(studentId);
    }

    const providerTxId = mode === PaymentMode.OFFLINE 
        ? (referenceNumber || `CASH_${Date.now()}_${studentId.substring(0, 8)}`)
        : `TXN_${Date.now()}_${studentId.substring(0, 8)}`;
    logger.info(`[processUnifiedPayment] Transaction ID generated: ${providerTxId}`);

    logger.info(`[processUnifiedPayment] Creating payment record with status=PENDING`);

    const unifiedYear = await getActiveAcademicYear();

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
                createdBy: initiatedBy,
                metadata: { remarks, source: 'UNIFIED_API' },
                academicYearId: unifiedYear.id
            }
        });
    } catch (e: any) {

        if (e?.code === 'P2002') {
            throw new AppError('A payment with this reference is already in progress for this student. Please refresh and try again.', 409);
        }
        throw e;
    }

    logger.info(`[processUnifiedPayment] Payment record created: ID=${payment.id}, Status=${payment.status}`);

    if (mode === PaymentMode.OFFLINE) {
        logger.info(`[processUnifiedPayment] Processing OFFLINE payment immediately`);

        const successResult = await processSinglePaymentSuccess({ ...payment, student }, { remarks, adminId: initiatedBy });
        
        const presignedInvoiceUrl = await convertToPresignedUrl(successResult?.invoiceUrl);
        logger.info(`[processUnifiedPayment] OFFLINE payment processed successfully. InvoiceUrl=${presignedInvoiceUrl ? 'Generated' : 'N/A'}`);

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

        try {
            const path = redirectUrl ?? '/admin/fees/offlinepayments';
            const queryParams = redirectUrl 
                ? `studentId=${student.id}&paymentId=${payment.id}`
                : `appId=${student.applicationId}&paymentId=${payment.id}`;
            const finalRedirectUrl = `${process.env.FRONTEND_URL_ADMISSION}${path}?${queryParams}`;
            
            logger.info(`[processUnifiedPayment] Initiating online payment: Amount=₹${amount}, FinalUrl=${finalRedirectUrl}`);

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

export const getStudentFinancialHistory = async (
    studentId: string,
    options: { academicYearId?: string; yearOfStudy?: number } = {}
) => {
    const { academicYearId, yearOfStudy } = options;

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

    const allFeeHeads = await prisma.feeHead.findMany();

    const yearFilter = {
        ...(academicYearId ? { academicYearId } : {}),
        ...(yearOfStudy    ? { yearOfStudy }    : {}),
    };

    const correctionFilter = {
        ...(academicYearId ? { academicYearId } : {}),
    };

    const [ledgers, payments, feeDemands, feeCorrections, activeAccPricing] = await Promise.all([
        prisma.studentLedger.findMany({
            where: { studentId, isDeleted: false, ...yearFilter },
            orderBy: { createdAt: 'asc' }
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

        (prisma as any).studentAccommodationPricing.findFirst({
            where: { studentId, isActive: true },
            select: { createdAt: true }
        }),
    ]);

    logger.info(`[FinancialHistory] Data Fetched. Ledgers: ${ledgers.length}, Payments: ${payments.length}, Demands: ${feeDemands.length}, FeeCorrections: ${feeCorrections.length}`);

    const BREAKDOWN_CATEGORIES = [
        'HOSTEL_ACCOMMODATION',
        'HOSTEL_MESS',
        'HOSTEL_LAUNDRY',
        'HOSTEL_REGISTRATION',
        'TRANSPORT',
        'TUITION',
        'REGISTRATION',
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

    feeDemands.forEach((demand: any) => {
        const headId = demand.feeHeadId ?? demand.feeStructure?.feeHeadId;
        const target = breakdown[bucketKey(componentOfDemand(demand))];
        target.demanded += demand.amount;
        target.discount += demand.discountAmount ?? 0;
        if (demand.scholarshipAmount) target.scholarshipAmount += demand.scholarshipAmount;
        if (demand.fineAmount) target.fine += demand.fineAmount;
        if (headId && !target.feeHeadId) target.feeHeadId = headId;
    });

    ledgers.forEach((entry: any) => {
        if (REFUND_LIKE_REFERENCE_TYPES.has(entry.referenceType)) return;
        if (entry.referenceType !== 'COURSE_CHANGE' || entry.type !== 'DEBIT') return;
        const comp = entry.feeHeadId ? feeHeadComponentMap.get(entry.feeHeadId) : null;
        breakdown[bucketKey(comp)].paid -= entry.amount;
    });

    payments.forEach((p: any) => {
        if (!isCurrentPayment(p)) return;
        const target = breakdown[bucketKey(componentOfPayment(p))];
        target.paid += p.amount;
        if (p.feeHeadId && !target.feeHeadId) target.feeHeadId = p.feeHeadId;
    });

    const totalDemanded = Object.values(breakdown).reduce((s, b) => s + b.demanded, 0);
    const totalDiscount = Object.values(breakdown).reduce((s, b) => s + b.discount, 0);

    const courseChangeDeduction = ledgers
        .filter((l: any) => l.referenceType === 'COURSE_CHANGE' && l.type === 'DEBIT')
        .reduce((s, l: any) => s + l.amount, 0);
    const courseChangeFeePaid = sumPayments(p => p.component === PaymentComponent.COURSE_CHANGE_FEE);
    const totalPaid           = sumPayments(isCurrentPayment) - courseChangeDeduction;

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

    const summary = {
        totalDemanded,
        totalPaid,
        totalDiscount,
        courseChangeFee: courseChangeDeduction,
        courseChangeFeePaid,
        totalPending: Math.max(0, totalDemanded - totalPaid - totalDiscount),
        unrefundedAccommodationCredit,
    };

    const paymentsWithUrls = await Promise.all(payments.map(async (p) => {
        return {
            ...p,
            invoiceUrl: await convertToPresignedUrl(p.invoiceUrl)
        };
    }));

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

    const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

    const [
        feeHeads, payments, demands, ledger, corrections,
        scholarship, scholarshipAlloc, courseChanges, cancellations,
        hostelAllocs, transportAllocs, accommodationSnapshots, auditLogs,
    ] = await Promise.all([
        safe(prisma.feeHead.findMany({ select: { id: true, name: true, component: true } }), [] as any[]),
        safe(prisma.payment.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } }), [] as any[]),
        safe(prisma.studentFeeDemand.findMany({ where: { studentId }, include: { feeHead: true, feeStructure: { include: { feeHead: true } } }, orderBy: { createdAt: 'asc' } }), [] as any[]),
        safe(prisma.studentLedger.findMany({ where: { studentId }, orderBy: { date: 'asc' } }), [] as any[]),
        safe((prisma as any).feeCorrection.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } }), [] as any[]),
        safe(prisma.studentScholarship.findUnique({ where: { studentId } }), null as any),
        Promise.resolve(null),
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

    const paymentsSection = (payments as any[]).map(p => ({
        ...p,
        isApplicationFee: p.component === PaymentComponent.APPLICATION_FEE,
        countsToPaid: p.status === PaymentStatus.SUCCESS && p.component !== PaymentComponent.APPLICATION_FEE,
    }));

    const demandsSection = (demands as any[]).map(d => ({
        ...d,
        active: !d.isDeleted,

        removedReason: d.isDeleted ? (d.remarks ?? null) : null,
    }));

    const ledgerSection = (ledger as any[]).map(l => {
        const demandKeyed = l.referenceType === 'FEE_DEMAND' || l.referenceType === 'SCHOLARSHIP';
        const orphaned = demandKeyed && !!l.referenceId && !activeDemandIds.has(l.referenceId);
        return { ...l, active: !l.isDeleted, orphaned };
    });

    const active = (demands as any[]).filter(d => !d.isDeleted);
    const grossDemanded   = active.reduce((s, d) => s + (d.amount ?? 0), 0);
    const totalDiscount   = active.reduce((s, d) => s + (d.discountAmount ?? 0), 0);
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

export const getStudentFinancialFlow = async (studentId: string) => {

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

        prisma.auditLog.findMany({
            where: { entity: 'StudentScholarship', action: { in: ['CREATE', 'UPDATE'] } },
            orderBy: { timestamp: 'asc' },
            select: { action: true, timestamp: true, details: true, entityId: true }
        })
    ]);

    const feeHeadMap = new Map<string, string>();
    allFeeHeads.forEach(h => feeHeadMap.set(h.id, h.name));

    if (!student) throw new AppError('Student not found', 404);

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

    if (scholarship) {

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

    timeline.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    timeline.forEach((item, i) => { item.step = i + 1; });

    let totalCharged = 0;
    let totalCredits = 0;
    const flow = timeline.map(item => {
        if (item.sign === '-' && item.amount) totalCharged += item.amount;
        if (item.sign === '+' && item.amount) totalCredits += item.amount;

        return {
            ...item,
            runningBalance: totalCharged - totalCredits
        };
    });

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
