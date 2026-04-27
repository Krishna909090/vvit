import prisma from '../config/prisma';
import logger from './logger';

export type HostelPaymentMode = 'YEARWISE' | 'SEMWISE';

export interface HostelCost {
    accommodationPrice: number;
    messPrice: number;
    laundryPrice: number;
    registrationFee: number;
    semwiseSurcharge: number;  // diff between semwise and yearwise totals; 0 in YEARWISE
    totalPrice: number;        // accommodation + mess + laundry + registration (mode-aware)
}

const DEFAULT_COST: HostelCost = {
    accommodationPrice: 0,
    messPrice: 0,
    laundryPrice: 0,
    registrationFee: 0,
    semwiseSurcharge: 0,
    totalPrice: 0
};

const parseSharingCount = (hostelType: string | null | undefined): number | null => {
    if (!hostelType) return null;
    const match = hostelType.match(/SHARING_(\d+)/);
    return match ? parseInt(match[1]) : null;
};

const computeCost = (priceCategory: any, paymentMode: HostelPaymentMode): HostelCost => {
    const yearwiseAcc = priceCategory.accommodationYearwise ?? 0;
    const yearwiseMess = priceCategory.messYearwise ?? 0;
    const yearwiseLaundry = priceCategory.laundryYearwise ?? 0;

    const semwiseAcc = priceCategory.accommodationSemwise ?? 0;
    const semwiseMess = priceCategory.messSemwise ?? 0;
    const semwiseLaundry = priceCategory.laundrySemwise ?? 0;

    const registrationFee = priceCategory.registrationFee ?? 0;

    if (paymentMode === 'SEMWISE') {
        const semwiseTotal = semwiseAcc + semwiseMess + semwiseLaundry;
        const yearwiseTotal = yearwiseAcc + yearwiseMess + yearwiseLaundry;
        return {
            accommodationPrice: semwiseAcc,
            messPrice: semwiseMess,
            laundryPrice: semwiseLaundry,
            registrationFee,
            semwiseSurcharge: Math.max(0, semwiseTotal - yearwiseTotal),
            totalPrice: semwiseTotal + registrationFee
        };
    }

    return {
        accommodationPrice: yearwiseAcc,
        messPrice: yearwiseMess,
        laundryPrice: yearwiseLaundry,
        registrationFee,
        semwiseSurcharge: 0,
        totalPrice: yearwiseAcc + yearwiseMess + yearwiseLaundry + registrationFee
    };
};

/**
 * Get hostel cost from HostelPriceCategory for a given hostel type + payment mode.
 * Single source of truth for all hostel pricing.
 */
export const getHostelCost = async (
    hostelType: string | null | undefined,
    paymentMode: HostelPaymentMode = 'YEARWISE',
    roomType?: string
): Promise<HostelCost> => {
    const sharing = parseSharingCount(hostelType);
    if (!sharing) return DEFAULT_COST;

    const where: any = { sharing };
    if (roomType) where.roomType = roomType;

    const priceCategory = await prisma.hostelPriceCategory.findFirst({ where });
    if (!priceCategory) {
        logger.warn(`[getHostelCost] No price category found for sharing=${sharing}, roomType=${roomType || 'any'}. Returning 0.`);
        return DEFAULT_COST;
    }
    return computeCost(priceCategory, paymentMode);
};

/**
 * Same as getHostelCost but within a transaction context.
 */
export const getHostelCostTx = async (
    hostelType: string | null | undefined,
    tx: any,
    paymentMode: HostelPaymentMode = 'YEARWISE',
    roomType?: string
): Promise<HostelCost> => {
    const sharing = parseSharingCount(hostelType);
    if (!sharing) return DEFAULT_COST;

    const where: any = { sharing };
    if (roomType) where.roomType = roomType;

    const priceCategory = await tx.hostelPriceCategory.findFirst({ where });
    if (!priceCategory) {
        logger.warn(`[getHostelCostTx] No price category found for sharing=${sharing}, roomType=${roomType || 'any'}. Returning 0.`);
        return DEFAULT_COST;
    }
    return computeCost(priceCategory, paymentMode);
};

/**
 * Get the semwise surcharge (= semwise total - yearwise total) for a hostel type.
 * Returns 0 if not configured.
 */
export const getSemwiseSurcharge = async (hostelType: string | null | undefined): Promise<number> => {
    const cost = await getHostelCost(hostelType, 'SEMWISE');
    return cost.semwiseSurcharge;
};

export const getSemwiseSurchargeTx = async (hostelType: string | null | undefined, tx: any): Promise<number> => {
    const cost = await getHostelCostTx(hostelType, tx, 'SEMWISE');
    return cost.semwiseSurcharge;
};
