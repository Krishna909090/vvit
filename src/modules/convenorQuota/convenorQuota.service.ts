import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';

const include = {
  course: { select: { id: true, name: true, code: true, degree: true } },
  academicYear: { select: { id: true, code: true } },
};

export const ConvenorQuotaService = {
  async getAll(academicYearId?: string, courseId?: string) {
    return prisma.convenorQuota.findMany({
      where: {
        isDeleted: false,
        ...(academicYearId ? { academicYearId } : {}),
        ...(courseId ? { courseId } : {}),
      },
      include,
      orderBy: { createdAt: 'desc' },
    });
  },

  async getById(id: string) {
    const record = await prisma.convenorQuota.findFirst({
      where: { id, isDeleted: false },
      include,
    });
    if (!record) throw new AppError('Convenor quota not found', 404);
    return record;
  },

  async create(
    courseId: string,
    academicYearId: string,
    totalSeats: number,
    reportedSeats: number,
    seatsConfirmed: number,
    userId?: string,
  ) {
    const existing = await prisma.convenorQuota.findFirst({
      where: { courseId, academicYearId, isDeleted: false },
    });
    if (existing) throw new AppError('Convenor quota already exists for this course and academic year', 409);

    return prisma.convenorQuota.create({
      data: {
        courseId,
        academicYearId,
        totalSeats,
        reportedSeats,
        seatsConfirmed,
        createdBy: userId,
        updatedAt: new Date(),
      },
      include,
    });
  },

  async update(
    id: string,
    data: { totalSeats?: number; reportedSeats?: number; seatsConfirmed?: number },
    userId?: string,
  ) {
    await ConvenorQuotaService.getById(id);
    return prisma.convenorQuota.update({
      where: { id },
      data: { ...data, updatedBy: userId },
      include,
    });
  },

  async delete(id: string, userId?: string) {
    await ConvenorQuotaService.getById(id);
    return prisma.convenorQuota.update({
      where: { id },
      data: { isDeleted: true, updatedBy: userId },
    });
  },
};
