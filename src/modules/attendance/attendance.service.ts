import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { AttendanceStatus } from '@prisma/client';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

const assertEnrollmentExists = async (studentId: string, academicYearId: string) => {
    const enrollment = await prisma.studentEnrollment.findFirst({
        where: { studentId, academicYearId },
        select: { id: true },
    });
    if (!enrollment) {
        throw new AppError(
            `No enrollment record for student=${studentId} in academicYearId=${academicYearId}. ` +
            `Cannot record attendance for a year the student was never enrolled in.`,
            400
        );
    }
};

// Normalize the input date to a date-only DateTime at UTC midnight, so the unique
// constraint correctly dedups "same date" regardless of how the caller specified time.
const normalizeDate = (input: string | Date): Date => {
    const d = typeof input === 'string' ? new Date(input) : input;
    if (isNaN(d.getTime())) throw new AppError(`Invalid date: ${input}`, 400);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

export const AttendanceService = {
    // ────────────────────────────────────────────────────────────────────────
    // Single mark
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Mark attendance for one student × subject × date (× optional period).
     * App-layer dedup gate because Postgres unique indexes treat NULL period
     * as distinct — two day-level rows would otherwise both pass.
     */
    markAttendance: async (
        data: {
            studentId:      string;
            subjectId:      string;
            academicYearId: string;
            date:           string | Date;
            periodNumber?:  number | null;
            status:         AttendanceStatus;
            remarks?:       string;
            isBackfilled?:  boolean;
        },
        userId: string
    ) => {
        const date = normalizeDate(data.date);
        const periodNumber = data.periodNumber ?? null;
        logger.info(
            `[attendance.mark] student=${data.studentId} subject=${data.subjectId} ` +
            `date=${date.toISOString().slice(0,10)} period=${periodNumber} status=${data.status}`
        );

        const subject = await prisma.subject.findUnique({
            where: { id: data.subjectId },
            select: { id: true, semester: true, isDeleted: true }
        });
        if (!subject || subject.isDeleted) throw new AppError('Subject not found', 404);

        await assertEnrollmentExists(data.studentId, data.academicYearId);

        // App-layer dedup for day-level rows (periodNumber=null). Postgres unique
        // indexes treat NULL as distinct, so two day-level rows would otherwise pass.
        const dup = await prisma.classAttendance.findFirst({
            where: {
                studentId:      data.studentId,
                subjectId:      data.subjectId,
                date,
                periodNumber,
                isDeleted:      false,
            }
        });
        if (dup) {
            throw new AppError(
                `Attendance already recorded for ${date.toISOString().slice(0,10)} period=${periodNumber ?? 'day'}. Use PUT to update.`,
                409
            );
        }

        return prisma.classAttendance.create({
            data: {
                studentId:      data.studentId,
                subjectId:      data.subjectId,
                academicYearId: data.academicYearId,
                semester:       subject.semester,
                date,
                periodNumber,
                status:         data.status,
                remarks:        data.remarks ?? null,
                markedBy:       userId,
                isBackfilled:   data.isBackfilled ?? false,
                createdBy:      userId,
                updatedBy:      userId,
            }
        });
    },

    // ────────────────────────────────────────────────────────────────────────
    // Bulk: one (subject, date, period) → many students. Faculty daily roll-call.
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Bulk roll-call: one (subject, date, period) → status per student. Used by
     * faculty taking daily attendance. Each row goes through `markAttendance`;
     * failures are collected and returned per-row without aborting the batch.
     */
    markClassAttendance: async (
        data: {
            subjectId:      string;
            academicYearId: string;
            date:           string | Date;
            periodNumber?:  number | null;
            isBackfilled?:  boolean;
            rows:           Array<{ studentId: string; status: AttendanceStatus; remarks?: string }>;
        },
        userId: string
    ) => {
        logger.info(`[attendance.markClass] subject=${data.subjectId} date=${data.date} rows=${data.rows.length}`);

        const date = normalizeDate(data.date);
        const periodNumber = data.periodNumber ?? null;

        const subject = await prisma.subject.findUnique({
            where: { id: data.subjectId },
            select: { id: true, semester: true, isDeleted: true }
        });
        if (!subject || subject.isDeleted) throw new AppError('Subject not found', 404);

        const results: Array<{ studentId: string; ok: boolean; attendanceId?: string; error?: string }> = [];

        for (const r of data.rows) {
            try {
                const rec = await AttendanceService.markAttendance(
                    {
                        studentId:      r.studentId,
                        subjectId:      data.subjectId,
                        academicYearId: data.academicYearId,
                        date,
                        periodNumber,
                        status:         r.status,
                        remarks:        r.remarks,
                        isBackfilled:   data.isBackfilled,
                    },
                    userId
                );
                results.push({ studentId: r.studentId, ok: true, attendanceId: rec.id });
            } catch (err: any) {
                results.push({ studentId: r.studentId, ok: false, error: err.message });
                logger.warn(`[attendance.markClass] studentId=${r.studentId} failed: ${err.message}`);
            }
        }

        const summary = results.reduce(
            (a, r) => { a.total++; a.ok += r.ok ? 1 : 0; a.failed += r.ok ? 0 : 1; return a; },
            { total: 0, ok: 0, failed: 0 }
        );
        return { summary, results };
    },

    // ────────────────────────────────────────────────────────────────────────
    // Bulk back-fill: one student → many (date, subject, period?, status) rows.
    // Typical admin import for historical attendance.
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Admin back-fill: one student → many (date, subject, period?, status)
     * rows. Each row tagged `isBackfilled=true` for audit so they're
     * distinguishable from real-time marks.
     */
    markAttendanceBackfill: async (
        studentId: string,
        academicYearId: string,
        rows: Array<{
            subjectId:    string;
            date:         string | Date;
            periodNumber?: number | null;
            status:       AttendanceStatus;
            remarks?:     string;
        }>,
        userId: string
    ) => {
        logger.info(`[attendance.backfill] student=${studentId} year=${academicYearId} rows=${rows.length}`);
        await assertEnrollmentExists(studentId, academicYearId);

        const results: Array<{ idx: number; ok: boolean; attendanceId?: string; error?: string }> = [];

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            try {
                const rec = await AttendanceService.markAttendance(
                    {
                        studentId,
                        subjectId:      r.subjectId,
                        academicYearId,
                        date:           r.date,
                        periodNumber:   r.periodNumber,
                        status:         r.status,
                        remarks:        r.remarks,
                        isBackfilled:   true,
                    },
                    userId
                );
                results.push({ idx: i, ok: true, attendanceId: rec.id });
            } catch (err: any) {
                results.push({ idx: i, ok: false, error: err.message });
                logger.warn(`[attendance.backfill] row=${i} failed: ${err.message}`);
            }
        }

        const summary = results.reduce(
            (a, r) => { a.total++; a.ok += r.ok ? 1 : 0; a.failed += r.ok ? 0 : 1; return a; },
            { total: 0, ok: 0, failed: 0 }
        );
        return { summary, results };
    },

    // ────────────────────────────────────────────────────────────────────────
    // Update / delete
    // ────────────────────────────────────────────────────────────────────────

    /** Patch a single attendance row (status / remarks / backfilled flag). */
    updateAttendance: async (
        id: string,
        data: Partial<{ status: AttendanceStatus; remarks: string; isBackfilled: boolean }>,
        userId: string
    ) => {
        const existing = await prisma.classAttendance.findUnique({ where: { id } });
        if (!existing || existing.isDeleted) throw new AppError('Attendance record not found', 404);

        return prisma.classAttendance.update({
            where: { id },
            data:  { ...data, updatedBy: userId }
        });
    },

    /** Soft-delete an attendance row (isDeleted=true). Keeps audit history. */
    deleteAttendance: async (id: string, userId: string) => {
        const existing = await prisma.classAttendance.findUnique({ where: { id } });
        if (!existing || existing.isDeleted) throw new AppError('Attendance record not found', 404);

        return prisma.classAttendance.update({
            where: { id },
            data:  { isDeleted: true, updatedBy: userId }
        });
    },

    // ────────────────────────────────────────────────────────────────────────
    // Read paths
    // ────────────────────────────────────────────────────────────────────────

    /**
     * One student's attendance, optionally narrowed by subject / year / date
     * range / semester. Ordered chronologically (date asc, period asc).
     */
    getStudentAttendance: async (
        studentId: string,
        filters?: { subjectId?: string; academicYearId?: string; from?: string; to?: string; semester?: number }
    ) => {
        const where: any = { studentId, isDeleted: false };
        if (filters?.subjectId)      where.subjectId      = filters.subjectId;
        if (filters?.academicYearId) where.academicYearId = filters.academicYearId;
        if (filters?.semester)       where.semester       = filters.semester;
        if (filters?.from || filters?.to) {
            where.date = {};
            if (filters.from) where.date.gte = normalizeDate(filters.from);
            if (filters.to)   where.date.lte = normalizeDate(filters.to);
        }

        return prisma.classAttendance.findMany({
            where,
            orderBy: [{ date: 'asc' }, { periodNumber: 'asc' }],
            include: {
                subject: { select: { id: true, code: true, name: true } }
            }
        });
    },

    /** Class roll: every student's status for a given (subject, date, period?). */
    getClassAttendance: async (
        subjectId: string,
        date: string | Date,
        periodNumber?: number | null
    ) => {
        const normalizedDate = normalizeDate(date);
        const where: any = {
            subjectId,
            date: normalizedDate,
            isDeleted: false,
        };
        if (periodNumber !== undefined) where.periodNumber = periodNumber;

        return prisma.classAttendance.findMany({
            where,
            orderBy: { studentId: 'asc' },
            include: {
                student: { select: { id: true, name: true, applicationId: true } },
                subject: { select: { id: true, code: true, name: true } }
            }
        });
    },

    /**
     * Per-subject attendance summary for one student: counts per status +
     * percentage. Institution policy counts ON_DUTY and EXCUSED as "present"
     * for the percentage calculation (alongside PRESENT and LATE).
     * Also rolls up an overall % across all subjects in scope.
     */
    getAttendanceStats: async (
        studentId: string,
        filters?: { subjectId?: string; academicYearId?: string; semester?: number }
    ) => {
        const where: any = { studentId, isDeleted: false };
        if (filters?.subjectId)      where.subjectId      = filters.subjectId;
        if (filters?.academicYearId) where.academicYearId = filters.academicYearId;
        if (filters?.semester)       where.semester       = filters.semester;

        const rows = await prisma.classAttendance.groupBy({
            by: ['subjectId', 'status'],
            where,
            _count: { _all: true }
        });

        const bySubject = new Map<string, Record<string, number>>();
        for (const r of rows) {
            if (!bySubject.has(r.subjectId)) {
                bySubject.set(r.subjectId, {
                    PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0, ON_DUTY: 0, total: 0
                });
            }
            const bucket = bySubject.get(r.subjectId)!;
            bucket[r.status] = r._count._all;
            bucket.total    += r._count._all;
        }

        // Hydrate subject metadata for the response.
        const subjectIds = Array.from(bySubject.keys());
        const subjects = subjectIds.length > 0
            ? await prisma.subject.findMany({
                where: { id: { in: subjectIds } },
                select: { id: true, code: true, name: true, credits: true }
            })
            : [];
        const subjectMap = new Map(subjects.map(s => [s.id, s]));

        const subjectStats = subjectIds.map(sid => {
            const b = bySubject.get(sid)!;
            const presentish = b.PRESENT + b.LATE + b.EXCUSED + b.ON_DUTY;
            const percentage = b.total > 0 ? Math.round((presentish / b.total) * 10000) / 100 : null;
            return {
                subject: subjectMap.get(sid) || { id: sid },
                counts: { PRESENT: b.PRESENT, ABSENT: b.ABSENT, LATE: b.LATE, EXCUSED: b.EXCUSED, ON_DUTY: b.ON_DUTY },
                total: b.total,
                attendancePercentage: percentage,
            };
        });

        // Overall — across all subjects in scope.
        const overall = subjectStats.reduce(
            (acc, s) => {
                acc.PRESENT += s.counts.PRESENT;
                acc.ABSENT  += s.counts.ABSENT;
                acc.LATE    += s.counts.LATE;
                acc.EXCUSED += s.counts.EXCUSED;
                acc.ON_DUTY += s.counts.ON_DUTY;
                acc.total   += s.total;
                return acc;
            },
            { PRESENT: 0, ABSENT: 0, LATE: 0, EXCUSED: 0, ON_DUTY: 0, total: 0 }
        );
        const overallPresentish = overall.PRESENT + overall.LATE + overall.EXCUSED + overall.ON_DUTY;
        const overallPct = overall.total > 0 ? Math.round((overallPresentish / overall.total) * 10000) / 100 : null;

        return {
            studentId,
            overall: { counts: overall, attendancePercentage: overallPct },
            bySubject: subjectStats,
        };
    },
};
