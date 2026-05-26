import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';

export const CourseCapacityService = {
    /**
     * Create a fresh `(courseId, academicYearId)` capacity row. Rejects with 409
     * if a row already exists for that pair — use `upsert` to set-or-update.
     */
    async create(data: {
        courseId: string;
        academicYearId: string;
        totalSeats: number;
        filledSeats?: number;
        createdBy?: string;
    }) {
        const course = await prisma.course.findUnique({
            where: { id: data.courseId },
            select: { id: true, isDeleted: true },
        });
        if (!course || course.isDeleted) throw new AppError('Course not found', 404);

        const ay = await prisma.academicYear.findUnique({
            where: { id: data.academicYearId },
            select: { id: true, isDeleted: true },
        });
        if (!ay || ay.isDeleted) throw new AppError('Academic year not found', 404);

        if (data.totalSeats < 0) throw new AppError('totalSeats must be >= 0', 400);
        if (data.filledSeats !== undefined && data.filledSeats < 0) {
            throw new AppError('filledSeats must be >= 0', 400);
        }

        try {  
            return await prisma.courseCapacity.create({
                data: {
                    courseId:       data.courseId,
                    academicYearId: data.academicYearId,
                    totalSeats:     data.totalSeats,
                    filledSeats:    data.filledSeats ?? 0,
                    createdBy:      data.createdBy,
                },
            });
        } catch (err: any) {
            if (err?.code === 'P2002') {
                throw new AppError('Capacity already exists for this course and academic year. Use PUT to update.', 409);
            }
            throw err;
        }
    },

    /**
     * Set capacity for a `(courseId, academicYearId)` pair, creating the row if
     * missing or updating `totalSeats` if it already exists. `filledSeats` is
     * never overwritten on update — admins manage it via {@link update}.
     */
    async upsert(data: {
        courseId: string;
        academicYearId: string;
        totalSeats: number;
        createdBy?: string;
    }) {
        const course = await prisma.course.findUnique({
            where: { id: data.courseId },
            select: { id: true, isDeleted: true },
        });
        if (!course || course.isDeleted) throw new AppError('Course not found', 404);

        const ay = await prisma.academicYear.findUnique({
            where: { id: data.academicYearId },
            select: { id: true, isDeleted: true },
        });
        if (!ay || ay.isDeleted) throw new AppError('Academic year not found', 404);

        if (data.totalSeats < 0) throw new AppError('totalSeats must be >= 0', 400);

        return prisma.courseCapacity.upsert({
            where: {
                courseId_academicYearId: {
                    courseId:       data.courseId,
                    academicYearId: data.academicYearId,
                },
            },
            create: {
                courseId:       data.courseId,
                academicYearId: data.academicYearId,
                totalSeats:     data.totalSeats,
                filledSeats:    0,
                createdBy:      data.createdBy,
            },
            update: {
                totalSeats: data.totalSeats,
                updatedBy:  data.createdBy,
            },
        });
    },

    /**
     * Set capacity for many courses in a single academic year atomically.
     * Validates every courseId up front; rolls back if any row is invalid.
     * Used by the admin "configure capacities for the year" bulk screen.
     */
    async bulkUpsert(data: {
        academicYearId: string;
        rows: Array<{ courseId: string; totalSeats: number }>;
        createdBy?: string;
    }) {
        if (!data.rows.length) throw new AppError('rows must be non-empty', 400);

        const ay = await prisma.academicYear.findUnique({
            where: { id: data.academicYearId },
            select: { id: true, isDeleted: true },
        });
        if (!ay || ay.isDeleted) throw new AppError('Academic year not found', 404);

        const courseIds = data.rows.map(r => r.courseId);
        const courses = await prisma.course.findMany({
            where: { id: { in: courseIds }, isDeleted: false },
            select: { id: true },
        });
        const validIds = new Set(courses.map(c => c.id));
        const missing  = courseIds.filter(id => !validIds.has(id));
        if (missing.length) throw new AppError(`Course(s) not found: ${missing.join(', ')}`, 404);

        const results = await prisma.$transaction(
            data.rows.map(row =>
                prisma.courseCapacity.upsert({
                    where: {
                        courseId_academicYearId: {
                            courseId:       row.courseId,
                            academicYearId: data.academicYearId,
                        },
                    },
                    create: {
                        courseId:       row.courseId,
                        academicYearId: data.academicYearId,
                        totalSeats:     row.totalSeats,
                        filledSeats:    0,
                        createdBy:      data.createdBy,
                    },
                    update: {
                        totalSeats: row.totalSeats,
                        updatedBy:  data.createdBy,
                    },
                }),
            ),
        );

        return { count: results.length, rows: results };
    },

    /**
     * List capacities with optional filters: `courseId`, `academicYearId`,
     * `degree` (case-insensitive), or `search` (matches course name/code).
     * Eager-loads the parent course + academic year for UI display.
     */
    async list(filters?: { courseId?: string; academicYearId?: string; degree?: string; search?: string }) {
        const where: any = {};
        if (filters?.courseId)       where.courseId       = filters.courseId;
        if (filters?.academicYearId) where.academicYearId = filters.academicYearId;

        // Filter by Course.degree (e.g. "B.Tech", "M.Tech", "MBA"). Case-insensitive equality.
        const courseFilter: any = {};
        if (filters?.degree) {
            courseFilter.degree = { equals: filters.degree, mode: 'insensitive' };
        }
        if (filters?.search) {
            courseFilter.OR = [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { code: { contains: filters.search, mode: 'insensitive' } },
            ];
        }
        if (Object.keys(courseFilter).length > 0) {
            where.course = courseFilter;
        }

        const rows = await prisma.courseCapacity.findMany({
            where,
            include: {
                course:       { select: { id: true, name: true, code: true, degree: true } },
                academicYear: { select: { id: true, code: true, isActive: true } },
            },
            orderBy: [
                { academicYear: { code: 'desc' } },
                { course:       { code: 'asc' } },
            ],
        });

        // Surface the course's degree as a top-level `degreeType` for convenience (still
        // available nested under `course.degree`).
        return rows.map((r: any) => ({ ...r, degreeType: r.course?.degree ?? null }));
    },

    /** Fetch a single capacity row by primary key, with course + year eager-loaded. */
    async getOne(id: string) {
        const row = await prisma.courseCapacity.findUnique({
            where: { id },
            include: {
                course:       { select: { id: true, name: true, code: true, degree: true } },
                academicYear: { select: { id: true, code: true, isActive: true } },
            },
        });
        if (!row) throw new AppError('Capacity not found', 404);
        return row;
    },

    /**
     * Update `totalSeats` or `filledSeats` on a specific capacity row.
     * Enforces `filledSeats <= totalSeats` as a hard invariant.
     */
    async update(id: string, data: { totalSeats?: number; filledSeats?: number; updatedBy?: string }) {
        if (data.totalSeats !== undefined && data.totalSeats < 0) {
            throw new AppError('totalSeats must be >= 0', 400);
        }
        if (data.filledSeats !== undefined && data.filledSeats < 0) {
            throw new AppError('filledSeats must be >= 0', 400);
        }

        const existing = await prisma.courseCapacity.findUnique({ where: { id } });
        if (!existing) throw new AppError('Capacity not found', 404);

        const nextTotal  = data.totalSeats  ?? existing.totalSeats;
        const nextFilled = data.filledSeats ?? existing.filledSeats;
        if (nextFilled > nextTotal) {
            throw new AppError(`filledSeats (${nextFilled}) cannot exceed totalSeats (${nextTotal})`, 400);
        }

        return prisma.courseCapacity.update({
            where: { id },
            data: {
                totalSeats:  data.totalSeats,
                filledSeats: data.filledSeats,
                updatedBy:   data.updatedBy,
            },
        });
    },

    /**
     * Hard-delete a capacity row. Blocks if `filledSeats > 0` so we don't lose
     * track of allotted students — admin must reassign/cancel them first.
     */
    async remove(id: string) {
        const existing = await prisma.courseCapacity.findUnique({ where: { id } });
        if (!existing) throw new AppError('Capacity not found', 404);
        if (existing.filledSeats > 0) {
            throw new AppError(`Cannot delete capacity: ${existing.filledSeats} seat(s) already filled. Reassign or cancel students first.`, 409);
        }
        await prisma.courseCapacity.delete({ where: { id } });
        return { id, deleted: true };
    },
};
