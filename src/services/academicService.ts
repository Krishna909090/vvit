import prisma from '../config/prisma';
import { AppError } from '../utils/AppError';
import { MESSAGES } from '../constants/messages';

export const AcademicService = {
    // Department
    async createDepartment(name: string, code: string, createdBy?: string) {
        const existingDept = await prisma.department.findFirst({
            where: {
                OR: [
                    { code: { equals: code, mode: 'insensitive' } },
                    { name: { equals: name, mode: 'insensitive' } }
                ]
            }
        });

        if (existingDept) {
            throw new AppError(MESSAGES.ERROR.DEPARTMENT_EXISTS, 409);
        }

        return await prisma.department.create({
            data: { name, code, createdBy }
        });
    },

    async getDepartments() {
        return await prisma.department.findMany({ include: { courses: true } });
    },

    async getDepartmentById(id: string) {
        const department = await prisma.department.findUnique({
            where: { id },
            include: { courses: true }
        });
        if (!department) throw new AppError(MESSAGES.ERROR.DEPARTMENT_NOT_FOUND, 404);
        return department;
    },

    async updateDepartment(id: string, name: string, code: string, updatedBy?: string) {
        const department = await prisma.department.findUnique({ where: { id } });
        if (!department) throw new AppError(MESSAGES.ERROR.DEPARTMENT_NOT_FOUND, 404);

        if (department.name === name && department.code === code) {
            throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
        }

        return await prisma.department.update({
            where: { id },
            data: { name, code, updatedBy }
        });
    },

    async deleteDepartment(id: string) {
        const department = await prisma.department.findUnique({ where: { id } });
        if (!department) throw new AppError(MESSAGES.ERROR.DEPARTMENT_NOT_FOUND, 404);

        return await prisma.department.update({ where: { id }, data: { isDeleted: true } });
    },

    // Course
    async createCourse(name: string, code: string, departmentId: string, createdBy?: string) {
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
                ]
            }
        });

        if (existingCourse) {
            throw new AppError("Course with this name or code already exists", 409);
        }

        return await prisma.course.create({
            data: { name, code, departmentId, createdBy }
        });
    },

    async getCourses(departmentId?: string) {
        const where: any = {};
        if (departmentId) {
            where.departmentId = String(departmentId);
        }
        return await prisma.course.findMany({
            where,
            include: { department: true, specializations: true, batches: true }
        });
    },

    async getCourseById(id: string) {
        const course = await prisma.course.findUnique({
            where: { id },
            include: { department: true, specializations: true, batches: true }
        });
        if (!course) throw new AppError("Course not found", 404);
        return course;
    },

    async updateCourse(id: string, name: string, departmentId: string, updatedBy?: string) {
        const course = await prisma.course.findUnique({ where: { id } });
        if (!course) throw new AppError("Course not found", 404);

        if (course.name === name && course.departmentId === departmentId) {
            throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
        }

        return await prisma.course.update({
            where: { id },
            data: { name, departmentId, updatedBy }
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

        const existingSpecialization = await prisma.specialization.findUnique({ where: { code } });
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
        return await prisma.specialization.findMany({
            include: { course: true }
        });
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

        if (specialization.code === code && specialization.name === name && specialization.totalSeats === Number(totalSeats)) {
            throw new AppError(MESSAGES.ERROR.NO_CHANGES_DETECTED, 400);
        }

        return await prisma.specialization.update({
            where: { id },
            data: { code, name, totalSeats: Number(totalSeats), updatedBy }
        });
    },

    async deleteSpecialization(id: string) {
        const specialization = await prisma.specialization.findUnique({ where: { id } });
        if (!specialization) throw new AppError("Specialization not found", 404);

        return await prisma.specialization.update({ where: { id }, data: { isDeleted: true } });
    },

    // Academic Year
    async createAcademicYear(code: string, startDate: string, endDate: string, isActive: boolean, createdBy?: string) {
        const existingYear = await prisma.academicYear.findUnique({ where: { code } });
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
        return await prisma.academicYear.findMany({ orderBy: { startDate: 'desc' } });
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
    async createBatch(name: string, courseId: string, startDate: string, endDate: string, createdBy?: string) {
        const existingBatch = await prisma.batch.findFirst({
            where: {
                name: { equals: name, mode: 'insensitive' },
                courseId
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
        const where: any = {};
        if (courseId) where.courseId = String(courseId);

        return await prisma.batch.findMany({
            where,
            include: { course: true },
            orderBy: { startDate: 'desc' }
        });
    },

    async updateBatch(id: string, name: string, courseId: string, startDate: string, endDate: string, updatedBy?: string) {
        const batch = await prisma.batch.findUnique({ where: { id } });
        if (!batch) throw new AppError(MESSAGES.ERROR.BATCH_NOT_FOUND, 404);

        const data: any = { name, courseId, updatedBy };
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
        const existingSection = await prisma.section.findFirst({
            where: {
                name: { equals: name, mode: 'insensitive' },
                batchId
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
        const where: any = {};
        if (batchId) where.batchId = String(batchId);

        return await prisma.section.findMany({
            where,
            include: { batch: true }
        });
    },

    async updateSection(id: string, name: string, batchId: string, updatedBy?: string) {
        const section = await prisma.section.findUnique({ where: { id } });
        if (!section) throw new AppError(MESSAGES.ERROR.SECTION_NOT_FOUND, 404);

        return await prisma.section.update({
            where: { id },
            data: { name, batchId, updatedBy }
        });
    },

    async deleteSection(id: string) {
        const section = await prisma.section.findUnique({ where: { id } });
        if (!section) throw new AppError(MESSAGES.ERROR.SECTION_NOT_FOUND, 404);

        return await prisma.section.update({ where: { id }, data: { isDeleted: true } });
    }
};
