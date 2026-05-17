import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import { AdmissionStatus } from '@prisma/client';

export const AcademicService = {
    // School
    async createSchool(name: string, code: string, createdBy?: string) {
        const existingSchool = await prisma.school.findFirst({
            where: {
                OR: [
                    { code: { equals: code, mode: 'insensitive' } },
                    { name: { equals: name, mode: 'insensitive' } }
                ],
                isDeleted: false
            }
        });

        if (existingSchool) {
            throw new AppError("School with this name or code already exists", 409);
        }

        return await prisma.school.create({
            data: { name, code, createdBy }
        });
    },

    async getSchools() {
        return await prisma.school.findMany({
            where: { isDeleted: false },
            include: { departments: {
                where: { isDeleted: false }
            } }
        });
    },

    async getSchoolById(id: string) {
        const school = await prisma.school.findUnique({
            where: { id },
            include: { departments: true }
        });
        if (!school) throw new AppError("School not found", 404);
        return school;
    },

    async updateSchool(id: string, name: string, code: string, updatedBy?: string) {
        const school = await prisma.school.findUnique({ where: { id } });
        if (!school) throw new AppError("School not found", 404);

        return await prisma.school.update({
            where: { id },
            data: { name, code, updatedBy }
        });
    },

    async deleteSchool(id: string) {
        const school = await prisma.school.findUnique({ where: { id } });
        if (!school) throw new AppError("School not found", 404);

        return await prisma.school.update({ where: { id }, data: { isDeleted: true } });
    },

    // Department
    async createDepartment(name: string, code: string, schoolId?: string, createdBy?: string) {
        // Validate School if provided
        if (schoolId) {
            const school = await prisma.school.findUnique({ where: { id: schoolId } });
            if (!school) {
                throw new AppError("School not found", 404);
            }
        }

        const existingDept = await prisma.department.findFirst({
            where: {
                OR: [
                    { code: { equals: code, mode: 'insensitive' } },
                    { name: { equals: name, mode: 'insensitive' } }
                ],
                isDeleted: false
            }
        });

        if (existingDept) {
            throw new AppError(MESSAGES.ERROR.DEPARTMENT_EXISTS, 409);
        }

        return await prisma.department.create({
            data: { name, code, schoolId, createdBy }
        });
    },

    async getDepartments(search?: string) {
        const where: any = { isDeleted: false };
        
        if (search) {
             where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } }
             ];
        }

        const depts = await prisma.department.findMany({
            where,
            include: {
                courses: { where: { isDeleted: false } },
                school: true
            }
        });
        return depts.map(d => ({
            ...d,
            schoolName: d.school?.name,
            schoolCode: d.school?.code,
            schoolId: d.school?.id
        }));
    },

    async getDepartmentById(id: string) {
        const department = await prisma.department.findUnique({
            where: { id },
            include: { courses: true }
        });
        if (!department) throw new AppError(MESSAGES.ERROR.DEPARTMENT_NOT_FOUND, 404);
        return department;
    },

    async updateDepartment(id: string, name: string, code: string, schoolId?: string, updatedBy?: string) {
        const department = await prisma.department.findUnique({ where: { id } });
        if (!department) throw new AppError(MESSAGES.ERROR.DEPARTMENT_NOT_FOUND, 404);

        const newSchoolId = schoolId !== undefined ? schoolId : department.schoolId;

        if (department.name === name && department.code === code && department.schoolId === newSchoolId) {
            throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
        }

        // Validate School if changing
        if (schoolId && schoolId !== department.schoolId) {
            const school = await prisma.school.findUnique({ where: { id: schoolId } });
            if (!school) throw new AppError("School not found", 404);
        }

        return await prisma.department.update({
            where: { id },
            data: { name, code, schoolId: newSchoolId, updatedBy }
        });
    },

    async deleteDepartment(id: string) {
        const department = await prisma.department.findUnique({ where: { id } });
        if (!department) throw new AppError(MESSAGES.ERROR.DEPARTMENT_NOT_FOUND, 404);

        return await prisma.department.update({ where: { id }, data: { isDeleted: true } });
    },

    // Course
    async createCourse(name: string, code: string, departmentId: string, degree?: string, createdBy?: string, omrId?: number) {
        const department = await prisma.department.findUnique({ where: { id: departmentId } });
        if (!department) {
            throw new AppError(MESSAGES.ERROR.DEPARTMENT_NOT_FOUND, 404);
        }

        const existingCourse = await prisma.course.findFirst({
            where: {
                OR: [
                    {
                        name: { equals: name, mode: 'insensitive' },
                        departmentId
                    },
                    {
                        code: { equals: code, mode: 'insensitive' }
                    }
                ],
                isDeleted: false
            }
        });

        if (existingCourse) {
            throw new AppError("Course with this name or code already exists", 409);
        }

        if (omrId !== undefined && omrId !== null) {
            // No isDeleted filter — OMR IDs are unique across ALL courses (the DB
            // unique index spans soft-deleted rows too). A physical OMR scan-sheet
            // ID must never be reused, even after a course is removed.
            const omrIdConflict = await prisma.course.findFirst({
                where: { omrId }
            });
            if (omrIdConflict) {
                throw new AppError(
                    `OMR ID ${omrId} is already assigned to course "${omrIdConflict.name}"`,
                    409
                );
            }
        }

        return await prisma.course.create({
            data: {
                name,
                code,
                departmentId,
                degree,
                omrId,
                createdBy
            }
        });
    },

    async getCourses(departmentId?: string, degree?: string, search?: string) {
        const where: any = { isDeleted: false };
        if (departmentId) {
            where.departmentId = String(departmentId);
        }
        if (degree) {
            where.degree = String(degree);
        }
        if (search) {
             where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } }
             ];
        }

        const courses = await prisma.course.findMany({
            where,
            include: { department: true }
        });
        return courses.map((c: any) => ({
            ...c,
            departmentName: c.department?.name,
            department: undefined
        }));
    },

    async  getDegrees() {
        const result = await prisma.course.findMany({
            select: { degree: true },
            distinct: ['degree'],
            where: {
                degree: { not: null }
            }
        });
        
        // Filter out nulls and return array of strings
        return result
            .map(r => r.degree)
            .filter((d): d is string => d !== null);
    },

    async getCourseById(id: string) {
        const course = await prisma.course.findUnique({
            where: { id },
            include: { department: true }
        });
        if (!course) throw new AppError("Course not found", 404);
        return course;
    },

    async updateCourse(id: string, name: string, code: string, departmentId: string, updatedBy?: string, omrId?: number) {
        const course = await prisma.course.findUnique({ where: { id } });
        if (!course) throw new AppError("Course not found", 404);

        if (
            (name === undefined || course.name === name) &&
            (code === undefined || course.code === code) &&
            (departmentId === undefined || course.departmentId === departmentId) &&
            (omrId === undefined || course.omrId === omrId)
        ) {
            throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
        }

        // Check for code uniqueness if code is being changed
        if (code && code !== course.code) {
           const existingCourse = await prisma.course.findFirst({
                where: {
                    code: { equals: code, mode: 'insensitive' },
                    id: { not: id },
                    isDeleted: false
                }
            });
            if (existingCourse) {
                 throw new AppError("Course code already exists", 409);
            }
        }

        if (omrId !== undefined && omrId !== null && omrId !== course.omrId) {
            // No isDeleted filter — matches the DB-level unique index, which spans
            // soft-deleted courses. OMR scan-sheet IDs are never reused.
            const omrIdConflict = await prisma.course.findFirst({
                where: { omrId, id: { not: id } }
            });
            if (omrIdConflict) {
                throw new AppError(
                    `OMR ID ${omrId} is already assigned to course "${omrIdConflict.name}"`,
                    409
                );
            }
        }

        const updateData: any = { name, code, departmentId, updatedBy };
        if (omrId !== undefined) updateData.omrId = omrId;

        return await prisma.course.update({
            where: { id },
            data: updateData
        });
    },

    /**
     * Soft-delete a course — guarded.
     *
     * Refused if any student is allotted this course (StudentAdmission.allottedCourseId).
     * Deleting a course with allotted students would orphan their admission records
     * and break course-scoped reports.
     */
    async deleteCourse(id: string, adminId?: string) {
        const course = await prisma.course.findUnique({ where: { id } });
        if (!course) throw new AppError("Course not found", 404);
        if (course.isDeleted) throw new AppError("Course is already deleted", 400);

        const allotted = await prisma.studentAdmission.count({
            where: { allottedCourseId: id },
        });
        if (allotted > 0) {
            throw new AppError(
                `Cannot delete course "${course.name}" — ${allotted} student(s) are allotted to it. ` +
                `Reassign them to another course first.`,
                409
            );
        }

        return await prisma.course.update({
            where: { id },
            data: { isDeleted: true, updatedBy: adminId },
        });
    },

    async getSeatStatus(academicYearId?: string) {
        // Resolve target year (default = active)
        const targetYear = academicYearId
            ? await prisma.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true, code: true } })
            : await prisma.academicYear.findFirst({ where: { isActive: true, isDeleted: false }, select: { id: true, code: true } });
        if (!targetYear) throw new AppError('No active academic year found', 404);

        const capacities = await prisma.courseCapacity.findMany({
            where: { academicYearId: targetYear.id },
            include: {
                course: { include: { department: true } },
            },
        });

        const statusPromises = capacities.map(async (cap) => {
            const actualCount = await prisma.studentAdmission.count({
                where: {
                    allottedCourseId: cap.courseId,
                    academicYearId:   cap.academicYearId,
                    status: {
                        in: [
                            AdmissionStatus.SEAT_ALLOTTED,
                            AdmissionStatus.ADMISSION_CONFIRMED,
                            AdmissionStatus.ENROLLED,
                        ],
                    },
                },
            });
            return {
                courseId:       cap.courseId,
                courseName:     cap.course.name,
                courseCode:     cap.course.code,
                departmentName: cap.course.department.name,
                academicYear:   targetYear.code,
                totalSeats:     cap.totalSeats,
                filledSeats:    cap.filledSeats,
                availableSeats: Math.max(0, cap.totalSeats - cap.filledSeats),
                actualFilledCount: actualCount,
                isSync:         cap.filledSeats === actualCount,
                discrepancy:    cap.filledSeats - actualCount,
            };
        });

        const rows = await Promise.all(statusPromises);

        const grouped = rows.reduce((acc: any, r) => {
            const key = `${r.courseName} (${r.departmentName})`;
            if (!acc[key]) {
                acc[key] = {
                    course:     r.courseName,
                    department: r.departmentName,
                    academicYear: r.academicYear,
                    capacity:   [],
                };
            }
            acc[key].capacity.push({
                totalSeats:    r.totalSeats,
                filled:        r.filledSeats,
                available:     r.availableSeats,
                actualFilled:  r.actualFilledCount,
                isSync:        r.isSync,
            });
            return acc;
        }, {});

        return Object.values(grouped);
    },

    // Academic Year
    async createAcademicYear(code: string, startDate: string, endDate: string, isActive: boolean, createdBy?: string) {
        const existingYear = await prisma.academicYear.findFirst({ where: { code, isDeleted: false } });
        if (existingYear) {
            throw new AppError(MESSAGES.ERROR.ACADEMIC_YEAR_EXISTS, 409);
        }

        const shouldActivate = isActive !== undefined ? isActive : true;

        return await prisma.$transaction(async (tx) => {
            if (shouldActivate) {
                await tx.academicYear.updateMany({
                    where: { isActive: true },
                    data: { isActive: false }
                });
            }

            return tx.academicYear.create({
                data: {
                    code,
                    startDate: new Date(startDate),
                    endDate: new Date(endDate),
                    isActive: shouldActivate,
                    createdBy
                }
            });
        });
    },

    async getAcademicYears() {
        return await prisma.academicYear.findMany({ 
            where: { isDeleted: false },
            orderBy: { startDate: 'desc' } 
        });
    },

    async updateAcademicYear(id: string, data: any, updatedBy?: string) {
        const academicYear = await prisma.academicYear.findUnique({ where: { id } });
        if (!academicYear) throw new AppError(MESSAGES.ERROR.ACADEMIC_YEAR_NOT_FOUND, 404);

        const updateData: any = { code: data.code, updatedBy };
        if (data.startDate) updateData.startDate = new Date(data.startDate);
        if (data.endDate) updateData.endDate = new Date(data.endDate);
        if (data.isActive !== undefined) updateData.isActive = data.isActive;

        return await prisma.academicYear.update({
            where: { id },
            data: updateData
        });
    },

    /**
     * Soft-delete an academic year — heavily guarded.
     *
     * An AcademicYear is referenced by ~19 tables (admissions, enrollments, fee
     * demands, payments, ledger, corrections, pricing, capacities, marks,
     * attendance, ...). Deleting a year that has real data would orphan all of it
     * and corrupt every year-scoped report and metric. So this is allowed ONLY when:
     *   - the year is not already deleted
     *   - the year is not the active year
     *   - the year is not locked (a locked year is a closed financial period)
     *   - the year has ZERO student data (admissions / enrollments / demands /
     *     payments / ledger / corrections / marks / attendance / allocations)
     *
     * Config-only leftovers (FeeStructure / HostelPriceCategory / TransportRouteYearlyPrice
     * / CourseCapacity) do NOT block deletion — a year that was set up but never
     * admitted into is safe to remove. Those rows are filtered out of every picker
     * by the year's isDeleted flag.
     */
    async deleteAcademicYear(id: string, adminId?: string) {
        const academicYear = await prisma.academicYear.findUnique({ where: { id } });
        if (!academicYear) throw new AppError(MESSAGES.ERROR.ACADEMIC_YEAR_NOT_FOUND, 404);
        if (academicYear.isDeleted) throw new AppError('Academic year is already deleted', 400);

        // The active year is the system's current context — never deletable.
        if (academicYear.isActive) {
            throw new AppError(
                `Cannot delete the active academic year "${academicYear.code}". Mark another year active first.`,
                409
            );
        }
        // A locked year is a closed financial period — its books are sealed.
        if (academicYear.isLocked) {
            throw new AppError(
                `Cannot delete locked academic year "${academicYear.code}" — it is a closed financial period.`,
                423
            );
        }

        // Count every student-data dependent. ANY non-zero count blocks deletion.
        const [
            admissions, admissionsEntry, enrollments, demands, payments,
            ledger, corrections, marks, attendance,
            hostelAllocations, transportAllocations, scholarships, studentDocuments,
        ] = await Promise.all([
            prisma.studentAdmission.count({ where: { academicYearId: id } }),
            prisma.studentAdmission.count({ where: { entryAcademicYearId: id } }),
            prisma.studentEnrollment.count({ where: { academicYearId: id } }),
            prisma.studentFeeDemand.count({ where: { academicYearId: id } }),
            prisma.payment.count({ where: { academicYearId: id } }),
            prisma.studentLedger.count({ where: { academicYearId: id } }),
            (prisma as any).feeCorrection.count({ where: { academicYearId: id } }),
            (prisma as any).semesterMark.count({ where: { academicYearId: id } }),
            (prisma as any).classAttendance.count({ where: { academicYearId: id } }),
            (prisma as any).hostelAllocation.count({ where: { academicYearId: id } }),
            (prisma as any).transportAllocation.count({ where: { academicYearId: id } }),
            (prisma as any).studentScholarship.count({ where: { academicYearId: id } }),
            (prisma as any).studentDocument.count({ where: { academicYearId: id } }),
        ]);

        const blockers: string[] = [];
        if (admissions)           blockers.push(`${admissions} admission(s)`);
        if (admissionsEntry)      blockers.push(`${admissionsEntry} entry-year admission(s)`);
        if (enrollments)          blockers.push(`${enrollments} enrollment(s)`);
        if (demands)              blockers.push(`${demands} fee demand(s)`);
        if (payments)             blockers.push(`${payments} payment(s)`);
        if (ledger)               blockers.push(`${ledger} ledger entr(ies)`);
        if (corrections)          blockers.push(`${corrections} fee correction(s)`);
        if (marks)                blockers.push(`${marks} semester mark(s)`);
        if (attendance)           blockers.push(`${attendance} attendance record(s)`);
        if (hostelAllocations)    blockers.push(`${hostelAllocations} hostel allocation(s)`);
        if (transportAllocations) blockers.push(`${transportAllocations} transport allocation(s)`);
        if (scholarships)         blockers.push(`${scholarships} scholarship(s)`);
        if (studentDocuments)     blockers.push(`${studentDocuments} student document(s)`);

        if (blockers.length > 0) {
            throw new AppError(
                `Cannot delete academic year "${academicYear.code}" — it has real data: ` +
                blockers.join(', ') + '. Deleting would orphan these records and corrupt ' +
                'year-scoped reports, payments and metrics. If the year is over, ' +
                'lock it (isLocked=true) instead of deleting.',
                409
            );
        }

        return await prisma.academicYear.update({
            where: { id },
            data: { isDeleted: true, updatedBy: adminId },
        });
    },

    // Batch — keyed by Course (cohort container)
    async createBatch(
        name: string,
        courseId: string,
        startDate: string,
        endDate: string,
        createdBy?: string,
    ) {
        if (!courseId) {
            throw new AppError("courseId is required", 400);
        }

        const course = await prisma.course.findUnique({ where: { id: courseId } });
        if (!course || course.isDeleted) {
            throw new AppError("Course not found", 404);
        }

        const existingBatch = await prisma.batch.findFirst({
            where: {
                name: { equals: name, mode: 'insensitive' },
                courseId,
                isDeleted: false
            }
        });

        if (existingBatch) {
            throw new AppError(MESSAGES.ERROR.BATCH_EXISTS, 409);
        }

        return await prisma.batch.create({
            data: {
                name,
                courseId,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                createdBy
            }
        });
    },

    async getBatches(courseId?: string) {
        const where: any = { isDeleted: false };
        if (courseId) where.courseId = String(courseId);

        return await prisma.batch.findMany({
            where,
            include: {
                course: { select: { id: true, code: true, name: true, degree: true } },
            },
            orderBy: { startDate: 'desc' }
        });
    },

    async getBatchById(id: string) {
        const batch = await prisma.batch.findUnique({
            where: { id },
            include: {
                course: { select: { id: true, code: true, name: true, degree: true } },
            },
        });
        if (!batch) throw new AppError(MESSAGES.ERROR.BATCH_NOT_FOUND, 404);
        return batch;
    },

    async updateBatch(id: string, name: string, courseId: string | undefined, startDate: string, endDate: string, updatedBy?: string) {
        const batch = await prisma.batch.findUnique({ where: { id } });
        if (!batch) throw new AppError(MESSAGES.ERROR.BATCH_NOT_FOUND, 404);

        const data: any = { name, updatedBy };
        if (courseId)  data.courseId  = courseId;
        if (startDate) data.startDate = new Date(startDate);
        if (endDate)   data.endDate   = new Date(endDate);

        return await prisma.batch.update({
            where: { id },
            data
        });
    },

    async deleteBatch(id: string) {
        const batch = await prisma.batch.findUnique({ where: { id } });
        if (!batch) throw new AppError(MESSAGES.ERROR.BATCH_NOT_FOUND, 404);

        return await prisma.batch.update({ where: { id }, data: { isDeleted: true } });
    },

    // Section
    async createSection(name: string, batchId: string, createdBy?: string) {
        // Validate Batch Exists
        const batch = await prisma.batch.findUnique({ where: { id: batchId } });
        if (!batch) {
            throw new AppError("Batch not found", 404);
        }

        const existingSection = await prisma.section.findFirst({
            where: {
                name: { equals: name, mode: 'insensitive' },
                batchId,
                isDeleted: false
            }
        });

        if (existingSection) {
            throw new AppError(MESSAGES.ERROR.SECTION_EXISTS, 409);
        }

        return await prisma.section.create({
            data: { name, batchId, createdBy }
        });
    },

    async getSections(batchId?: string) {
        const where: any = { isDeleted: false };
        if (batchId) where.batchId = String(batchId);

        return await prisma.section.findMany({
            where,
            include: {
                batch: {
                    include: {
                        course: { select: { id: true, code: true, name: true, degree: true } },
                    },
                },
            },
        });
    },

    async getSectionById(id: string) {
        const section = await prisma.section.findUnique({
            where: { id },
            include: {
                batch: {
                    include: {
                        course: { select: { id: true, code: true, name: true, degree: true } },
                    },
                },
            },
        });
        if (!section) throw new AppError(MESSAGES.ERROR.SECTION_NOT_FOUND, 404);
        return section;
    },

    async updateSection(id: string, name: string, batchId: string, updatedBy?: string) {
        const section = await prisma.section.findUnique({ where: { id } });
        if (!section) throw new AppError(MESSAGES.ERROR.SECTION_NOT_FOUND, 404);

        const newName = name !== undefined ? name : section.name;
        const newBatchId = batchId !== undefined ? batchId : section.batchId;

        if (section.name === newName && section.batchId === newBatchId) {
             throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
        }

        // Validate Batch if changing
        if (batchId && batchId !== section.batchId) {
             const batch = await prisma.batch.findUnique({ where: { id: batchId } });
             if (!batch) throw new AppError("Batch not found", 404);
        }

        return await prisma.section.update({
            where: { id },
            data: { 
                name: newName, 
                batchId: newBatchId, 
                updatedBy 
            }
        });
    },

    async deleteSection(id: string) {
        const section = await prisma.section.findUnique({ where: { id } });
        if (!section) throw new AppError(MESSAGES.ERROR.SECTION_NOT_FOUND, 404);

        return await prisma.section.update({ where: { id }, data: { isDeleted: true } });
    }
};
