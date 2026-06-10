

import prisma from '../../../config/prisma';
import { AdmissionStatus, AdmissionEntryType, WaitingListStatus, WaitingListCategory, PaymentStatus, PaymentComponent, AccommodationType, HostelType, HostelPaymentMode } from '@prisma/client';
import { AccommodationService } from './accommodation';
import { generateAndSaveAllotmentOrder } from '../../finance/payment.service';
import { convertToPresignedUrl } from '../../../utils/s3Utils';
import ExcelJS from 'exceljs';
import logger from '../../../utils/logger';
import { AppError } from '../../../utils/AppError';
import {
    getActiveAcademicYear,
} from '../../../utils/studentContext';
import {
    getCourseCapacity,
    tryAtomicIncrementCourseCapacity,
} from '../../../utils/courseCapacity';
import { FeeService } from '../../finance/fee.service';

export const WaitingListService = {

    async addToWaitingList(data: { studentId: string; courseId: string; category: WaitingListCategory; remarks?: string }, adminId: string) {
        const { studentId, courseId, category, remarks } = data;

        if (!studentId) throw new AppError('Student ID is required', 400);
        if (!courseId) throw new AppError('Course ID is required', 400);
        if (!category) throw new AppError('Category is required', 400);
        if (!Object.values(WaitingListCategory).includes(category)) {
            throw new AppError(`Invalid category. Allowed: ${Object.values(WaitingListCategory).join(', ')}`, 400);
        }

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            select: {
                id: true, name: true, applicationId: true,
                pref1: true, pref2: true, pref3: true,
                admissionDetails: { select: { entryType: true, entryYearOfStudy: true } },
            }
        });
        if (!student) throw new AppError('Student not found', 404);

        const preferences = [student.pref1, student.pref2, student.pref3].filter(Boolean) as string[];
        if (preferences.length === 0) {
            throw new AppError('Student has no course preferences (pref1/pref2/pref3) set; cannot waitlist', 400);
        }
        if (!preferences.includes(courseId)) {
            throw new AppError('Course must be one of the student\'s opted preferences (pref1, pref2 or pref3)', 400);
        }

        const adm = student.admissionDetails;
        if (!adm) throw new AppError('Student has no admission record; cannot waitlist', 400);
        const entryType = adm.entryType ?? AdmissionEntryType.REGULAR;
        const yearOfStudy = adm.entryYearOfStudy ?? 1;
        if (entryType !== AdmissionEntryType.REGULAR || yearOfStudy !== 1) {
            throw new AppError('Only first-year (REGULAR entry) students can be added to the waiting list', 400);
        }

        const course = await prisma.course.findFirst({
            where: { id: courseId, isDeleted: false },
            select: { id: true, name: true, degree: true }
        });
        if (!course) throw new AppError('Course not found', 404);

        const { id: academicYearId } = await getActiveAcademicYear();

        const activeEntry = await prisma.waitingList.findFirst({
            where: { studentId, academicYearId, status: WaitingListStatus.WAITING },
            include: { course: { select: { name: true } } },
        });
        if (activeEntry) {
            throw new AppError(
                `Student is already on the waiting list this year for ${activeEntry.course.name}`,
                409
            );
        }

        let entry: any;
        for (let attempt = 0; attempt < 5; attempt++) {
            const { _max } = await prisma.waitingList.aggregate({
                where: { courseId, academicYearId },
                _max: { waitingNumber: true },
            });
            const nextNumber = (_max.waitingNumber ?? 0) + 1;
            try {
                entry = await prisma.waitingList.create({
                    data: {
                        studentId,
                        courseId,
                        academicYearId,
                        waitingNumber: nextNumber,
                        category,
                        remarks,
                        status: WaitingListStatus.WAITING,
                        createdBy: adminId,
                    },
                    include: { course: { select: { name: true, degree: true } } },
                });
                break;
            } catch (e: any) {

                if (e?.code === 'P2002' && attempt < 4) {
                    logger.warn(`[addToWaitingList] waitingNumber ${nextNumber} raced for course=${courseId}; retrying (attempt ${attempt + 1})`);
                    continue;
                }
                throw e;
            }
        }

        logger.info(`[addToWaitingList] Student=${studentId} added to course=${courseId} as waitingNumber=${entry.waitingNumber}`);

        let feeDemands = { generated: 0 };
        let feeDemandWarning: string | undefined;
        try {
            const seeded = await FeeService.generateFeeDemands(
                studentId,
                courseId,
                academicYearId,
                adminId,
                false
            );
            feeDemands = { generated: seeded?.generated ?? 0 };
            logger.info(`[addToWaitingList] Seeded ${feeDemands.generated} fee demand(s) for student=${studentId} course=${courseId}`);
            if (feeDemands.generated === 0) {
                feeDemandWarning = (seeded?.skipped ?? 0) > 0
                    ? 'Fee demands already existed for this student/course.'
                    : 'No FeeStructure matched this student\'s cohort for the course — seed fee structures, then regenerate demands.';
                logger.warn(`[addToWaitingList] No new fee demands for course=${courseId} year=${academicYearId}: ${feeDemandWarning}`);
            }
        } catch (err: any) {

            feeDemandWarning = `Fee demands could not be generated: ${err?.message?.split('\n')[0] || err}. Re-run demand generation for this student.`;
            logger.error(`[addToWaitingList] generateFeeDemands failed for student=${studentId} course=${courseId}: ${err}`);
        }

        return {
            student: { id: student.id, name: student.name, applicationId: student.applicationId },
            added: {
                id: entry.id,
                courseId: entry.courseId,
                courseName: entry.course.name,
                degree: entry.course.degree,
                waitingNumber: entry.waitingNumber,
                category: entry.category,
                status: entry.status,
            },
            feeDemandsGenerated: feeDemands.generated,
        };
    },

    async getWaitingList(query: { courseId?: string; status?: string; category?: string; amountSort?: string; page?: number; limit?: number }) {
        const { courseId, status, category, amountSort, page = 1, limit = 50 } = query;
        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);

        const where: any = {};
        if (courseId) where.courseId = courseId;
        if (status) where.status = status;
        else where.status = WaitingListStatus.WAITING;
        if (category) {
            if (!Object.values(WaitingListCategory).includes(category as WaitingListCategory)) {
                throw new AppError(`Invalid category. Allowed: ${Object.values(WaitingListCategory).join(', ')}`, 400);
            }
            where.category = category;
        }

        const ALLOWED_SORTS = ['low', 'high', 'all'];
        let resolvedSort = amountSort ? String(amountSort).toLowerCase() : undefined;
        if (resolvedSort && !ALLOWED_SORTS.includes(resolvedSort)) {
            throw new AppError(`Invalid amountSort. Allowed: ${ALLOWED_SORTS.join(', ')}`, 400);
        }
        if (!resolvedSort) {
            resolvedSort = category === WaitingListCategory.MANAGEMENT ? 'high' : 'all';
        }

        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            select: { id: true },
        });

        const include = {
            student: {
                select: { id: true, name: true, applicationId: true, phone: true, email: true, degreeType: true }
            },
            course: {
                select: { id: true, name: true, degree: true }
            }
        };

        const paidByStudent = async (studentIds: string[]) => {
            if (studentIds.length === 0 || !activeYear) return new Map<string, number>();
            const sums = await prisma.payment.groupBy({
                by: ['studentId'],
                where: { studentId: { in: studentIds }, status: PaymentStatus.SUCCESS, academicYearId: activeYear.id, component: { not: PaymentComponent.APPLICATION_FEE } },
                _sum: { amount: true },
            });
            return new Map(sums.map(s => [s.studentId, s._sum.amount ?? 0]));
        };

        const sortByPaid = resolvedSort === 'low' || resolvedSort === 'high';
        let pageEntries: any[];
        let total: number;
        let paidMap: Map<string, number>;

        if (sortByPaid) {

            const all = await prisma.waitingList.findMany({
                where,
                orderBy: { waitingNumber: 'asc' },
                include,
            });
            paidMap = await paidByStudent(Array.from(new Set(all.map(e => e.studentId))));
            const dir = resolvedSort === 'low' ? 1 : -1;
            all.sort((a, b) => {
                const pa = paidMap.get(a.studentId) ?? 0;
                const pb = paidMap.get(b.studentId) ?? 0;
                if (pa !== pb) return (pa - pb) * dir;
                return a.waitingNumber - b.waitingNumber;
            });
            total = all.length;
            pageEntries = all.slice(skip, skip + take);
        } else {

            const [entries, count] = await Promise.all([
                prisma.waitingList.findMany({ where, skip, take, orderBy: { createdAt: 'asc' }, include }),
                prisma.waitingList.count({ where }),
            ]);
            pageEntries = entries;
            total = count;
            paidMap = await paidByStudent(pageEntries.map(e => e.studentId));
        }

        const uniqueCourseIds = Array.from(new Set(pageEntries.map(e => e.courseId)));
        const capacities = activeYear
            ? await prisma.courseCapacity.findMany({
                where: { courseId: { in: uniqueCourseIds }, academicYearId: activeYear.id },
                select: { courseId: true, totalSeats: true, filledSeats: true },
            })
            : [];
        const capacityByCourse = new Map(capacities.map(c => [c.courseId, c]));

        return {
            entries: pageEntries.map((e, i) => {
                const cap = capacityByCourse.get(e.courseId);
                const totalSeats  = cap?.totalSeats  ?? 0;
                const filled = cap?.filledSeats ?? 0;
                return {
                    id: e.id,

                    waitingNumber: e.waitingNumber,
                    position: skip + i + 1,
                    category: e.category,
                    amountPaid: paidMap.get(e.studentId) ?? 0,
                    student: e.student,
                    course: {
                        id: e.course.id,
                        name: e.course.name,
                        degree: e.course.degree,
                        totalSeats,
                        filledSeats: filled,
                        availableSeats: Math.max(0, totalSeats - filled),
                    },
                    status: e.status,
                    remarks: e.remarks,
                    createdAt: e.createdAt,
                };
            }),
            sortedBy: sortByPaid ? `amountPaid:${resolvedSort === 'low' ? 'asc' : 'desc'}` : 'createdAt',
            amountSort: resolvedSort,
            pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / take) }
        };
    },

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
                waitingNumber: e.waitingNumber,
                category: e.category,
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

    async getWaitingListEntry(waitingListId: string) {
        if (!waitingListId) throw new AppError('Waiting list entry ID is required', 400);

        const entry = await prisma.waitingList.findUnique({
            where: { id: waitingListId },
            include: {
                student: { select: { id: true, name: true, applicationId: true, phone: true, email: true, degreeType: true } },
                course:  { select: { id: true, name: true, degree: true } },
                academicYear: { select: { id: true, code: true } },
            },
        });
        if (!entry) throw new AppError('Waiting list entry not found', 404);

        const cap = await prisma.courseCapacity.findUnique({
            where: { courseId_academicYearId: { courseId: entry.courseId, academicYearId: entry.academicYearId } },
            select: { totalSeats: true, filledSeats: true },
        });
        const totalSeats  = cap?.totalSeats  ?? 0;
        const filledSeats = cap?.filledSeats ?? 0;

        const paid = await prisma.payment.aggregate({
            where: { studentId: entry.studentId, status: PaymentStatus.SUCCESS, academicYearId: entry.academicYearId, component: { not: PaymentComponent.APPLICATION_FEE } },
            _sum: { amount: true },
        });

        return {
            id: entry.id,
            waitingNumber: entry.waitingNumber,
            category: entry.category,
            status: entry.status,
            remarks: entry.remarks,
            amountPaid: paid._sum.amount ?? 0,
            createdAt: entry.createdAt,
            allottedAt: entry.allottedAt,
            allottedBy: entry.allottedBy,
            academicYear: entry.academicYear,
            student: entry.student,
            course: {
                id: entry.course.id,
                name: entry.course.name,
                degree: entry.course.degree,
                totalSeats,
                filledSeats,
                availableSeats: Math.max(0, totalSeats - filledSeats),
            },
        };
    },

    async allotFromWaitingList(
        waitingListId: string,
        allocation: {
            type: AccommodationType;
            hostelId?: string;
            hostelType?: HostelType;
            hostelPaymentMode?: HostelPaymentMode;
            transportRouteId?: string;
        },
        adminId: string,
    ) {
        if (!waitingListId) throw new AppError('Waiting list entry ID is required', 400);
        if (!allocation || !allocation.type) throw new AppError('Accommodation type is required', 400);
        if (!Object.values(AccommodationType).includes(allocation.type)) {
            throw new AppError(`Invalid accommodation type. Allowed: ${Object.values(AccommodationType).join(', ')}`, 400);
        }

        if (allocation.type === AccommodationType.HOSTEL) {

            if (!allocation.hostelType || !Object.values(HostelType).includes(allocation.hostelType)) {
                throw new AppError(`Valid hostelType (sharing) is required for HOSTEL. Allowed: ${Object.values(HostelType).join(', ')}`, 400);
            }
            if (!allocation.hostelPaymentMode || !Object.values(HostelPaymentMode).includes(allocation.hostelPaymentMode)) {
                throw new AppError(`Valid hostelPaymentMode is required for HOSTEL. Allowed: ${Object.values(HostelPaymentMode).join(', ')}`, 400);
            }
            if (allocation.hostelId) {
                const hostel = await prisma.hostel.findUnique({ where: { id: allocation.hostelId } });
                if (!hostel) throw new AppError('Selected hostel not found', 404);
            }
        } else if (allocation.type === AccommodationType.TRANSPORT) {
            if (!allocation.transportRouteId) throw new AppError('transportRouteId is required for TRANSPORT', 400);
            const route = await prisma.transportRoute.findUnique({ where: { id: allocation.transportRouteId } });
            if (!route) throw new AppError('Selected transport route not found', 404);
        }

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

        const capacity = await getCourseCapacity(prisma, entry.courseId, ayId);
        const availableSeats = capacity.totalSeats - capacity.filledSeats;
        if (availableSeats <= 0) throw new AppError(`No seats available in ${entry.course.name}`, 400);

        await prisma.$transaction(async (tx) => {

            const claimed = await tryAtomicIncrementCourseCapacity(tx, entry.courseId, ayId);
            if (!claimed) {
                throw new AppError(`No seats available in ${entry.course.name}`, 400);
            }

            const accommodationData: any = {};
            if (allocation.type === AccommodationType.HOSTEL) {
                accommodationData.accommodationType = AccommodationType.HOSTEL;
                accommodationData.hostelType = allocation.hostelType;
                accommodationData.hostelPaymentMode = allocation.hostelPaymentMode;
                if (allocation.hostelId) accommodationData.hostelId = allocation.hostelId;
            } else if (allocation.type === AccommodationType.NONE) {
                accommodationData.accommodationType = AccommodationType.NONE;
            }
            await tx.studentAdmission.update({
                where: { studentId: entry.studentId },
                data: {
                    allottedCourseId: entry.courseId,
                    status: AdmissionStatus.SEAT_ALLOTTED,
                    seatAllottedAt: new Date(),
                    seatAllotedBy: adminId,
                    ...accommodationData,
                }
            });

            await tx.waitingList.update({
                where: { id: waitingListId },
                data: { status: WaitingListStatus.ALLOTTED, allottedAt: new Date(), allottedBy: adminId, updatedBy: adminId }
            });

            await tx.waitingList.updateMany({
                where: {
                    studentId: entry.studentId,
                    academicYearId: entry.academicYearId,
                    status: WaitingListStatus.WAITING,
                    id: { not: waitingListId },
                },
                data: { status: WaitingListStatus.CANCELLED, updatedBy: adminId }
            });

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

        let accommodationWarning: string | undefined;
        let accommodationNote: string | undefined;
        try {
            if (allocation.type === AccommodationType.HOSTEL) {
                if (allocation.hostelId) {

                    await AccommodationService.assignHostel(
                        entry.studentId,
                        allocation.hostelId,
                        allocation.hostelPaymentMode as 'YEARWISE' | 'SEMWISE',
                        allocation.hostelType!,
                        adminId,
                    );
                    logger.info(`[allotFromWaitingList] Hostel assigned for student=${entry.studentId} hostel=${allocation.hostelId} type=${allocation.hostelType} mode=${allocation.hostelPaymentMode}`);
                } else {

                    accommodationNote = `Hostel choice recorded (${allocation.hostelType}, ${allocation.hostelPaymentMode}). Assign a specific hostel/bed later to generate hostel fee demands.`;
                    logger.info(`[allotFromWaitingList] Hostel intent recorded (no hostelId) for student=${entry.studentId} type=${allocation.hostelType} mode=${allocation.hostelPaymentMode}`);
                }
            } else if (allocation.type === AccommodationType.TRANSPORT) {
                await AccommodationService.assignTransport(
                    entry.studentId,
                    allocation.transportRouteId!,
                    adminId,
                );
                logger.info(`[allotFromWaitingList] Transport assigned for student=${entry.studentId} route=${allocation.transportRouteId}`);
            }

        } catch (err: any) {
            accommodationWarning = `Seat allotted, but accommodation (${allocation.type}) could not be applied: ${err?.message || err}. Re-run the assign-${allocation.type === AccommodationType.HOSTEL ? 'hostel' : 'transport'} flow.`;
            logger.error(`[allotFromWaitingList] Accommodation apply failed for student=${entry.studentId}: ${err}`);
        }

        let allotmentOrderGenerated = false;
        let allotmentOrderUrl: string | null = null;
        try {
            await generateAndSaveAllotmentOrder(entry.studentId);
            const doc = await prisma.studentDocument.findUnique({
                where: { studentId_documentKey: { studentId: entry.studentId, documentKey: 'ALLOTMENT_ORDER' } },
                select: { url: true },
            });
            if (doc?.url) {
                allotmentOrderUrl = await convertToPresignedUrl(doc.url);
                allotmentOrderGenerated = true;
            }
            logger.info(`[allotFromWaitingList] Allotment order ${allotmentOrderGenerated ? 'generated' : 'NOT found'} for student=${entry.studentId}`);
        } catch (err) {
            logger.warn(`[allotFromWaitingList] Allotment order generation failed for student=${entry.studentId}: ${err}`);
        }

        return {

            studentId: entry.studentId,
            studentName: entry.student.name,
            courseId: entry.courseId,
            courseName: entry.course.name,
            degree: entry.course.degree,
            status: 'ALLOTTED',
            student: {
                id: entry.student.id,
                name: entry.student.name,
                applicationId: entry.student.applicationId,
            },
            allottedCourse: {
                id: entry.course.id,
                name: entry.course.name,
                degree: entry.course.degree,
            },
            waitingNumber: entry.waitingNumber,
            category: entry.category,
            accommodation: {
                type: allocation.type,
                ...(allocation.type === AccommodationType.HOSTEL ? {
                    hostelType: allocation.hostelType,
                    hostelPaymentMode: allocation.hostelPaymentMode,
                    hostelId: allocation.hostelId ?? null,
                } : {}),
                ...(allocation.type === AccommodationType.TRANSPORT ? {
                    transportRouteId: allocation.transportRouteId,
                } : {}),
            },
            allotmentOrder: {
                generated: allotmentOrderGenerated,
                url: allotmentOrderUrl,
            },
            ...(accommodationNote ? { accommodationNote } : {}),
            ...(accommodationWarning ? { accommodationWarning } : {}),
        };
    },

    async removeFromWaitingList(data: { waitingListId?: string; studentId?: string; courseId?: string }, adminId: string) {
        const { waitingListId, studentId, courseId } = data;

        if (waitingListId) {

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

    async exportWaitingListExcel(query: { courseId?: string; status?: string; category?: string; amountSort?: string }) {

        const { entries, sortedBy } = await this.getWaitingList({ ...query, page: 1, limit: 1_000_000 });

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'VVIT ERP';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Waiting List');

        sheet.columns = [
            { header: 'S.No',            key: 'sno',            width: 6 },
            { header: 'Waiting #',       key: 'waitingNumber',  width: 10 },
            { header: 'Application ID',  key: 'applicationId',  width: 18 },
            { header: 'Student Name',    key: 'studentName',    width: 26 },
            { header: 'Phone',           key: 'phone',          width: 15 },
            { header: 'Email',           key: 'email',          width: 26 },
            { header: 'Course',          key: 'course',         width: 32 },
            { header: 'Degree',          key: 'degree',         width: 12 },
            { header: 'Category',        key: 'category',       width: 14 },
            { header: 'Amount Paid',     key: 'amountPaid',     width: 14 },
            { header: 'Status',          key: 'status',         width: 12 },
            { header: 'Available Seats', key: 'availableSeats', width: 14 },
            { header: 'Registered At',   key: 'createdAt',      width: 22 },
        ];

        entries.forEach((e: any, i: number) => {
            sheet.addRow({
                sno: i + 1,
                waitingNumber: e.waitingNumber,
                applicationId: e.student?.applicationId ?? '',
                studentName: e.student?.name ?? '',
                phone: e.student?.phone ?? '',
                email: e.student?.email ?? '',
                course: e.course?.name ?? '',
                degree: e.course?.degree ?? '',
                category: e.category,
                amountPaid: e.amountPaid ?? 0,
                status: e.status,
                availableSeats: e.course?.availableSeats ?? 0,
                createdAt: e.createdAt ? new Date(e.createdAt).toISOString() : '',
            });
        });

        sheet.getRow(1).font = { bold: true };
        sheet.getColumn('amountPaid').numFmt = '#,##0';

        logger.info(`[exportWaitingListExcel] Exported ${entries.length} row(s) (sortedBy=${sortedBy}, category=${query.category ?? 'ALL'})`);
        return (await workbook.xlsx.writeBuffer()) as unknown as Buffer;
    },
};
