import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { convertToPresignedUrl } from '../../utils/s3Utils';
import { maskAadhaar } from '../../utils/mask';

/**
 * Resolve the PRO record for a logged-in user.
 * Looks up PRO.userId === current user id.
 */
const getProByUserId = async (userId: string) => {
    const pro = await prisma.pRO.findUnique({
        where: { userId },
        select: { id: true, proNumber: true, name: true, phone: true, email: true }
    });
    if (!pro) {
        throw new AppError('No PRO profile linked to this user account', 403);
    }
    return pro;
};

/**
 * PRO Self: Get PRO profile for the authenticated user.
 */
export const getMyProProfile = async (userId: string) => {
    return getProByUserId(userId);
};

/**
 * PRO Self: List all students assigned to this PRO (with pagination + search).
 *
 * Search supports applicationId, name, phone.
 * Filters: page, limit, search, status (admission status).
 */
export const getMyProStudents = async (userId: string, query: any) => {
    const pro = await getProByUserId(userId);

    const page = Math.max(1, parseInt(String(query.page || 1)));
    const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || 25))));
    const skip = (page - 1) * limit;

    const where: any = { proId: pro.id };

    if (query.search) {
        where.OR = [
            { applicationId: { contains: String(query.search), mode: 'insensitive' } },
            { name: { contains: String(query.search), mode: 'insensitive' } },
            { phone: { contains: String(query.search) } }
        ];
    }

    if (query.status) {
        where.admissionDetails = { status: String(query.status) };
    }

    const [total, students] = await Promise.all([
        prisma.student.count({ where }),
        prisma.student.findMany({
            where,
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                applicationId: true,
                name: true,
                phone: true,
                email: true,
                gender: true,
                degreeType: true,
                profilePhotoUrl: true,
                aadharNumber: true,
                createdAt: true,
                admissionDetails: {
                    select: {
                        status: true,
                        allottedCourseId: true,
                        allottedCourse: { select: { id: true, name: true, code: true } }
                    }
                }
            }
        })
    ]);

    // Presigned profile photos + masked aadhaar
    const data = await Promise.all(students.map(async (s: any) => ({
        ...s,
        profilePhotoUrl: await convertToPresignedUrl(s.profilePhotoUrl),
        aadharNumber: maskAadhaar(s.aadharNumber)
    })));

    logger.info(`[getMyProStudents] pro=${pro.proNumber} total=${total}`);

    return {
        pro,
        data,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        }
    };
};

/**
 * PRO Self: Commission summary for all students assigned.
 */
export const getMyProCommissionSummary = async (userId: string) => {
    const pro = await getProByUserId(userId);

    const totalStudents = await prisma.student.count({ where: { proId: pro.id } });

    return {
        pro,
        totalStudents,
        totalCommission: 0
    };
};
