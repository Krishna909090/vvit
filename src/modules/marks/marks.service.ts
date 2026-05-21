import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { SubjectExamType, SemesterMarkStatus } from '@prisma/client';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

// Marks-recording invariant: any non-PENDING status MUST carry a grade string.
// Admin enters grade explicitly (we do not auto-derive from totalMarks per the
// product decision — see fee/marks design notes).
const assertGradeForStatus = (status: SemesterMarkStatus, grade: string | null | undefined) => {
    if (status !== 'PENDING' && (grade === null || grade === undefined || grade === '')) {
        throw new AppError(
            `grade is required when status=${status}. Only PENDING marks may omit grade.`,
            400
        );
    }
};

// Marks-recording invariant: the student must have an enrollment row for the
// target academic year. Any status is fine — back-fill supports COMPLETED.
const assertEnrollmentExists = async (studentId: string, academicYearId: string) => {
    const enrollment = await prisma.studentEnrollment.findFirst({
        where: { studentId, academicYearId },
        select: { id: true },
    });
    if (!enrollment) {
        throw new AppError(
            `No enrollment record for student=${studentId} in academicYearId=${academicYearId}. ` +
            `Cannot record marks for a year the student was never enrolled in.`,
            400
        );
    }
};

const assertMarksWithinCeiling = (
    subject: { maxInternalMarks: number | null; maxExternalMarks: number | null; maxTotalMarks: number | null },
    payload: { internalMarks?: number | null; externalMarks?: number | null; totalMarks?: number | null }
) => {
    if (payload.internalMarks !== null && payload.internalMarks !== undefined && subject.maxInternalMarks !== null
        && payload.internalMarks > subject.maxInternalMarks) {
        throw new AppError(`internalMarks ${payload.internalMarks} exceeds subject ceiling ${subject.maxInternalMarks}`, 400);
    }
    if (payload.externalMarks !== null && payload.externalMarks !== undefined && subject.maxExternalMarks !== null
        && payload.externalMarks > subject.maxExternalMarks) {
        throw new AppError(`externalMarks ${payload.externalMarks} exceeds subject ceiling ${subject.maxExternalMarks}`, 400);
    }
    if (payload.totalMarks !== null && payload.totalMarks !== undefined && subject.maxTotalMarks !== null
        && payload.totalMarks > subject.maxTotalMarks) {
        throw new AppError(`totalMarks ${payload.totalMarks} exceeds subject ceiling ${subject.maxTotalMarks}`, 400);
    }
};

export const MarksService = {
    // ────────────────────────────────────────────────────────────────────────
    // Subject (curriculum) CRUD
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Create a Subject (curriculum unit). Schema has @@unique on (courseId,
     * semester, code) — we pre-check to surface a clean 409 instead of P2002.
     * Defaults: 30/70/100 internal/external/total marks, THEORY exam type.
     */
    createSubject: async (
        data: {
            code:             string;
            name:             string;
            courseId:         string;
            semester:         number;
            credits?:         number;
            examType?:        SubjectExamType;
            maxInternalMarks?: number | null;
            maxExternalMarks?: number | null;
            maxTotalMarks?:    number | null;
            isElective?:      boolean;
        },
        userId: string
    ) => {
        logger.info(`[marks.createSubject] code=${data.code} course=${data.courseId} sem=${data.semester}`);

        const course = await prisma.course.findUnique({ where: { id: data.courseId } });
        if (!course) throw new AppError('Course not found', 404);

        // Idempotency: schema has @@unique on (courseId, semester, code).
        // Surface a clean 409 instead of a P2002 stack trace.
        const dup = await prisma.subject.findFirst({
            where: {
                courseId:         data.courseId,
                semester:         data.semester,
                code:             data.code,
                isDeleted:        false,
            }
        });
        if (dup) {
            throw new AppError(`Subject ${data.code} already exists for this course/semester`, 409);
        }

        return prisma.subject.create({
            data: {
                code:             data.code,
                name:             data.name,
                courseId:         data.courseId,
                semester:         data.semester,
                credits:          data.credits ?? 0,
                examType:         data.examType ?? 'THEORY',
                maxInternalMarks: data.maxInternalMarks ?? 30,
                maxExternalMarks: data.maxExternalMarks ?? 70,
                maxTotalMarks:    data.maxTotalMarks    ?? 100,
                isElective:       data.isElective ?? false,
                createdBy:        userId,
                updatedBy:        userId,
            }
        });
    },

    /** List non-deleted subjects with optional filters (course / semester / examType / isElective). */
    listSubjects: async (filters: {
        courseId?:         string;
        semester?:         number;
        examType?:         SubjectExamType;
        isElective?:       boolean;
    }) => {
        const where: any = { isDeleted: false };
        if (filters.courseId)         where.courseId = filters.courseId;
        if (filters.semester)         where.semester = filters.semester;
        if (filters.examType)         where.examType = filters.examType;
        if (filters.isElective !== undefined) where.isElective = filters.isElective;

        return prisma.subject.findMany({
            where,
            orderBy: [{ semester: 'asc' }, { code: 'asc' }],
            include: {
                course:         { select: { id: true, name: true, code: true } },
            }
        });
    },

    /** Patch a subject's code/name/credits/exam-type/marks-caps/elective flag. */
    updateSubject: async (
        id: string,
        data: Partial<{
            code:             string;
            name:             string;
            credits:          number;
            examType:         SubjectExamType;
            maxInternalMarks: number | null;
            maxExternalMarks: number | null;
            maxTotalMarks:    number | null;
            isElective:       boolean;
        }>,
        userId: string
    ) => {
        const existing = await prisma.subject.findUnique({ where: { id } });
        if (!existing || existing.isDeleted) throw new AppError('Subject not found', 404);

        return prisma.subject.update({
            where: { id },
            data: { ...data, updatedBy: userId },
        });
    },

    /** Soft-delete a subject (isDeleted=true). SemesterMark rows referencing it stay intact for history. */
    deleteSubject: async (id: string, userId: string) => {
        const existing = await prisma.subject.findUnique({ where: { id } });
        if (!existing || existing.isDeleted) throw new AppError('Subject not found', 404);

        // Block delete if active (non-deleted) marks exist — preserves audit trail.
        const markCount = await prisma.semesterMark.count({
            where: { subjectId: id, isDeleted: false }
        });
        if (markCount > 0) {
            throw new AppError(
                `Cannot delete subject — ${markCount} active SemesterMark record(s) reference it. ` +
                `Delete the marks first or soft-delete via admin tooling.`,
                409
            );
        }

        return prisma.subject.update({
            where: { id },
            data:  { isDeleted: true, updatedBy: userId }
        });
    },

    // ────────────────────────────────────────────────────────────────────────
    // SemesterMark CRUD
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Record a SemesterMark for one student × subject × year × attempt.
     * Validates internal/external/total marks against subject ceilings.
     * Computes grade + status (PASS/FAIL/AB) per institution scale.
     */
    recordMark: async (
        data: {
            studentId:        string;
            subjectId:        string;
            academicYearId:   string;
            internalMarks?:   number | null;
            externalMarks?:   number | null;
            totalMarks?:      number | null;
            grade?:           string | null;
            gradePoints?:     number | null;
            status?:          SemesterMarkStatus;
            attemptNumber?:   number;
            isSupplementary?: boolean;
            remarks?:         string;
            isBackfilled?:    boolean;
        },
        userId: string
    ) => {
        logger.info(
            `[marks.recordMark] student=${data.studentId} subject=${data.subjectId} ` +
            `year=${data.academicYearId} attempt=${data.attemptNumber ?? 1}`
        );

        const status        = data.status ?? 'PENDING';
        const attemptNumber = data.attemptNumber ?? 1;

        assertGradeForStatus(status, data.grade);

        const subject = await prisma.subject.findUnique({
            where: { id: data.subjectId },
            select: { id: true, semester: true, isDeleted: true, maxInternalMarks: true, maxExternalMarks: true, maxTotalMarks: true }
        });
        if (!subject || subject.isDeleted) throw new AppError('Subject not found', 404);

        assertMarksWithinCeiling(subject, data);
        await assertEnrollmentExists(data.studentId, data.academicYearId);

        // Surface duplicate-attempt conflict cleanly (DB has @@unique on the 4-tuple).
        const dup = await prisma.semesterMark.findFirst({
            where: {
                studentId:      data.studentId,
                subjectId:      data.subjectId,
                academicYearId: data.academicYearId,
                attemptNumber,
                isDeleted:      false,
            }
        });
        if (dup) {
            throw new AppError(
                `Mark already exists for attempt ${attemptNumber}. Use PUT to update, or pass a higher attemptNumber for supplementary.`,
                409
            );
        }

        return prisma.semesterMark.create({
            data: {
                studentId:       data.studentId,
                subjectId:       data.subjectId,
                academicYearId:  data.academicYearId,
                semester:        subject.semester,
                internalMarks:   data.internalMarks   ?? null,
                externalMarks:   data.externalMarks   ?? null,
                totalMarks:      data.totalMarks      ?? null,
                grade:           data.grade           ?? null,
                gradePoints:     data.gradePoints     ?? null,
                status,
                attemptNumber,
                isSupplementary: data.isSupplementary ?? (attemptNumber > 1),
                remarks:         data.remarks         ?? null,
                isBackfilled:    data.isBackfilled    ?? false,
                createdBy:       userId,
                updatedBy:       userId,
            }
        });
    },

    // Bulk recording for one student across many subjects (typical: admin enters
    // a full semester's transcript in one go). Per-row failures don't kill the
    // whole batch — the response lists outcomes per subject.
    /**
     * Bulk-record marks: one (subject, year, semester) → many students.
     * Each row goes through `recordMark`; per-row failures are collected
     * but don't abort the batch.
     */
    recordMarksBulk: async (
        studentId: string,
        academicYearId: string,
        rows: Array<{
            subjectId:        string;
            internalMarks?:   number | null;
            externalMarks?:   number | null;
            totalMarks?:      number | null;
            grade?:           string | null;
            gradePoints?:     number | null;
            status?:          SemesterMarkStatus;
            attemptNumber?:   number;
            isSupplementary?: boolean;
            remarks?:         string;
            isBackfilled?:    boolean;
        }>,
        userId: string
    ) => {
        logger.info(`[marks.recordMarksBulk] student=${studentId} year=${academicYearId} rows=${rows.length}`);

        await assertEnrollmentExists(studentId, academicYearId);

        const results: Array<{ subjectId: string; ok: boolean; markId?: string; error?: string }> = [];

        for (const r of rows) {
            try {
                const mark = await MarksService.recordMark(
                    { studentId, academicYearId, ...r },
                    userId
                );
                results.push({ subjectId: r.subjectId, ok: true, markId: mark.id });
            } catch (err: any) {
                results.push({ subjectId: r.subjectId, ok: false, error: err.message });
                logger.warn(`[marks.recordMarksBulk] subjectId=${r.subjectId} failed: ${err.message}`);
            }
        }

        const summary = results.reduce(
            (acc, r) => {
                acc.total += 1;
                acc.ok    += r.ok ? 1 : 0;
                acc.failed += r.ok ? 0 : 1;
                return acc;
            },
            { total: 0, ok: 0, failed: 0 }
        );

        return { summary, results };
    },

    /** Patch a SemesterMark row. Re-validates ceilings + recomputes grade/status on changes. */
    updateMark: async (
        id: string,
        data: Partial<{
            internalMarks:   number | null;
            externalMarks:   number | null;
            totalMarks:      number | null;
            grade:           string | null;
            gradePoints:     number | null;
            status:          SemesterMarkStatus;
            remarks:         string;
            isBackfilled:    boolean;
        }>,
        userId: string
    ) => {
        const existing = await prisma.semesterMark.findUnique({
            where: { id },
            include: { subject: { select: { maxInternalMarks: true, maxExternalMarks: true, maxTotalMarks: true } } }
        });
        if (!existing || existing.isDeleted) throw new AppError('SemesterMark not found', 404);

        // If status flips to non-PENDING, grade must be present (in the patch or existing row).
        const nextStatus = data.status ?? existing.status;
        const nextGrade  = data.grade !== undefined ? data.grade : existing.grade;
        assertGradeForStatus(nextStatus, nextGrade);

        assertMarksWithinCeiling(existing.subject, {
            internalMarks: data.internalMarks ?? existing.internalMarks,
            externalMarks: data.externalMarks ?? existing.externalMarks,
            totalMarks:    data.totalMarks    ?? existing.totalMarks,
        });

        return prisma.semesterMark.update({
            where: { id },
            data:  { ...data, updatedBy: userId }
        });
    },

    /** Soft-delete a mark row. Used to invalidate an erroneous entry; create a new attempt for the corrected value. */
    deleteMark: async (id: string, userId: string) => {
        const existing = await prisma.semesterMark.findUnique({ where: { id } });
        if (!existing || existing.isDeleted) throw new AppError('SemesterMark not found', 404);

        return prisma.semesterMark.update({
            where: { id },
            data:  { isDeleted: true, updatedBy: userId }
        });
    },

    // ────────────────────────────────────────────────────────────────────────
    // Read paths
    // ────────────────────────────────────────────────────────────────────────

    // Full transcript for a student — grouped by (academicYear, semester).
    // For supplementary attempts: returns ALL attempts; UI decides which to display.
    /**
     * All marks for one student, optionally narrowed by year or semester.
     * Includes subject metadata (code/name/credits) for the transcript view.
     */
    getStudentMarks: async (studentId: string, filters?: { academicYearId?: string; semester?: number }) => {
        const where: any = { studentId, isDeleted: false };
        if (filters?.academicYearId) where.academicYearId = filters.academicYearId;
        if (filters?.semester)       where.semester       = filters.semester;

        const marks = await prisma.semesterMark.findMany({
            where,
            orderBy: [{ semester: 'asc' }, { attemptNumber: 'asc' }],
            include: {
                subject: {
                    select: { id: true, code: true, name: true, credits: true, examType: true,
                              maxInternalMarks: true, maxExternalMarks: true, maxTotalMarks: true }
                },
                academicYear: { select: { id: true, code: true } },
            }
        });

        // Compute SGPA per semester from latest passing attempt per subject.
        const bySemester = new Map<number, typeof marks>();
        for (const m of marks) {
            if (!bySemester.has(m.semester)) bySemester.set(m.semester, []);
            bySemester.get(m.semester)!.push(m);
        }

        const semesters: Array<{
            semester: number;
            academicYearId: string;
            marks: typeof marks;
            sgpa: number | null;
            totalCredits: number;
        }> = [];

        for (const [semester, semMarks] of bySemester.entries()) {
            // Pick latest attempt per subject (highest attemptNumber wins).
            const bestPerSubject = new Map<string, typeof semMarks[number]>();
            for (const m of semMarks) {
                const cur = bestPerSubject.get(m.subjectId);
                if (!cur || (m.attemptNumber ?? 1) > (cur.attemptNumber ?? 1)) {
                    bestPerSubject.set(m.subjectId, m);
                }
            }

            let totalCredits  = 0;
            let weightedGrade = 0;
            let anyGraded     = false;

            for (const m of bestPerSubject.values()) {
                const credits = m.subject.credits ?? 0;
                if (m.gradePoints !== null && m.gradePoints !== undefined && credits > 0) {
                    totalCredits  += credits;
                    weightedGrade += credits * m.gradePoints;
                    anyGraded = true;
                }
            }

            semesters.push({
                semester,
                academicYearId: semMarks[0].academicYearId,
                marks: semMarks,
                sgpa: anyGraded && totalCredits > 0 ? Math.round((weightedGrade / totalCredits) * 100) / 100 : null,
                totalCredits,
            });
        }

        // CGPA — credit-weighted across all reported semesters.
        const allBest    = semesters.flatMap(s => {
            const m = new Map<string, typeof marks[number]>();
            for (const mk of s.marks) {
                const cur = m.get(mk.subjectId);
                if (!cur || (mk.attemptNumber ?? 1) > (cur.attemptNumber ?? 1)) m.set(mk.subjectId, mk);
            }
            return Array.from(m.values());
        });
        let cgpaCredits = 0, cgpaWeighted = 0;
        for (const m of allBest) {
            const credits = m.subject.credits ?? 0;
            if (m.gradePoints !== null && m.gradePoints !== undefined && credits > 0) {
                cgpaCredits  += credits;
                cgpaWeighted += credits * m.gradePoints;
            }
        }
        const cgpa = cgpaCredits > 0 ? Math.round((cgpaWeighted / cgpaCredits) * 100) / 100 : null;

        return { studentId, cgpa, totalCredits: cgpaCredits, semesters };
    },

    // Admin: marks roll for one (academicYear, semester) — all students.
    // Heavy query; use pagination at the UI level.
    /**
     * Class-level view: every student's mark in a specific (year, semester,
     * subject). Used by faculty to compare/distribute, and by admin to
     * compile result sheets.
     */
    getSemesterMarks: async (
        academicYearId: string,
        semester: number,
        filters?: { subjectId?: string; status?: SemesterMarkStatus; courseId?: string }
    ) => {
        const where: any = { academicYearId, semester, isDeleted: false };
        if (filters?.subjectId) where.subjectId = filters.subjectId;
        if (filters?.status)    where.status    = filters.status;
        if (filters?.courseId) {
            where.subject = { courseId: filters.courseId };
        }

        return prisma.semesterMark.findMany({
            where,
            orderBy: [{ subjectId: 'asc' }, { studentId: 'asc' }, { attemptNumber: 'asc' }],
            include: {
                student: { select: { id: true, name: true, applicationId: true, phone: true } },
                subject: { select: { id: true, code: true, name: true, credits: true } },
            }
        });
    },
};
