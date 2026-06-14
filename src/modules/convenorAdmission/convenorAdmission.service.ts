import prisma from '../../config/prisma';
import { Prisma } from '@prisma/client';

export const CONVENOR_STATUSES = ['NOT_REPORTED', 'REPORTED', 'SEAT_CONFIRMED'] as const;

interface ListFilters {
  status?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

const buildWhere = (filters: ListFilters): Prisma.ConvenorAdmissionWhereInput => {
  const where: Prisma.ConvenorAdmissionWhereInput = { isDeleted: false };

  if (filters.status) where.status = filters.status;

  if (filters.fromDate || filters.toDate) {
    where.createdAt = {
      ...(filters.fromDate ? { gte: new Date(filters.fromDate) } : {}),
      ...(filters.toDate   ? { lte: new Date(new Date(filters.toDate).setHours(23, 59, 59, 999)) } : {}),
    };
  }

  if (filters.search) {
    where.OR = [
      { hallTicketNo: { contains: filters.search, mode: 'insensitive' } },
      { applicantName: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  return where;
};

const include = {
  courseRelation:  { select: { id: true, name: true, code: true, degree: true } },
  institutionCode: { select: { id: true, code: true, name: true } },
  academicYear:    { select: { id: true, code: true } },
};

export const ConvenorAdmissionService = {
  async list(filters: ListFilters) {
    const page  = Math.max(1, filters.page  ?? 1);
    const limit = Math.min(200, filters.limit ?? 20);
    const where = buildWhere(filters);

    const [data, total] = await Promise.all([
      prisma.convenorAdmission.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.convenorAdmission.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  },

  async exportCsv(filters: ListFilters) {
    const records = await prisma.convenorAdmission.findMany({
      where: buildWhere(filters),
      include,
      orderBy: { createdAt: 'desc' },
    });

    const escape = (v: any): string => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const headers = [
      'HallTicket', 'ApplicantName', 'Gender', 'Category', 'Region',
      'AlottedCategory', 'Phase', 'Rank', 'Degree', 'Course', 'OmrId',
      'InstitutionCode', 'EntryYear', 'AcademicYear', 'Status', 'FeesReimbursement', 'CreatedAt',
    ];

    const rows = records.map(r => [
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
      r.createdAt?.toISOString() ?? null,
    ].map(escape).join(','));

    return [headers.join(','), ...rows].join('\n');
  },

  async updateStatus(id: string, status: string, userId?: string) {
    return prisma.convenorAdmission.update({
      where: { id },
      data: { status, updatedBy: userId },
      include,
    });
  },
};
