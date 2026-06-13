import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';

export const InstitutionCodeService = {
  async getAll() {
    return prisma.institutionCode.findMany({
      where: { isDeleted: false },
      orderBy: { code: 'asc' },
    });
  },

  async getById(id: string) {
    const record = await prisma.institutionCode.findFirst({
      where: { id, isDeleted: false },
    });
    if (!record) throw new AppError('Institution code not found', 404);
    return record;
  },

  async create(code: string, name: string, userId?: string) {
    const existing = await prisma.institutionCode.findUnique({ where: { code } });
    if (existing) throw new AppError(`Institution code '${code}' already exists`, 409);
    return prisma.institutionCode.create({
      data: { code: code.trim().toUpperCase(), name: name.trim(), createdBy: userId, updatedAt: new Date() },
    });
  },

  async update(id: string, data: { code?: string; name?: string; isActive?: boolean }, userId?: string) {
    await InstitutionCodeService.getById(id);
    if (data.code) {
      const conflict = await prisma.institutionCode.findFirst({
        where: { code: data.code.trim().toUpperCase(), id: { not: id }, isDeleted: false },
      });
      if (conflict) throw new AppError(`Institution code '${data.code}' already exists`, 409);
    }
    return prisma.institutionCode.update({
      where: { id },
      data: {
        ...(data.code ? { code: data.code.trim().toUpperCase() } : {}),
        ...(data.name ? { name: data.name.trim() } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        updatedBy: userId,
      },
    });
  },

  async delete(id: string, userId?: string) {
    await InstitutionCodeService.getById(id);
    return prisma.institutionCode.update({
      where: { id },
      data: { isDeleted: true, updatedBy: userId },
    });
  },
};
