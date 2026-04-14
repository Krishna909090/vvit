import prisma from '../config/prisma';
import logger from './logger';

interface HostelCost {
    accommodationPrice: number;
    messPrice: number;
    semwiseSurcharge: number;
    totalPrice: number;
}

const DEFAULT_COST: HostelCost = { accommodationPrice: 0, messPrice: 0, semwiseSurcharge: 0, totalPrice: 0 };

/**
 * Parse sharing count from hostel type string (e.g. "SHARING_4" → 4).
 */
const parseSharingCount = (hostelType: string | null | undefined): number | null => {
    if (!hostelType) return null;
    const match = hostelType.match(/SHARING_(\d+)/);
    return match ? parseInt(match[1]) : null;
};

/**
 * Get full hostel cost from HostelPriceCategory by hostel type and optional room type.
 * Single source of truth for all hostel pricing.
 */
export const getHostelCost = async (hostelType: string | null | undefined, roomType?: string): Promise<HostelCost> => {
    const sharing = parseSharingCount(hostelType);
    if (!sharing) return DEFAULT_COST;

    const where: any = { sharing };
    if (roomType) where.roomType = roomType;

    const priceCategory = await prisma.hostelPriceCategory.findFirst({ where });

    if (!priceCategory) {
        logger.warn(`[getHostelCost] No price category found for sharing=${sharing}, roomType=${roomType || 'any'}. Returning 0.`);
        return DEFAULT_COST;
    }

    const acc = priceCategory.accommodationPrice ?? priceCategory.price ?? 0;
    const mess = priceCategory.messPrice ?? 0;
    const semwise = priceCategory.semwiseSurcharge ?? 0;

    return {
        accommodationPrice: acc,
        messPrice: mess,
        semwiseSurcharge: semwise,
        totalPrice: acc + mess
    };
};

/**
 * Same as getHostelCost but within a transaction context.
 */
export const getHostelCostTx = async (hostelType: string | null | undefined, tx: any, roomType?: string): Promise<HostelCost> => {
    const sharing = parseSharingCount(hostelType);
    if (!sharing) return DEFAULT_COST;

    const where: any = { sharing };
    if (roomType) where.roomType = roomType;

    const priceCategory = await tx.hostelPriceCategory.findFirst({ where });

    if (!priceCategory) {
        logger.warn(`[getHostelCostTx] No price category found for sharing=${sharing}, roomType=${roomType || 'any'}. Returning 0.`);
        return DEFAULT_COST;
    }

    const acc = priceCategory.accommodationPrice ?? priceCategory.price ?? 0;
    const mess = priceCategory.messPrice ?? 0;
    const semwise = priceCategory.semwiseSurcharge ?? 0;

    return {
        accommodationPrice: acc,
        messPrice: mess,
        semwiseSurcharge: semwise,
        totalPrice: acc + mess
    };
};

/**
 * Get the semwise surcharge for a hostel type.
 */
export const getSemwiseSurcharge = async (hostelType: string | null | undefined): Promise<number> => {
    const cost = await getHostelCost(hostelType);
    return cost.semwiseSurcharge;
};

/**
 * Get the semwise surcharge within a transaction context.
 */
export const getSemwiseSurchargeTx = async (hostelType: string | null | undefined, tx: any): Promise<number> => {
    const cost = await getHostelCostTx(hostelType, tx);
    return cost.semwiseSurcharge;
};
