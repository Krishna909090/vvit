// Waiting-list operations split out of adminStudent.service.ts.
// Exposes an object that the barrel composes into AdminStudentService.

import prisma from '../../../config/prisma';
import { AdmissionStatus, WaitingListStatus } from '@prisma/client';
import logger from '../../../utils/logger';
import { AppError } from '../../../utils/AppError';
import {
    getActiveAcademicYear,
} from '../../../utils/studentContext';
import {
    getCourseCapacity,
    tryAtomicIncrementCourseCapacity,
} from '../../../utils/courseCapacity';

export const WaitingListService = {
    /**
     * Bulk-add a student to the waitlist for one or more courses. Year-scoped:
     * same (student, course) is allowed across years, blocked twice in the
     * active year. Validates student + courses up front, skips already-waiting
     * entries silently and reports them in the response.
     */
    async addToWaitingList(data: { studentId: string; courseIds: string[]; remarks?: string }, adminId: string) {
        const { studentId, courseIds, remarks } = data;

        if (!studentId) throw new AppError('Student ID is required', 400);
        if (!courseIds || courseIds.length === 0) throw new AppError('At least one course ID is required', 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            select: { id: true, name: true, applicationId: true }
        });
        if (!student) throw new AppError('Student not found', 404);

        // Validate all courses exist
        const courses = await prisma.course.findMany({
            where: { id: { in: courseIds }, isDeleted: false },
            select: { id: true, name: true, degree: true }
        });
        if (courses.length !== courseIds.length) {
            const foundIds = courses.map(c => c.id);
            const missing = courseIds.filter(id => !foundIds.includes(id));
            throw new AppError(`Courses not found: ${missing.join(', ')}`, 404);
        }

        // Year-scoped duplicate check: same student + course is allowed across years,
        // but not twice in the same active year.
        const dupYear = await getActiveAcademicYear();
        const existing = await prisma.waitingList.findMany({
            where: {
                studentId,
                courseId: { in: courseIds },
                academicYearId: dupYear.id,
                status: WaitingListStatus.WAITING,
            }
        });
        const existingCourseIds = new Set(existing.map(e => e.courseId));

        // Only create entries for courses not already in waiting list
        const newCourseIds = courseIds.filter(id => !existingCourseIds.has(id));

        if (newCourseIds.length === 0) {
            throw new AppError('Student is already on the waiting list for all selected courses', 409);
        }

        // Year-tag waitlist entries with the active academic year.
        const waitingYearId = (await getActiveAcademicYear()).id;

        // Get current max priority for each course to assign next position
        const entries = await prisma.$transaction(
            newCourseIds.map(courseId =>
                prisma.waitingList.create({
                    data: {
                        studentId,
                        courseId,
                        academicYearId: waitingYearId,
                        remarks,
                        status: WaitingListStatus.WAITING,
                        createdBy: adminId,
                    },
                    include: {
                        course: { select: { name: true, degree: true } }
                    }
                })
            )
        );

        logger.info(`[addToWaitingList] Student=${studentId} added to ${entries.length} course(s): ${newCourseIds.join(', ')}`);

        return {
            student: { id: student.id, name: student.name, applicationId: student.applicationId },
            added: (entries as any[]).map((e: any) => ({
                id: e.id,
                courseId: e.courseId,
                courseName: e.course.name,
                degree: e.course.degree,
                status: e.status,
            })),
            skipped: existingCourseIds.size > 0
                ? courses.filter(c => existingCourseIds.has(c.id)).map(c => ({ courseId: c.id, courseName: c.name, reason: 'Already on waiting list' }))
                : [],
        };
    },

    /**
     * Get the waiting list for a specific course or all courses.
     * availableSeats is scoped to the active academic year.
     */
    async getWaitingList(query: { courseId?: string; status?: string; page?: number; limit?: number }) {
        const { courseId, status, page = 1, limit = 50 } = query;
        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);

        const where: any = {};
        if (courseId) where.courseId = courseId;
        if (status) where.status = status;
        else where.status = WaitingListStatus.WAITING;

        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            select: { id: true },
        });

        const [entries, total] = await Promise.all([
            prisma.waitingList.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'asc' },
                include: {
                    student: {
                        select: { id: true, name: true, applicationId: true, phone: true, email: true, degreeType: true }
                    },
                    course: {
                        select: { id: true, name: true, degree: true }
                    }
                }
            }),
            prisma.waitingList.count({ where })
        ]);

        // Batch-load CourseCapacity for the active year, keyed by courseId
        const uniqueCourseIds = Array.from(new Set(entries.map(e => e.courseId)));
        const capacities = activeYear
            ? await prisma.courseCapacity.findMany({
                where: { courseId: { in: uniqueCourseIds }, academicYearId: activeYear.id },
                select: { courseId: true, totalSeats: true, filledSeats: true },
            })
            : [];
        const capacityByCourse = new Map(capacities.map(c => [c.courseId, c]));

        return {
            entries: entries.map((e, i) => {
                const cap = capacityByCourse.get(e.courseId);
                const total  = cap?.totalSeats  ?? 0;
                const filled = cap?.filledSeats ?? 0;
                return {
                    id: e.id,
                    position: skip + i + 1,
                    student: e.student,
                    course: {
                        id: e.course.id,
                        name: e.course.name,
                        degree: e.course.degree,
                        totalSeats: total,
                        filledSeats: filled,
                        availableSeats: Math.max(0, total - filled),
                    },
                    status: e.status,
                    remarks: e.remarks,
                    createdAt: e.createdAt,
                };
            }),
            pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / take) }
        };
    },

    /**
     * Get waiting list entries for a specific student.
     * availableSeats is scoped to the student's admission academic year
     * (falls back to active year if no admission yet).
     */
    async getStudentWaitingList(studentId: string) {
        if (!studentId) throw new AppError('Student ID is required', 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            select: { admissionDetails: { select: { academicYearId: true } } },
        });

        let yearId = student?.admissionDetails?.academicYearId;
        if (!yearId) {
            const activeYear = await prisma.academicYear.findFirst({
                where: { isActive: true, isDeleted: false },
                select: { id: true },
            });
            yearId = activeYear?.id;
        }

        const entries = await prisma.waitingList.findMany({
            where: { studentId },
            orderBy: { createdAt: 'asc' },
            include: {
                course: { select: { id: true, name: true, degree: true } }
            }
        });

        const uniqueCourseIds = Array.from(new Set(entries.map(e => e.courseId)));
        const capacities = yearId
            ? await prisma.courseCapacity.findMany({
                where: { courseId: { in: uniqueCourseIds }, academicYearId: yearId },
                select: { courseId: true, totalSeats: true, filledSeats: true },
            })
            : [];
        const capacityByCourse = new Map(capacities.map(c => [c.courseId, c]));

        return entries.map(e => {
            const cap = capacityByCourse.get(e.courseId);
            const total  = cap?.totalSeats  ?? 0;
            const filled = cap?.filledSeats ?? 0;
            return {
                id: e.id,
                courseId: e.courseId,
                courseName: e.course.name,
                degree: e.course.degree,
                availableSeats: Math.max(0, total - filled),
                status: e.status,
                remarks: e.remarks,
                createdAt: e.createdAt,
            };
        });
    },

    /**
     * Allot a seat from the waiting list. Moves student from WAITING → ALLOTTED
     * and triggers the standard seat allotment flow.
     */
    async allotFromWaitingList(waitingListId: string, adminId: string) {
        if (!waitingListId) throw new AppError('Waiting list entry ID is required', 400);

        const entry = await prisma.waitingList.findUnique({
            where: { id: waitingListId },
            include: {
                student: { include: { admissionDetails: true } },
                course: true
            }
        });

        if (!entry) throw new AppError('Waiting list entry not found', 404);
        if (entry.status !== WaitingListStatus.WAITING) throw new AppError(`Entry is already ${entry.status}`, 400);
        if (!entry.student.admissionDetails) throw new AppError('Student has no admission record', 400);
        const ayId = entry.student.admissionDetails.academicYearId;
        if (!ayId) throw new AppError('Admission has no academic year', 400);

        // Check seat availability for this academic year
        const capacity = await getCourseCapacity(prisma, entry.courseId, ayId);
        const availableSeats = capacity.totalSeats - capacity.filledSeats;
        if (availableSeats <= 0) throw new AppError(`No seats available in ${entry.course.name}`, 400);

        await prisma.$transaction(async (tx) => {
            // 1. Atomic check-and-increment for this year's capacity
            const claimed = await tryAtomicIncrementCourseCapacity(tx, entry.courseId, ayId);
            if (!claimed) {
                throw new AppError(`No seats available in ${entry.course.name}`, 400);
            }

            // 2. Update admission
            await tx.studentAdmission.update({
                where: { studentId: entry.studentId },
                data: {
                    allottedCourseId: entry.courseId,
                    status: AdmissionStatus.SEAT_ALLOTTED,
                    seatAllottedAt: new Date(),
                    seatAllotedBy: adminId,
                }
            });

            // 3. Mark this entry as ALLOTTED
            await tx.waitingList.update({
                where: { id: waitingListId },
                data: { status: WaitingListStatus.ALLOTTED, allottedAt: new Date(), allottedBy: adminId, updatedBy: adminId }
            });

            // 4. Cancel all other WAITING entries for this student
            await tx.waitingList.updateMany({
                where: { studentId: entry.studentId, status: WaitingListStatus.WAITING, id: { not: waitingListId } },
                data: { status: WaitingListStatus.CANCELLED, updatedBy: adminId }
            });

            // 5. Log seat allocation
            const seatAllocYearId = (await tx.academicYear.findFirstOrThrow({ where: { isActive: true, isDeleted: false } })).id;
            await tx.seatAllocation.create({
                data: {
                    studentId: entry.studentId,
                    academicYearId: seatAllocYearId,
                    newCourse: entry.courseId,
                    allocatedBy: adminId,
                    notes: `Allotted from waiting list`,
                }
            });
        });

        logger.info(`[allotFromWaitingList] Student=${entry.studentId} allotted to ${entry.course.name} from waiting list`);

        return {
            studentId: entry.studentId,
            studentName: entry.student.name,
            courseId: entry.courseId,
            courseName: entry.course.name,
            degree: entry.course.degree,
            status: 'ALLOTTED',
        };
    },

    /**
     * Remove a student from the waiting list (cancel specific entry or all).
     */
    async removeFromWaitingList(data: { waitingListId?: string; studentId?: string; courseId?: string }, adminId: string) {
        const { waitingListId, studentId, courseId } = data;

        if (waitingListId) {
            // Cancel specific entry
            const entry = await prisma.waitingList.findUnique({ where: { id: waitingListId } });
            if (!entry) throw new AppError('Waiting list entry not found', 404);
            if (entry.status !== WaitingListStatus.WAITING) throw new AppError(`Entry is already ${entry.status}`, 400);

            await prisma.waitingList.update({
                where: { id: waitingListId },
                data: { status: WaitingListStatus.CANCELLED, updatedBy: adminId }
            });

            return { cancelled: 1 };
        }

        if (studentId) {
            // Cancel all waiting entries for a student (optionally filtered by course)
            const where: any = { studentId, status: WaitingListStatus.WAITING };
            if (courseId) where.courseId = courseId;

            const result = await prisma.waitingList.updateMany({
                where,
                data: { status: WaitingListStatus.CANCELLED, updatedBy: adminId }
            });

            return { cancelled: result.count };
        }

        throw new AppError('Either waitingListId or studentId is required', 400);
    },
};
