import prisma from '../../../config/prisma';
import { AppError } from '../../../utils/AppError';
import { HostelRoomType } from '@prisma/client';

interface PriceCategoryInput {
    sharing: number;
    roomType: HostelRoomType;
    academicYearId: string;
    accommodationYearwise?: number;
    messYearwise?: number;
    laundryYearwise?: number;
    accommodationSemwise?: number;
    messSemwise?: number;
    laundrySemwise?: number;
    registrationFee?: number;
    metadata?: any;
    isActive?: boolean;
}

export const createPriceCategory = async (data: PriceCategoryInput, userId: string | null) => {
    if (!data.academicYearId) {
        throw new AppError('academicYearId is required when creating a hostel price category', 400);
    }

    const existing = await prisma.hostelPriceCategory.findFirst({
        where: {
            sharing: data.sharing,
            roomType: data.roomType,
            academicYearId: data.academicYearId,
        }
    });

    if (existing) {
        throw new AppError('Price category for this sharing, room type, and academic year already exists', 409);
    }

    return prisma.hostelPriceCategory.create({
        data: {
            ...data,
            createdBy: userId,
            updatedBy: userId
        }
    });
};

export const getAllPriceCategories = async () => {
    return prisma.hostelPriceCategory.findMany({
        orderBy: [
            { sharing: 'asc' },
            { roomType: 'asc' }
        ]
    });
};

export const getPriceCategoryById = async (id: string) => {
    const category = await prisma.hostelPriceCategory.findUnique({ where: { id } });
    if (!category) throw new AppError('Price category not found', 404);
    return category;
};

export const updatePriceCategory = async (id: string, data: Partial<PriceCategoryInput>, userId: string | null) => {

    const category = await prisma.hostelPriceCategory.findUnique({ where: { id } });
    if (!category) throw new AppError('Price category not found', 404);

    if ((data.sharing || data.roomType) && (data.sharing !== category.sharing || data.roomType !== category.roomType)) {
        const conflict = await prisma.hostelPriceCategory.findFirst({
            where: {
                sharing: data.sharing ?? category.sharing,
                roomType: data.roomType ?? category.roomType,
                NOT: { id }
            }
        });
        if (conflict) throw new AppError('Price category conflict', 409);
    }

    return prisma.hostelPriceCategory.update({
        where: { id },
        data: {
            ...data,
            updatedBy: userId
        }
    });
};

export const deletePriceCategory = async (id: string) => {
    return prisma.hostelPriceCategory.delete({ where: { id } });
};
