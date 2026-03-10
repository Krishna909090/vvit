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
    async createCourse(name: string, code: string, departmentId: string, degree?: string, totalSeats?: number, createdBy?: string, omrId?: number) {
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
            const omrIdConflict = await prisma.course.findFirst({
                where: { omrId, isDeleted: false }
            });
            if (omrIdConflict) {
                throw new AppError("A course with this OMR ID already exists", 409);
            }
        }

        return await prisma.course.create({
            data: {
                name,
                code,
                departmentId,
                degree,
                totalSeats: totalSeats !== undefined ? Number(totalSeats) : 0,
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
            include: { department: true, specializations: true }
        });
        return courses.map((c: any) => ({
            ...c,
            departmentName: c.department?.name,
            department: undefined
        }));
    },

    async getDegrees() {
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
            include: { department: true, specializations: true }
        });
        if (!course) throw new AppError("Course not found", 404);
        return course;
    },

    async updateCourse(id: string, name: string, code: string, departmentId: string, totalSeats: number | undefined, updatedBy?: string, omrId?: number) {
        const course = await prisma.course.findUnique({ where: { id } });
        if (!course) throw new AppError("Course not found", 404);

        if (
            (name === undefined || course.name === name) &&
            (code === undefined || course.code === code) &&
            (departmentId === undefined || course.departmentId === departmentId) &&
            (totalSeats === undefined || course.totalSeats === totalSeats) &&
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
            const omrIdConflict = await prisma.course.findFirst({
                where: { omrId, id: { not: id }, isDeleted: false }
            });
            if (omrIdConflict) {
                throw new AppError("A course with this OMR ID already exists", 409);
            }
        }

        const updateData: any = { name, code, departmentId, updatedBy };
        if (totalSeats !== undefined) updateData.totalSeats = totalSeats;
        if (omrId !== undefined) updateData.omrId = omrId;

        return await prisma.course.update({
            where: { id },
            data: updateData
        });
    },

    async deleteCourse(id: string) {
        const course = await prisma.course.findUnique({ where: { id } });
        if (!course) throw new AppError("Course not found", 404);

        return await prisma.course.update({ where: { id }, data: { isDeleted: true } });
    },

    // Specialization
    async createSpecialization(code: string, name: string, totalSeats: number, courseId: string, createdBy?: string) {
        if (!code || !name || !totalSeats || !courseId) throw new AppError(MESSAGES.ERROR.CODE_NAME_SEATS_REQUIRED, 400);

        const course = await prisma.course.findUnique({ where: { id: courseId } });
        if (!course) {
            throw new AppError("Course (Specialization Parent) not found", 404);
        }

        const existingSpecialization = await prisma.specialization.findFirst({ where: { code, isDeleted: false } });
        if (existingSpecialization) {
            throw new AppError("Specialization code exists", 409);
        }

        return await prisma.specialization.create({
            data: {
                code,
                name,
                courseId,
                totalSeats: Number(totalSeats),
                filledSeats: 0,
                createdBy
            }
        });
    },

    async getSpecializations() {
        const specs = await prisma.specialization.findMany({
            where: { isDeleted: false },
            include: { course: true }
        });
        return specs.map(s => ({
            ...s,
            courseName: s.course.name,
            course: undefined
        }));
    },

    async getSpecializationById(id: string) {
        const specialization = await prisma.specialization.findUnique({
            where: { id },
            include: { course: { include: { department: true } } }
        });
        if (!specialization) throw new AppError("Specialization not found", 404);
        return specialization;
    },

    async updateSpecialization(id: string, code: string, name: string, totalSeats: number, updatedBy?: string) {
        const specialization = await prisma.specialization.findUnique({ where: { id } });
        if (!specialization) throw new AppError("Specialization not found", 404);

        const newCode = code !== undefined ? code : specialization.code;
        const newName = name !== undefined ? name : specialization.name;
        const newTotalSeats = totalSeats !== undefined ? Number(totalSeats) : specialization.totalSeats;

        if (
            specialization.code === newCode && 
            specialization.name === newName && 
            specialization.totalSeats === newTotalSeats
        ) {
            throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
        }

        return await prisma.specialization.update({
            where: { id },
            data: { 
                code: newCode, 
                name: newName, 
                totalSeats: newTotalSeats, 
                updatedBy 
            }
        });
    },

    async deleteSpecialization(id: string) {
        const specialization = await prisma.specialization.findUnique({ where: { id } });
        if (!specialization) throw new AppError("Specialization not found", 404);

        return await prisma.specialization.update({ where: { id }, data: { isDeleted: true } });
    },

    async getSeatStatus() {
        const specializations = await prisma.specialization.findMany({
            where: { isDeleted: false },
            include: {
                course: {
                    include: { department: true }
                }
            },
            orderBy: {
                course: {
                    name: 'asc'
                }
            }
        });

        const statusPromises = specializations.map(async (spec) => {
            const actualCount = await prisma.studentAdmission.count({
                where: {
                    allottedCourseId: spec.courseId, // Approximate: Count all students in the course as we don't track specialization-level seats in StudentAdmission anymore
                    status: {
                        in: [
                            AdmissionStatus.SEAT_ALLOTTED, 
                            AdmissionStatus.ADMISSION_CONFIRMED, 
                            AdmissionStatus.ENROLLED
                        ]
                    }
                }
            });

            return {
                id: spec.id,
                code: spec.code,
                name: spec.name,
                courseName: spec.course.name,
                departmentName: spec.course.department.name,
                totalSeats: spec.totalSeats,
                filledSeats: spec.filledSeats, // Count from Specialization table cache
                availableSeats: spec.totalSeats - (spec.filledSeats ?? 0),
                actualFilledCount: actualCount, // Count from StudentAdmission table (Truth)
                isSync: spec.filledSeats === actualCount, // Verification
                discrepancy: (spec.filledSeats ?? 0) - actualCount
            };
        });

        const results = await Promise.all(statusPromises);
        
        // Group by Course for cleaner output
        const grouped = results.reduce((acc: any, curr) => {
            const courseKey = `${curr.courseName} (${curr.departmentName})`;
            if (!acc[courseKey]) {
                acc[courseKey] = {
                    course: curr.courseName,
                    department: curr.departmentName,
                    specializations: []
                };
            }
            acc[courseKey].specializations.push({
                specialization: curr.name,
                code: curr.code,
                totalSeats: curr.totalSeats,
                filled: curr.filledSeats,
                available: curr.availableSeats,
                actualFilled: curr.actualFilledCount, // The "deducting correctly" check
                isSync: curr.isSync
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

        return await prisma.academicYear.create({
            data: {
                code,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                isActive: isActive !== undefined ? isActive : true,
                createdBy
            }
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

    async deleteAcademicYear(id: string) {
        const academicYear = await prisma.academicYear.findUnique({ where: { id } });
        if (!academicYear) throw new AppError(MESSAGES.ERROR.ACADEMIC_YEAR_NOT_FOUND, 404);

        return await prisma.academicYear.update({ where: { id }, data: { isDeleted: true } });
    },

    // Batch
    async createBatch(name: string, specializationId: string, startDate: string, endDate: string, createdBy?: string) {
        // Validate Specialization Exists
        const specialization = await prisma.specialization.findUnique({ where: { id: specializationId } });
        if (!specialization) {
            throw new AppError("Specialization not found", 404);
        }

        const existingBatch = await prisma.batch.findFirst({
            where: {
                name: { equals: name, mode: 'insensitive' },
                specializationId,
                isDeleted: false
            }
        });

        if (existingBatch) {
            throw new AppError(MESSAGES.ERROR.BATCH_EXISTS, 409);
        }

        return await prisma.batch.create({
            data: {
                name,
                specializationId,
                courseId: specialization.courseId,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                createdBy
            }
        });
    },

    async getBatches(specializationId?: string) {
        const where: any = { isDeleted: false };
        if (specializationId) where.specializationId = String(specializationId);

        return await prisma.batch.findMany({
            where,
            include: { specialization: true },
            orderBy: { startDate: 'desc' }
        });
    },

    async getBatchById(id: string) {
        const batch = await prisma.batch.findUnique({
            where: { id },
            include: { specialization: true }
        });
        if (!batch) throw new AppError(MESSAGES.ERROR.BATCH_NOT_FOUND, 404);
        return batch;
    },

    async updateBatch(id: string, name: string, specializationId: string, startDate: string, endDate: string, updatedBy?: string) {
        const batch = await prisma.batch.findUnique({ where: { id } });
        if (!batch) throw new AppError(MESSAGES.ERROR.BATCH_NOT_FOUND, 404);

        const data: any = { name, specializationId, updatedBy };
        if (startDate) data.startDate = new Date(startDate);
        if (endDate) data.endDate = new Date(endDate);

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
            include: { batch: true }
        });
    },

    async getSectionById(id: string) {
        const section = await prisma.section.findUnique({
            where: { id },
            include: { batch: true }
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
