import prisma from '../../config/prisma';
import {
  Prisma, QuotaType, ApplicationMode, AdmissionStatus, AdmissionEntryType, AdmissionSource,
  PaymentComponent, PaymentMode, PaymentStatus, FeeStatus, HostelType,
} from '@prisma/client';
import { AppError } from '../../utils/AppError';
import { Role } from '../../constants/roles';
import { maskAadhaar } from '../../utils/mask';
import { generateCustodianCertificate, DOC_LABEL_MAP } from '../../utils/custodianCertificateGenerator';
import { uploadFileToS3, getPresignedUrl, convertToPresignedUrl } from '../../utils/s3Utils';
import logger from '../../utils/logger';
import { InvoiceService } from '../finance/invoice.service';
import { AccommodationService } from '../studentManagement/adminStudent/accommodation';

import { resolveFeeHeadsByComponent, recomputeStudentTotals } from '../../utils/studentContext';

export const CONVENOR_STATUSES = ['NOT_REPORTED', 'REPORTED', 'SEAT_CONFIRMED'] as const;

interface ListFilters {
  status?: string;
  fromDate?: string;
  toDate?: string;
  reportedFrom?: string;  // filter by student reporting date (student.createdAt)
  reportedTo?: string;
  search?: string;
  page?: number;
  limit?: number;
  createdById?: string;   // records created by this admin
  allottedById?: string;  // records where seat was allotted by this admin
}

interface AllotBody {
  courseId: string;
  accommodation: {
    type: 'HOSTEL' | 'TRANSPORT' | 'NONE';
    hostelId?: string;
    hostelType?: string;
    hostelPaymentMode?: 'YEARWISE' | 'SEMWISE';
    transportRouteId?: string;
  };
  payment: {
    amount: number;
    method: string;
    referenceNumber?: string;
    date?: string;
    redirectUrl?: string;
  };
  redirectUrl?: string;
}

interface ReportBody {
  phone: string;
  email?: string;
  fatherName?: string;
  motherName?: string;
  aadharNumber?: string;
  dob?: string;
  address?: string;
  address2?: string;
  city?: string;
  pinCode?: string;
  state?: string;
  country?: string;
  degreeType?: string;
  isOffline?: boolean;
  isKycVerified?: boolean;
  profilePhotoUrl?: string;
  proNumber?: string | number;
  feesReimbursement?: boolean;
  documentsSubmitted?: { key: string; label: string; status: 'SUBMITTED' | 'PENDING' }[];
}

const buildWhere = (filters: ListFilters): Prisma.ConvenorAdmissionWhereInput => {
  const and: Prisma.ConvenorAdmissionWhereInput[] = [{ isDeleted: false }];

  if (filters.status)      and.push({ status: filters.status });
  if (filters.allottedById) and.push({ student: { admissionDetails: { seatAllotedBy: filters.allottedById } } });

  if (filters.fromDate || filters.toDate) {
    and.push({
      createdAt: {
        ...(filters.fromDate ? { gte: new Date(filters.fromDate) } : {}),
        ...(filters.toDate   ? { lte: new Date(new Date(filters.toDate).setHours(23, 59, 59, 999)) } : {}),
      },
    });
  }

  if (filters.reportedFrom || filters.reportedTo) {
    and.push({
      student: {
        createdAt: {
          ...(filters.reportedFrom ? { gte: new Date(filters.reportedFrom) } : {}),
          ...(filters.reportedTo   ? { lte: new Date(new Date(filters.reportedTo).setHours(23, 59, 59, 999)) } : {}),
        },
      },
    });
  }

  if (filters.createdById) {
    and.push({
      student: {
        createdBy: filters.createdById,
        quotaType: 'CONVENOR',
      },
    });
  }

  if (filters.search) {
    and.push({
      OR: [
        { hallTicketNo:  { contains: filters.search, mode: 'insensitive' } },
        { applicantName: { contains: filters.search, mode: 'insensitive' } },
        { student: { name:          { contains: filters.search, mode: 'insensitive' } } },
        { student: { phone:         { contains: filters.search, mode: 'insensitive' } } },
        { student: { email:         { contains: filters.search, mode: 'insensitive' } } },
        { student: { applicationId: { contains: filters.search, mode: 'insensitive' } } },
      ],
    });
  }

  return { AND: and };
};

const include = {
  courseRelation:  { select: { id: true, name: true, code: true, degree: true } },
  institutionCode: { select: { id: true, code: true, name: true } },
  academicYear:    { select: { id: true, code: true } },
};

const includeWithStudent = {
  ...include,
  student: {
    select: {
      id: true, name: true, phone: true, email: true, aadharNumber: true,
      fatherName: true, motherName: true, gender: true, dob: true,
      address: true, address2: true, city: true, state: true, pincode: true, country: true,
      category: true, quotaType: true, applicationId: true, isKycVerified: true,
      profilePhotoUrl: true, degreeType: true, createdBy: true, createdAt: true,
      user: {
        select: { id: true, name: true, phone: true, email: true, role: true },
      },
      admissionDetails: {
        select: {
          id: true, status: true, entryType: true, entryYearOfStudy: true,
          allottedCourseId: true, accommodationType: true, hostelType: true,
          hostelPaymentMode: true, seatAllottedAt: true, academicYearId: true,
          instituteCode: true, feeCohortAcademicYearId: true,
          allottedCourse: { select: { id: true, name: true, code: true, degree: true } },
        },
      },
      payments: {
        where: { isDeleted: false },
        select: {
          id: true, amount: true, method: true, mode: true, status: true,
          component: true, referenceNumber: true, instrumentDate: true,
          academicYearId: true, yearOfStudy: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' as const },
      },
      feeDemands: {
        where: { isDeleted: false },
        select: {
          id: true, amount: true, netAmount: true, discountAmount: true,
          scholarshipAmount: true, status: true, dueDate: true, yearOfStudy: true,
          academicYearId: true, remarks: true, createdAt: true,
        },
      },
      ledgerEntries: {
        where: { isDeleted: false },
        select: {
          id: true, type: true, amount: true, description: true,
          referenceId: true, referenceType: true, academicYearId: true,
          yearOfStudy: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' as const },
      },
      documents: {
        where: { isDeleted: false },
        select: {
          id: true, documentKey: true, url: true, status: true,
          physicalCopy: true, remarks: true, createdAt: true,
        },
      },
    },
  },
};

const maskStudent = (record: any) => {
  if (!record) return record;
  if (record.student?.aadharNumber) {
    record.student.aadharNumber = maskAadhaar(record.student.aadharNumber);
  }
  return record;
};

async function generateVcoId(): Promise<string> {
  const prefix = 'VCO';
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await prisma.student.findFirst({
      where: { applicationId: { startsWith: prefix } },
      orderBy: { createdAt: 'desc' },
      select: { applicationId: true },
    });
    let next = 2600001;
    if (last?.applicationId) {
      const n = parseInt(last.applicationId.replace(prefix, ''), 10);
      if (!isNaN(n) && n >= 2600001) next = n + 1;
    }
    const id = `${prefix}${next}`;
    const taken = await prisma.student.findUnique({ where: { applicationId: id }, select: { id: true } });
    if (!taken) return id;
  }
  throw new AppError('Failed to generate unique application ID. Please try again.', 500);
}

export const ConvenorAdmissionService = {
  async list(filters: ListFilters) {
    const page  = Math.max(1, filters.page  ?? 1);
    const limit = Math.min(200, filters.limit ?? 20);
    const where = buildWhere(filters);

    const [data, total] = await Promise.all([
      prisma.convenorAdmission.findMany({
        where,
        include: includeWithStudent,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.convenorAdmission.count({ where }),
    ]);

    return {
      records:    data.map(maskStudent),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  },

  async listMyAllotments(filters: ListFilters, adminId: string) {
    return this.list({ ...filters, allottedById: adminId, status: filters.status ?? 'SEAT_CONFIRMED' });
  },

  async listWithAdmin(filters: ListFilters) {
    const page  = Math.max(1, filters.page  ?? 1);
    const limit = Math.min(200, filters.limit ?? 20);
    const where = buildWhere(filters);

    const [data, total] = await Promise.all([
      prisma.convenorAdmission.findMany({
        where,
        include: includeWithStudent,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.convenorAdmission.count({ where }),
    ]);

    // Batch-fetch all admin users referenced by CA.createdBy or student.createdBy
    const adminIds = [
      ...new Set(
        data.flatMap(r => [r.createdBy, (r.student as any)?.createdBy].filter(Boolean) as string[])
      ),
    ];
    const admins = adminIds.length
      ? await prisma.user.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, name: true, email: true, phone: true, role: true },
        })
      : [];
    const adminMap = new Map(admins.map(a => [a.id, a]));

    const enriched = data.map(r => {
      const masked = maskStudent(r);
      return {
        ...masked,
        createdByAdmin: masked.createdBy ? (adminMap.get(masked.createdBy) ?? null) : null,
        student: masked.student
          ? {
              ...masked.student,
              createdByAdmin: (masked.student as any).createdBy
                ? (adminMap.get((masked.student as any).createdBy) ?? null)
                : null,
            }
          : masked.student,
      };
    });

    return {
      records:    enriched,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  },

  async getById(id: string) {
    const record = await prisma.convenorAdmission.findFirst({
      where: { id, isDeleted: false },
      include: includeWithStudent,
    });
    if (!record) throw new AppError('Convenor admission not found', 404);
    return maskStudent(record);
  },

  async getByHallTicket(hallTicketNo: string) {
    const record = await prisma.convenorAdmission.findUnique({
      where: { hallTicketNo },
      include: includeWithStudent,
    });
    if (!record || record.isDeleted) throw new AppError('No admission found for this hall ticket', 404);
    return maskStudent(record);
  },

  async report(id: string, body: ReportBody, adminId: string) {
    // 1. Load admission record + StudentGroup in parallel (StudentGroup never changes)
    const [ca, studentGroup] = await Promise.all([
      prisma.convenorAdmission.findFirst({
        where: { id, isDeleted: false },
        include: { institutionCode: true, academicYear: true, courseRelation: { select: { name: true } } },
      }),
      prisma.group.findUnique({ where: { name: 'StudentGroup' }, select: { id: true } }),
    ]);
    if (!ca) throw new AppError('Convenor admission not found', 404);
    if (ca.status !== 'NOT_REPORTED') throw new AppError('This admission has already been reported', 409);
    if (!ca.academicYearId) throw new AppError('Admission has no academic year assigned', 422);

    const entryYearOfStudy    = (ca.entryYear && ca.entryYear > 0) ? ca.entryYear : 1;
    const activeAcademicYearId = ca.academicYearId;
    const isLateral            = entryYearOfStudy > 1;

    // Dedup submitted docs by key (Zod transform already does this but guard at service layer too)
    const seenKeys = new Set<string>();
    const documentsSubmitted = (body.documentsSubmitted ?? []).filter(d =>
      seenKeys.has(d.key) ? false : (seenKeys.add(d.key), true)
    );

    // Aadhar masking — use consistent pattern for both uniqueness check and storage
    const maskedAadhar  = body.aadharNumber ? maskAadhaar(body.aadharNumber) : null;
    const hasProNumber  = body.proNumber !== undefined && body.proNumber !== null && body.proNumber !== '';

    const dobDate  = body.dob ? new Date(body.dob) : null;
    const dobStart = dobDate ? new Date(dobDate.getFullYear(), dobDate.getMonth(), dobDate.getDate()) : null;
    const dobEnd   = dobDate ? new Date(dobDate.getFullYear(), dobDate.getMonth(), dobDate.getDate(), 23, 59, 59, 999) : null;

    // 2. All pre-transaction work in parallel (pre-flight + appId + PRO lookup)
    const [[existingPhone, existingAadhar, existingEmail], applicationId, proRecord] = await Promise.all([
      Promise.all([
        prisma.student.findFirst({ where: { phone: body.phone }, select: { id: true } }),
        maskedAadhar && dobStart && dobEnd
          ? prisma.student.findFirst({
              where: { aadharNumber: maskedAadhar, dob: { gte: dobStart, lte: dobEnd } },
              select: { id: true },
            })
          : Promise.resolve(null),
        body.email
          ? prisma.student.findFirst({ where: { email: body.email }, select: { id: true } })
          : Promise.resolve(null),
      ]),
      generateVcoId(),
      hasProNumber
        ? prisma.pRO.findUnique({ where: { proNumber: String(body.proNumber) } })
        : Promise.resolve(null),
    ]);

    if (existingPhone)  throw new AppError('A student with this phone number already exists', 409);
    if (existingAadhar) throw new AppError('A student with matching Aadhar and date of birth already exists', 409);
    if (existingEmail)  throw new AppError('A student with this email already exists', 409);
    if (hasProNumber && !proRecord) throw new AppError('Invalid PRO number provided', 400);

    const proIdToStore = proRecord?.id ?? null;

    // batchAcademicYearId always matches the convenorAdmission's academicYearId
    const batchAcademicYearId = activeAcademicYearId;

    // 3. Transaction — StudentGroup already fetched outside, saves one round trip
    const result = await prisma.$transaction(async (tx) => {
      // Collision check + user lookup in parallel
      const [collision, existingUser] = await Promise.all([
        tx.student.findUnique({ where: { applicationId }, select: { id: true } }),
        tx.user.findUnique({ where: { phone: body.phone } }),
      ]);
      if (collision) throw new AppError('Application ID conflict detected. Please try again.', 409);

      let user = existingUser;
      if (!user) {
        user = await tx.user.create({
          data: {
            phone:     body.phone,
            email:     body.email || undefined,
            name:      ca.applicantName || body.phone,
            role:      Role.STUDENT,
            createdBy: adminId,
          },
        });
        if (studentGroup) {
          await tx.userGroup.create({ data: { userId: user.id, groupId: studentGroup.id } });
        }
      }

      const student = await tx.student.create({
        data: {
          userId:          user.id,
          applicationId,
          name:            ca.applicantName || body.phone,
          phone:           body.phone,
          email:           body.email || `conv-${body.phone}@vvitu.in`,
          fatherName:      body.fatherName || '',
          motherName:      body.motherName || '',
          gender:          ca.gender || 'O',
          dob:             body.dob ? new Date(body.dob) : new Date('2000-01-01'),
          aadharNumber:    maskedAadhar || 'PENDING',
          category:        ca.category || 'NA',
          country:         body.country || 'India',
          address:         body.address || 'NA',
          address2:        body.address2 || undefined,
          city:            body.city || 'NA',
          state:           body.state || 'NA',
          pincode:         body.pinCode || '000000',
          degreeType:      body.degreeType || undefined,
          isOffline:       true,
          isKycVerified:   body.isKycVerified ?? false,
          profilePhotoUrl: body.profilePhotoUrl || undefined,
          source:          AdmissionSource.COUNCIL,
          quotaType:       QuotaType.CONVENOR,
          applicationMode: ApplicationMode.OFFLINE,
          pref1:           null,
          pref2:           null,
          pref3:           null,
          proId:           proIdToStore,
          createdBy:       adminId,
        },
      });

      // studentAdmission create + convenorAdmission update + quota increment — all in parallel
      const [, updated] = await Promise.all([
        tx.studentAdmission.create({
          data: {
            studentId:               student.id,
            academicYearId:          activeAcademicYearId,
            status:                  AdmissionStatus.CONVENOR_REPORTED,
            entryType:               isLateral ? AdmissionEntryType.LATERAL : AdmissionEntryType.REGULAR,
            entryYearOfStudy,
            entryAcademicYearId:     activeAcademicYearId,
            feeCohortAcademicYearId: activeAcademicYearId,
            batchAcademicYearId,
            instituteCode:           ca.institutionCode?.code ?? 'MGMT',
            institutionCodeId:       ca.institutionCodeId ?? undefined,
          },
        }),
        tx.convenorAdmission.update({
          where: { id },
          data: {
            studentId:          student.id,
            status:             'REPORTED',
            feesReimbursement:  body.feesReimbursement ?? false,
            documentsSubmitted: documentsSubmitted,
            updatedBy:          adminId,
          },
          include: includeWithStudent,
        }),
        // Increment reportedSeats on the matching quota row (no-op if quota row doesn't exist)
        ...(ca.courseId && ca.academicYearId
          ? [tx.convenorQuota.updateMany({
              where: { courseId: ca.courseId, academicYearId: ca.academicYearId, isDeleted: false },
              data:  { reportedSeats: { increment: 1 } },
            })]
          : []),
        // Create StudentDocument rows for each submitted/pending doc with physicalCopy flag
        ...documentsSubmitted.map(doc =>
          tx.studentDocument.upsert({
            where:  { studentId_documentKey: { studentId: student.id, documentKey: doc.key } },
            create: {
              studentId:     student.id,
              documentKey:   doc.key,
              url:           '',
              status:        'PENDING' as any,
              physicalCopy:  doc.status === 'SUBMITTED',
              academicYearId: activeAcademicYearId,
              createdBy:     adminId,
            },
            update: { physicalCopy: doc.status === 'SUBMITTED', updatedBy: adminId },
          })
        ),
      ]);

      return maskStudent(updated);
    }, { timeout: 20000 });

    // 4. Certificate generation after tx commits — stored in StudentDocument
    const studentId = (result as any).studentId;
    try {
      const eapcetQual = studentId
        ? await prisma.academicQualification.findFirst({
            where: { studentId, level: 'EAPCET' },
            select: { hallTicketNumber: true },
          })
        : null;

      const pdf = await generateCustodianCertificate({
        admissionNo:        applicationId,
        studentName:        ca.applicantName ?? '',
        gender:             ca.gender ?? '',
        fatherName:         body.fatherName,
        branch:             (ca as any).courseRelation?.name ?? undefined,
        hallTicketNo:       ca.hallTicketNo ?? '',
        academicYear:       ca.academicYear?.code ?? '',
        entryYear:          entryYearOfStudy,
        documentsSubmitted: documentsSubmitted,
        date:               new Date(),
      });
      const s3Key = `student/${studentId}/documents/custodian_certificate.pdf`;
      const url = await uploadFileToS3(pdf, s3Key, 'application/pdf');
      await prisma.studentDocument.upsert({
        where:  { studentId_documentKey: { studentId, documentKey: 'CUSTODIAN_CERTIFICATE' } },
        create: {
          studentId,
          documentKey:    'CUSTODIAN_CERTIFICATE',
          url,
          status:         'APPROVED' as any,
          physicalCopy:   false,
          academicYearId: activeAcademicYearId,
          createdBy:      adminId,
        },
        update: { url, updatedBy: adminId },
      });
      (result as any).custodianCertificateUrl = await getPresignedUrl(s3Key);
    } catch (err) {
      logger.error(`[report] Custodian certificate generation failed for ${id}: ${err}`);
    }

    return result;
  },

  async allot(id: string, body: AllotBody, adminId: string) {
    // 1. Load CA with student admission details
    const ca = await prisma.convenorAdmission.findFirst({
      where: { id, isDeleted: false },
      include: {
        student: {
          select: {
            id: true,
            admissionDetails: { select: { id: true, status: true, academicYearId: true } },
          },
        },
        academicYear: { select: { id: true, code: true } },
        courseRelation: { select: { id: true, name: true } },
      },
    });
    if (!ca)           throw new AppError('Convenor admission not found', 404);
    if (!ca.studentId) throw new AppError('Student has not been reported yet — run report first', 409);
    if (ca.status !== 'REPORTED') throw new AppError('Seat can only be allotted after student is reported', 409);

    const studentId = ca.studentId;
    const admission = ca.student?.admissionDetails;
    if (!admission) throw new AppError('Student admission record missing', 500);
    if (admission.status !== AdmissionStatus.CONVENOR_REPORTED) {
      throw new AppError(`Cannot allot seat — current admission status is ${admission.status}`, 409);
    }

    // 2. Validate course
    const course = await prisma.course.findUnique({ where: { id: body.courseId }, select: { id: true, name: true } });
    if (!course) throw new AppError('Invalid course ID', 400);

    const academicYearId = ca.academicYearId ?? admission.academicYearId;
    if (!academicYearId) throw new AppError('No academic year linked to this admission', 422);

    // Guard: prevent duplicate allotment payment
    const existingPayment = await prisma.payment.findFirst({
      where: { studentId, component: PaymentComponent.REGISTRATION, status: PaymentStatus.SUCCESS, isDeleted: false },
      select: { id: true },
    });
    if (existingPayment) throw new AppError('Registration fee has already been recorded for this student', 409);

    const ONLINE_METHODS = new Set(['UPI', 'NET_BANKING']);
    const isOnline = ONLINE_METHODS.has(body.payment.method);

    // ── ONLINE PATH (UPI / NET_BANKING) ─────────────────────────────────────
    if (isOnline) {
      const { initiatePhonePePayment } = await import('../finance/payment.service');

      const rawRedirectUrl = body.payment.redirectUrl ?? body.redirectUrl;
      if (!rawRedirectUrl) throw new AppError('redirectUrl is required for online payments', 400);

      const buildRedirectUrl = (paymentId: string) => {
        const base = rawRedirectUrl.startsWith('http')
          ? rawRedirectUrl
          : `${process.env.FRONTEND_URL_ADMISSION}${rawRedirectUrl}`;
        const separator = base.includes('?') ? '&' : '?';
        return `${base}${separator}paymentId=${paymentId}`;
      };

      const idempotencyKey = `CONVENOR_ALLOT_${id}_REGISTRATION`;

      // If a PENDING payment already exists for this allotment, re-initiate PhonePe with the same txn
      const existingPending = await prisma.payment.findFirst({
        where: { idempotencyKey, status: PaymentStatus.PENDING },
        select: { id: true, providerTxId: true, amount: true },
      });
      if (existingPending?.providerTxId) {
        const result = await initiatePhonePePayment(studentId, existingPending.amount, existingPending.providerTxId, buildRedirectUrl(existingPending.id), 'ADMISSION');
        logger.info(`[allot][online] Re-initiated PhonePe for student=${studentId} txn=${existingPending.providerTxId}`);
        return { type: 'ONLINE_INITIATED', message: 'Payment link generated', paymentId: existingPending.id, redirectUrl: result.redirectUrl };
      }

      const merchantTransactionId = `TXN_CALLOT_${Date.now()}_${studentId.substring(0, 8)}`;

      const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.REGISTRATION]);
      const registrationFeeHead = feeHeadMap.get(PaymentComponent.REGISTRATION);

      const existingDemand = registrationFeeHead?.id
        ? await prisma.studentFeeDemand.findFirst({
            where: { studentId, feeHeadId: registrationFeeHead.id, status: FeeStatus.PENDING, isDeleted: false },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          })
        : null;

      const pendingPayment = await prisma.payment.create({
        data: {
          studentId,
          amount:          body.payment.amount,
          method:          body.payment.method as any,
          mode:            PaymentMode.ONLINE,
          status:          PaymentStatus.PENDING,
          component:       PaymentComponent.REGISTRATION,
          feeHeadId:       registrationFeeHead?.id ?? undefined,
          feeDemandId:     existingDemand?.id ?? undefined,
          academicYearId,
          yearOfStudy:     ca.entryYear ?? 1,
          providerTxId:    merchantTransactionId,
          idempotencyKey,
          collectedBy:     adminId,
          createdBy:       adminId,
          metadata: {
            targetAction:         'CONVENOR_ALLOT',
            convenorAdmissionId:  id,
            courseId:             body.courseId,
            accommodation:        body.accommodation,
            caEntryYear:          ca.entryYear,
            caCourseId:           ca.courseId,
            adminId,
          },
        },
      });

      const result = await initiatePhonePePayment(studentId, body.payment.amount, merchantTransactionId, buildRedirectUrl(pendingPayment.id), 'ADMISSION');

      logger.info(`[allot][online] PhonePe initiated for student=${studentId} txn=${merchantTransactionId}`);
      return { type: 'ONLINE_INITIATED', message: 'Payment link generated', paymentId: pendingPayment.id, redirectUrl: result.redirectUrl };
    }

    // ── OFFLINE PATH (CASH / CHEQUE / DD / NEFT / RTGS) ─────────────────────
    // Guard: block if an online payment is still PENDING for this allotment
    const pendingOnlinePayment = await prisma.payment.findFirst({
      where: { idempotencyKey: `CONVENOR_ALLOT_${id}_REGISTRATION`, status: PaymentStatus.PENDING },
      select: { id: true },
    });
    if (pendingOnlinePayment) {
      throw new AppError('An online payment is already in progress for this allotment. Complete or cancel it before using offline payment.', 409);
    }
    const idempotencyKey = `CONVENOR_ALLOT_${id}_REGISTRATION_OFF_${Date.now()}`;

    // 3. Main transaction — payment + admission state + quota counters
    const paymentId = await prisma.$transaction(async (tx) => {
      const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.REGISTRATION], tx);
      const registrationFeeHead = feeHeadMap.get(PaymentComponent.REGISTRATION);
      if (!registrationFeeHead) throw new AppError('Fee configuration missing: REGISTRATION fee head not found in the system', 500);

      const paymentDate = body.payment.date ? new Date(body.payment.date) : new Date();

      const existingDemand = await tx.studentFeeDemand.findFirst({
        where: { studentId, feeHeadId: registrationFeeHead.id, status: FeeStatus.PENDING, isDeleted: false },
        orderBy: { createdAt: 'asc' },
      });
      if (!existingDemand) throw new AppError('REGISTRATION fee demand not found — run generate-demands for this student first', 422);

      const feeDemand = await tx.studentFeeDemand.update({
        where: { id: existingDemand.id },
        data:  { status: FeeStatus.FULL, updatedBy: adminId },
      });

      const payment = await tx.payment.create({
        data: {
          studentId,
          amount:          body.payment.amount,
          method:          body.payment.method as any,
          mode:            PaymentMode.OFFLINE,
          status:          PaymentStatus.SUCCESS,
          component:       PaymentComponent.REGISTRATION,
          feeHeadId:       registrationFeeHead?.id ?? undefined,
          feeDemandId:     feeDemand.id,
          academicYearId,
          yearOfStudy:     ca.entryYear ?? 1,
          referenceNumber: body.payment.referenceNumber ?? `REF-${Date.now()}`,
          instrumentDate:  paymentDate,
          idempotencyKey,
          collectedBy:     adminId,
          createdBy:       adminId,
        },
      });

      await tx.studentLedger.create({
        data: {
          studentId,
          type:          'CREDIT' as any,
          amount:        body.payment.amount,
          description:   `Convenor registration fee (${body.payment.method})`,
          referenceId:   payment.id,
          referenceType: 'PAYMENT',
          feeHeadId:     registrationFeeHead?.id ?? undefined,
          academicYearId,
          yearOfStudy:   ca.entryYear ?? 1,
          createdBy:     adminId,
        },
      });

      await this._completeAllotInTx(tx, { id, studentId, course, academicYearId, body, adminId, ca });
      return payment.id;
    }, { timeout: 20000 });

    const rawInvoiceUrl = await this._completeAllotPostTx({ id, studentId, body, courseId: body.courseId, academicYearId, adminId, paymentId });
    const invoiceUrl = rawInvoiceUrl ? await convertToPresignedUrl(rawInvoiceUrl) : null;

    const record = await this.getById(id);
    return { ...record, invoiceUrl };
  },

  // ── shared: admission-state + quota changes (runs inside a tx) ───────────
  async _completeAllotInTx(tx: any, ctx: { id: string; studentId: string; course: { id: string; name: string }; academicYearId: string; body: AllotBody; adminId: string; ca: any }): Promise<boolean> {
    const { id, studentId, course, academicYearId, body, adminId, ca } = ctx;

    // Atomic idempotency guard — only one concurrent caller wins; others see count=0 and bail.
    // Prevents duplicate seatAllocations and quota double-increments on concurrent webhook + heal.
    const caUpdate = await tx.convenorAdmission.updateMany({
      where: { id, status: { not: 'SEAT_CONFIRMED' } },
      data:  { status: 'SEAT_CONFIRMED', updatedBy: adminId },
    });
    if (caUpdate.count === 0) {
      logger.info(`[_completeAllotInTx] CA=${id} already SEAT_CONFIRMED — skipping concurrent duplicate`);
      return false;
    }

    await tx.studentAdmission.update({
      where: { studentId },
      data: {
        status:           AdmissionStatus.ADMISSION_CONFIRMED,
        allottedCourseId: body.courseId,
        seatAllottedAt:   new Date(),
        seatAllotedBy:    adminId,
      },
    });

    await tx.seatAllocation.create({
      data: {
        studentId,
        academicYearId,
        newCourse:   course.name,
        allocatedBy: adminId,
        notes:       'Convenor quota seat allotment',
        createdBy:   adminId,
      },
    });

    if (ca.courseId && academicYearId) {
      await tx.convenorQuota.updateMany({
        where: { courseId: ca.courseId, academicYearId, isDeleted: false },
        data:  { seatsConfirmed: { increment: 1 } },
      });
    }

    await recomputeStudentTotals(studentId, tx);
    return true;
  },

  // ── shared: fee demands + accommodation + allotment order (outside tx) ───
  async _completeAllotPostTx(ctx: { id: string; studentId: string; body: AllotBody; courseId: string; academicYearId: string; adminId: string; paymentId?: string }): Promise<string | null> {
    const { studentId, body, adminId, paymentId } = ctx;

    if (body.accommodation.type === 'HOSTEL' && body.accommodation.hostelId && body.accommodation.hostelType) {
      try {
        await AccommodationService.assignHostel(
          studentId,
          body.accommodation.hostelId,
          body.accommodation.hostelPaymentMode ?? 'YEARWISE',
          body.accommodation.hostelType as HostelType,
          adminId,
        );
      } catch (err) {
        logger.error(`[allot] assignHostel failed for student=${studentId}: ${err}`);
      }
    } else if (body.accommodation.type === 'TRANSPORT' && body.accommodation.transportRouteId) {
      try {
        await AccommodationService.assignTransport(studentId, body.accommodation.transportRouteId, adminId);
      } catch (err) {
        logger.error(`[allot] assignTransport failed for student=${studentId}: ${err}`);
      }
    }

    if (paymentId) {
      try {
        const invoice = await InvoiceService.generateInvoiceForPayment(paymentId);
        return invoice?.invoiceUrl ?? null;
      } catch (err) {
        logger.error(`[allot] invoice generation failed for payment=${paymentId}: ${err}`);
      }
    }
    return null;
  },

  // ── called after verify-payment confirms success (and by heal job on retry) ─
  async completeAllotAfterPayment(payment: any) {
    // ── Validation ────────────────────────────────────────────────────────
    if (!payment?.id) {
      logger.error('[completeAllotAfterPayment] Called with null/undefined payment — skipping');
      return;
    }

    const meta = payment.metadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      logger.error(`[completeAllotAfterPayment] Payment ${payment.id} has no metadata — skipping`);
      return;
    }

    const { convenorAdmissionId, courseId, caCourseId, caEntryYear } = meta as Record<string, any>;
    const adminId: string = (meta as any).adminId ?? 'SYSTEM';
    const accommodation = (meta as any).accommodation ?? { type: 'NONE' };

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!convenorAdmissionId || !UUID_RE.test(convenorAdmissionId)) {
      logger.error(`[completeAllotAfterPayment] Payment ${payment.id} has invalid/missing convenorAdmissionId="${convenorAdmissionId}" — skipping`);
      return;
    }
    if (!courseId || !UUID_RE.test(courseId)) {
      logger.error(`[completeAllotAfterPayment] Payment ${payment.id} has invalid/missing courseId="${courseId}" — skipping`);
      return;
    }
    if (!payment.studentId || !UUID_RE.test(payment.studentId)) {
      logger.error(`[completeAllotAfterPayment] Payment ${payment.id} has invalid/missing studentId — skipping`);
      return;
    }
    if (!['HOSTEL', 'TRANSPORT', 'NONE'].includes(accommodation?.type)) {
      logger.warn(`[completeAllotAfterPayment] Payment ${payment.id} has invalid accommodation.type="${accommodation?.type}" — defaulting to NONE`);
      accommodation.type = 'NONE';
    }
    // ─────────────────────────────────────────────────────────────────────

    const ca = await prisma.convenorAdmission.findFirst({
      where: { id: convenorAdmissionId, isDeleted: false },
      select: { studentId: true, academicYearId: true, status: true },
    });
    if (!ca?.studentId) {
      logger.error(`[completeAllotAfterPayment] CA not found or no student: ${convenorAdmissionId}`);
      return;
    }

    if (ca.status === 'SEAT_CONFIRMED') {
      logger.info(`[completeAllotAfterPayment] Already completed for CA=${convenorAdmissionId}`);
      return;
    }

    const studentId = ca.studentId;
    const academicYearId = ca.academicYearId ?? payment.academicYearId;
    if (!academicYearId) {
      logger.error(`[completeAllotAfterPayment] No academicYearId resolvable for CA=${convenorAdmissionId} — skipping`);
      return;
    }

    const course = await prisma.course.findUnique({ where: { id: courseId }, select: { id: true, name: true } });
    if (!course) {
      logger.error(`[completeAllotAfterPayment] Course not found: ${courseId}`);
      return;
    }

    const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.REGISTRATION]);
    const registrationFeeHead = feeHeadMap.get(PaymentComponent.REGISTRATION);
    if (!registrationFeeHead) {
      logger.error(`[completeAllotAfterPayment] Fee config missing: REGISTRATION fee head not defined for CONVENOR quota`);
      return;
    }

    // Distributed lock via PostgreSQL advisory lock — prevents two server instances
    // (webhook + heal job) from running this function concurrently for the same payment.
    // pg_try_advisory_lock is session-level; released explicitly in finally.
    const lockKey = `convenor_allot_${payment.id}`;
    const lockResult = await prisma.$queryRaw<[{ acquired: boolean }]>`
      SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS acquired
    `;
    if (!lockResult[0]?.acquired) {
      logger.info(`[completeAllotAfterPayment] Lock not acquired for payment=${payment.id} — another instance is processing it`);
      return;
    }

    let txCompleted = false;
    try {
    await prisma.$transaction(async (tx) => {
      const pendingDemand = payment.feeDemandId
        ? await tx.studentFeeDemand.findUnique({ where: { id: payment.feeDemandId } })
        : await tx.studentFeeDemand.findFirst({
            where: { studentId, feeHeadId: registrationFeeHead.id, isDeleted: false },
            orderBy: [{ status: 'desc' }, { createdAt: 'asc' }],
          });
      if (!pendingDemand) {
        logger.error(`[completeAllotAfterPayment] REGISTRATION demand not found for student=${studentId} — generate-demands must be called first`);
        return;
      }
      if (pendingDemand.status !== FeeStatus.FULL) {
        await tx.studentFeeDemand.update({
          where: { id: pendingDemand.id },
          data:  { status: FeeStatus.FULL, updatedBy: adminId },
        });
      }

      const body: AllotBody = {
        courseId,
        accommodation,
        payment: { amount: payment.amount, method: payment.method, referenceNumber: payment.referenceNumber ?? undefined, date: undefined },
      };

      const ran = await this._completeAllotInTx(tx, {
        id: convenorAdmissionId,
        studentId,
        course,
        academicYearId,
        body,
        adminId,
        ca: { courseId: caCourseId, entryYear: caEntryYear },
      });
      txCompleted = ran;
    }, { timeout: 20000 });

    // only run post-tx work if the transaction actually completed the allotment
    if (!txCompleted) return;

    const body: AllotBody = {
      courseId,
      accommodation,
      payment: { amount: payment.amount, method: payment.method },
    };

    await this._completeAllotPostTx({
      id: convenorAdmissionId,
      studentId,
      body,
      courseId,
      academicYearId,
      adminId,
    });

    logger.info(`[completeAllotAfterPayment] Completed for CA=${convenorAdmissionId} student=${studentId}`);
    } finally {
      // Always release the advisory lock so the connection isn't held indefinitely
      await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${lockKey}))`.catch(() => {});
    }
  },

  async exportCsv(filters: ListFilters) {
    const records = await prisma.convenorAdmission.findMany({
      where: buildWhere(filters),
      include: includeWithStudent,
      orderBy: { createdAt: 'desc' },
    });

    const escape = (v: any): string => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const docKeys = Object.keys(DOC_LABEL_MAP);
    const docHeaders = docKeys.map(k => DOC_LABEL_MAP[k]);

    const headers = [
      'HallTicket', 'ApplicantName', 'Gender', 'Category', 'Region',
      'AlottedCategory', 'Phase', 'Rank', 'Degree', 'Course', 'OmrId',
      'InstitutionCode', 'EntryYear', 'AcademicYear', 'Status',
      'FeesReimbursement', ...docHeaders, 'CreatedAt',
    ];

    const rows = records.map(r => {
      const submittedKeys = new Set(
        Array.isArray(r.documentsSubmitted)
          ? (r.documentsSubmitted as { key: string; status: string }[])
              .filter(d => d.status === 'SUBMITTED').map(d => d.key)
          : []
      );
      const docValues = docKeys.map(k => submittedKeys.has(k) ? 'Submitted' : 'Pending');

      return [
        r.hallTicketNo,
        r.applicantName,
        r.gender,
        r.category,
        r.region,
        r.alottedCategory,
        r.phase,
        r.rank,
        r.degree,
        r.courseRelation?.name ?? null,
        r.omrId,
        r.institutionCode?.code ?? null,
        r.entryYear,
        r.year,
        r.status,
        r.feesReimbursement ? 'YES' : 'NO',
        ...docValues,
        r.createdAt?.toISOString() ?? null,
      ].map(escape).join(',');
    });

    return [headers.map(escape).join(','), ...rows].join('\n');
  },

  async updateStatus(id: string, status: string, userId?: string) {
    const record = await prisma.convenorAdmission.update({
      where: { id },
      data: { status, updatedBy: userId },
      include: includeWithStudent,
    });
    return maskStudent(record);
  },

  async updateDetails(id: string, body: {
    // CA fields
    applicantName?: string;
    gender?: string;
    category?: string;
    region?: string;
    alottedCategory?: string;
    phase?: string;
    rank?: string;
    degree?: string;
    courseId?: string;
    entryYear?: number;
    feesReimbursement?: boolean;
    documentsSubmitted?: { key: string; label: string; status: 'SUBMITTED' | 'PENDING' }[];
    // Student fields
    student?: {
      name?: string;
      phone?: string;
      email?: string;
      fatherName?: string;
      motherName?: string;
      aadharNumber?: string;
      dob?: string;
      address?: string;
      address2?: string;
      city?: string;
      pinCode?: string;
      state?: string;
    };
  }, userId?: string) {
    const ca = await prisma.convenorAdmission.findFirst({
      where: { id, isDeleted: false },
      select: { studentId: true, academicYearId: true },
    });
    if (!ca) throw new AppError('Convenor admission not found', 404);

    const { student: studentBody, ...caFields } = body;

    const record = await prisma.$transaction(async (tx) => {
      const updated = await tx.convenorAdmission.update({
        where: { id },
        data: {
          ...(caFields.applicantName    !== undefined ? { applicantName:   caFields.applicantName }   : {}),
          ...(caFields.gender           !== undefined ? { gender:          caFields.gender }           : {}),
          ...(caFields.category         !== undefined ? { category:        caFields.category }         : {}),
          ...(caFields.region           !== undefined ? { region:          caFields.region }           : {}),
          ...(caFields.alottedCategory  !== undefined ? { alottedCategory: caFields.alottedCategory }  : {}),
          ...(caFields.phase            !== undefined ? { phase:           caFields.phase }            : {}),
          ...(caFields.rank             !== undefined ? { rank:            caFields.rank }             : {}),
          ...(caFields.degree           !== undefined ? { degree:          caFields.degree }           : {}),
          ...(caFields.courseId         !== undefined ? { courseId:        caFields.courseId }         : {}),
          ...(caFields.entryYear        !== undefined ? { entryYear:       caFields.entryYear }        : {}),
          ...(caFields.feesReimbursement !== undefined ? { feesReimbursement: caFields.feesReimbursement } : {}),
          ...(caFields.documentsSubmitted !== undefined ? { documentsSubmitted: caFields.documentsSubmitted } : {}),
          updatedBy: userId,
        },
        include: includeWithStudent,
      });

      if (studentBody && ca.studentId && Object.keys(studentBody).length > 0) {
        await tx.student.update({
          where: { id: ca.studentId },
          data: {
            ...(studentBody.name         !== undefined ? { name:         studentBody.name }         : {}),
            ...(studentBody.phone        !== undefined ? { phone:        studentBody.phone }        : {}),
            ...(studentBody.email        !== undefined ? { email:        studentBody.email }        : {}),
            ...(studentBody.fatherName   !== undefined ? { fatherName:   studentBody.fatherName }   : {}),
            ...(studentBody.motherName   !== undefined ? { motherName:   studentBody.motherName }   : {}),
            ...(studentBody.aadharNumber !== undefined ? { aadharNumber: studentBody.aadharNumber } : {}),
            ...(studentBody.dob          !== undefined ? { dob:          new Date(studentBody.dob) } : {}),
            ...(studentBody.address      !== undefined ? { address:      studentBody.address }      : {}),
            ...(studentBody.address2     !== undefined ? { address2:     studentBody.address2 }     : {}),
            ...(studentBody.city         !== undefined ? { city:         studentBody.city }         : {}),
            ...(studentBody.pinCode      !== undefined ? { pinCode:      studentBody.pinCode }      : {}),
            ...(studentBody.state        !== undefined ? { state:        studentBody.state }        : {}),
            updatedBy: userId,
          },
        });
      }

      return updated;
    });

    // Sync StudentDocument physicalCopy flags when docs are updated and student is linked
    if (caFields.documentsSubmitted && ca.studentId) {
      await Promise.all(
        caFields.documentsSubmitted.map(doc =>
          prisma.studentDocument.upsert({
            where:  { studentId_documentKey: { studentId: ca.studentId!, documentKey: doc.key } },
            create: {
              studentId:     ca.studentId!,
              documentKey:   doc.key,
              url:           '',
              status:        'PENDING',
              physicalCopy:  doc.status === 'SUBMITTED',
              academicYearId: (ca.academicYearId ?? undefined) as string,
              createdBy:     userId,
            },
            update: { physicalCopy: doc.status === 'SUBMITTED', updatedBy: userId },
          })
        )
      );
    }

    return maskStudent(record);
  },

  async getOrGenerateCertificate(id: string, adminId: string, refresh = false): Promise<string> {
    const ca = await prisma.convenorAdmission.findFirst({
      where: { id, isDeleted: false },
      include: includeWithStudent,
    });
    if (!ca) throw new AppError('Convenor admission not found', 404);
    if (!ca.studentId) throw new AppError('Student not yet reported for this admission', 400);

    const s3Key = `student/${ca.studentId}/documents/custodian_certificate.pdf`;

    if (!refresh) {
      const existing = await prisma.studentDocument.findUnique({
        where: { studentId_documentKey: { studentId: ca.studentId, documentKey: 'CUSTODIAN_CERTIFICATE' } },
        select: { url: true },
      });
      if (existing?.url) return getPresignedUrl(s3Key);
    }

    const activeAcademicYear = await prisma.academicYear.findFirst({ where: { isActive: true }, select: { id: true } });
    const activeAcademicYearId = (activeAcademicYear?.id ?? ca.academicYearId) as string;

    const entryYearOfStudy = (ca as any).entryYear ?? 1;
    const documentsSubmitted: { key: string; label: string; status: 'SUBMITTED' | 'PENDING' }[] =
      Array.isArray((ca as any).documentsSubmitted) ? (ca as any).documentsSubmitted : [];

    const eapcetQual = ca.studentId
      ? await prisma.academicQualification.findFirst({
          where: { studentId: ca.studentId, level: 'EAPCET' },
          select: { hallTicketNumber: true },
        })
      : null;

    const pdf = await generateCustodianCertificate({
      admissionNo:        (ca.student as any)?.applicationId ?? id,
      studentName:        ca.applicantName ?? (ca.student as any)?.name ?? '',
      gender:             ca.gender ?? '',
      fatherName:         (ca.student as any)?.fatherName ?? undefined,
      branch:             (ca.courseRelation as any)?.name ?? undefined,
      hallTicketNo:       ca.hallTicketNo ?? '',
      academicYear:       (ca.academicYear as any)?.code ?? '',
      entryYear:          entryYearOfStudy,
      documentsSubmitted,
      date:               new Date(),
    });

    const url = await uploadFileToS3(pdf, s3Key, 'application/pdf');
    await prisma.studentDocument.upsert({
      where:  { studentId_documentKey: { studentId: ca.studentId, documentKey: 'CUSTODIAN_CERTIFICATE' } },
      create: {
        studentId:      ca.studentId,
        documentKey:    'CUSTODIAN_CERTIFICATE',
        url,
        status:         'APPROVED' as any,
        physicalCopy:   false,
        academicYearId: activeAcademicYearId,
        createdBy:      adminId,
      },
      update: { url, updatedBy: adminId },
    });

    return getPresignedUrl(s3Key);
  },
};
