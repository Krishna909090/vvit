import { z } from 'zod';
import { CONVENOR_STATUSES } from './convenorAdmission.service';

const VALID_DOC_KEYS = [
  'DOC_SSC_MARKSHEET', 'DOC_INTER_MARKSHEET', 'DOC_EAPCET_HALL_TICKET',
  'DOC_EAPCET_RANK_CARD', 'DOC_STUDY_CERTIFICATE', 'DOC_TRANSFER_CERTIFICATE',
  'DOC_CASTE_CERTIFICATE', 'DOC_AADHAR_STUDENT', 'DOC_AADHAR_FATHER',
  'DOC_AADHAR_MOTHER', 'DOC_PHOTO_STUDENT', 'DOC_PHOTO_FATHER',
  'DOC_PHOTO_MOTHER', 'DOC_XEROX_COPIES',
] as const;

const uuidParam = z.object({ id: z.string().uuid('Invalid ID') });

const statusEnum = z.enum(CONVENOR_STATUSES);

const listQuery = z.object({
  status:    statusEnum.optional(),
  fromDate:  z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fromDate must be YYYY-MM-DD').optional()),
  toDate:    z.string().datetime({ offset: true }).optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'toDate must be YYYY-MM-DD').optional()),
  search:    z.string().max(100).optional(),
  page:      z.coerce.number().int().min(1).optional(),
  limit:     z.coerce.number().int().min(1).max(200).optional(),
});

export const listSchema   = z.object({ query: listQuery });
export const exportSchema = z.object({ query: listQuery.omit({ page: true, limit: true }) });

export const byHallTicketSchema = z.object({
  params: z.object({ hallTicket: z.string().min(1, 'Hall ticket is required').max(50) }),
});

export const getByIdSchema = z.object({ params: uuidParam });

export const reportSchema = z.object({
  params: uuidParam,
  body: z.object({
    // Required
    phone: z
      .string()
      .regex(/^[6-9]\d{9}$/, 'Phone must be a valid 10-digit Indian mobile number'),

    // Optional personal details — empty string treated as absent
    email: z.string().email('Invalid email').optional().or(z.literal('')),

    fatherName: z.string().trim().min(2, 'Father name too short').max(100).optional()
      .or(z.literal('')).transform(v => v || undefined),

    motherName: z.string().trim().min(2, 'Mother name too short').max(100).optional()
      .or(z.literal('')).transform(v => v || undefined),

    aadharNumber: z.string().regex(/^\d{12}$/, 'Aadhar must be 12 digits').optional()
      .or(z.literal('')).transform(v => v || undefined),

    dob: z.string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'dob must be YYYY-MM-DD')
      .refine(v => {
        const d = new Date(v);
        return !isNaN(d.getTime()) && d < new Date();
      }, 'dob must be a valid past date')
      .optional(),

    // Address fields
    address:  z.string().trim().max(255).optional().or(z.literal('')).transform(v => v || undefined),
    address2: z.string().trim().max(255).optional().or(z.literal('')).transform(v => v || undefined),
    city:     z.string().trim().max(100).optional().or(z.literal('')).transform(v => v || undefined),
    pinCode:  z.string().regex(/^\d{6}$/, 'Pin code must be 6 digits').optional()
      .or(z.literal('')).transform(v => v || undefined),
    state:   z.string().trim().max(100).optional().or(z.literal('')).transform(v => v || undefined),
    country: z.string().trim().max(100).optional().or(z.literal('')).transform(v => v || undefined),

    // Misc
    degreeType:      z.string().trim().max(50).optional().or(z.literal('')).transform(v => v || undefined),
    isOffline:       z.boolean().optional(),
    isKycVerified:   z.boolean().optional(),
    profilePhotoUrl: z.string().url('Invalid URL').optional().or(z.literal('')).transform(v => v || undefined),

    // PRO — skip empty string
    proNumber: z.union([
      z.string().min(1).max(50),
      z.number().int().positive(),
    ]).optional().or(z.literal('')).transform(v => (v === '' ? undefined : v)),

    feesReimbursement: z.boolean().optional(),

    // Documents — array of { key, label, status }; key validated, deduplicated by key
    documentsSubmitted: z
      .array(z.object({
        key:    z.enum(VALID_DOC_KEYS, { error: 'Invalid document key' }),
        label:  z.string().min(1).max(200),
        status: z.enum(['SUBMITTED', 'PENDING']),
      }))
      .max(VALID_DOC_KEYS.length * 2)
      .transform(arr => {
        const seen = new Set<string>();
        return arr.filter(d => seen.has(d.key) ? false : (seen.add(d.key), true));
      })
      .optional(),
  }),
});

const PAYMENT_METHODS = [
  'CASH', 'CHEQUE', 'DEMAND_DRAFT', 'UPI', 'NET_BANKING',
  'NEFT', 'RTGS', 'NEFT_RTGS', 'IMPS',
] as const;

export const allotSchema = z.object({
  params: uuidParam,
  body: z.object({
    courseId: z.string().uuid('Invalid course ID'),

    accommodation: z.object({
      type: z.enum(['HOSTEL', 'TRANSPORT', 'NONE']),
      hostelId:          z.string().uuid().optional(),
      hostelType:        z.enum(['SHARING_2', 'SHARING_4', 'SHARING_6', 'SHARING_8', 'SHARING_10']).optional(),
      hostelPaymentMode: z.enum(['YEARWISE', 'SEMWISE']).optional(),
      transportRouteId:  z.string().uuid().optional(),
    }).refine(a => {
      if (a.type === 'TRANSPORT') return !!a.transportRouteId;
      return true;
    }, { message: 'TRANSPORT requires transportRouteId' }),

    payment: z.object({
      amount:          z.number().positive('Payment amount must be greater than 0'),
      method:          z.enum(PAYMENT_METHODS, { error: 'Invalid payment method' }),
      referenceNumber: z.string().max(100).optional(),
      date:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
      redirectUrl:     z.string().optional(),
    }),
    redirectUrl: z.string().optional(),
  }),
});

export const updateStatusSchema = z.object({
  params: uuidParam,
  body:   z.object({ status: statusEnum }),
});

export const updateDetailsSchema = z.object({
  params: uuidParam,
  body: z.object({
    feesReimbursement:  z.boolean().optional(),
    documentsSubmitted: z
      .array(z.object({
        key:    z.enum(VALID_DOC_KEYS, { error: 'Invalid document key' }),
        label:  z.string().min(1).max(200),
        status: z.enum(['SUBMITTED', 'PENDING']),
      }))
      .max(VALID_DOC_KEYS.length * 2)
      .transform(arr => {
        const seen = new Set<string>();
        return arr.filter(d => seen.has(d.key) ? false : (seen.add(d.key), true));
      })
      .optional(),
  }).refine(b => b.feesReimbursement !== undefined || b.documentsSubmitted !== undefined, {
    message: 'At least one of feesReimbursement or documentsSubmitted must be provided',
  }),
});
