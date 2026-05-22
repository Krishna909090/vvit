// Waiting-list operations split out of adminStudent.service.ts.
// Exposes an object that the barrel composes into AdminStudentService.

import prisma from '../../../config/prisma';
import { AdmissionStatus, AdmissionEntryType, WaitingListStatus, WaitingListCategory, PaymentStatus, AccommodationType, HostelType, HostelPaymentMode } from '@prisma/client';
import { AccommodationService } from './accommodation';
import { generateAndSaveAllotmentOrder } from '../../finance/payment.service';
import { convertToPresignedUrl } from '../../../utils/s3Utils';
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
    /**
     * Add a student to the waitlist for a single course in the active year.
     *
     * Rules:
     *  - One student → one course per academic year. A student with an active
     *    (WAITING) entry that year is rejected (409).
     *  - Only first-year REGULAR-entry admissions are eligible (no lateral /
     *    transfer / promoted students).
     *  - Each entry gets a fixed waitingNumber = MAX(waitingNumber)+1 within the
     *    (courseId, academicYearId) queue, assigned atomically. The number is a
     *    permanent token; it does not shift when entries ahead are allotted or
     *    cancelled (live rank is computed in getWaitingList).
     */
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

        // The waitlisted course must be one of the student's opted preferences.
        const preferences = [student.pref1, student.pref2, student.pref3].filter(Boolean) as string[];
        if (preferences.length === 0) {
            throw new AppError('Student has no course preferences (pref1/pref2/pref3) set; cannot waitlist', 400);
        }
        if (!preferences.includes(courseId)) {
            throw new AppError('Course must be one of the student\'s opted preferences (pref1, pref2 or pref3)', 400);
        }

        // Eligibility: only first-year REGULAR admissions get a waiting list.
        // entryType/entryYearOfStudy default to REGULAR/1 in the schema, so treat
        // null as the first-year-regular default.
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

        // One active entry per student per year (regardless of course).
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

        // Assign the next number atomically: MAX(waitingNumber)+1 for this
        // course-queue/year, then create. The unique constraint on
        // (courseId, academicYearId, waitingNumber) is the safety net — under a
        // concurrent insert one create hits P2002, and we retry with a fresh max.
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
                // P2002 = unique violation (number raced). Retry with a fresh max.
                if (e?.code === 'P2002' && attempt < 4) {
                    logger.warn(`[addToWaitingList] waitingNumber ${nextNumber} raced for course=${courseId}; retrying (attempt ${attempt + 1})`);
                    continue;
                }
                throw e;
            }
        }

        logger.info(`[addToWaitingList] Student=${studentId} added to course=${courseId} as waitingNumber=${entry.waitingNumber}`);

        // Seed fee demands for the waitlisted course up front so the tuition
        // advance (paid via /finance/pay-component) settles against a real demand
        // instead of floating as an unmatched credit. This generates StudentFeeDemand
        // rows + their DEBIT ledger entries and recomputes admission.totalFee — it does
        // NOT claim a seat or confirm admission. Best-effort: if no FeeStructure exists
        // for this course/year it logs and returns 0 demands (non-fatal); the demands
        // can be regenerated later (allotment uses deleteExisting). Mirrors manualEntryAdmission.
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
            // Never fail the waitlist add because demand seeding had trouble — but
            // surface WHY (e.g. transaction timeout) instead of silently returning 0.
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

    /**
     * Get the waiting list, filterable by course, status and category.
     *
     * Ordering depends on category:
     *  - MANAGEMENT  → by total amount paid (Σ SUCCESS payments this year), highest
     *                  first; ties broken by waitingNumber. Because this sort key is
     *                  computed from payments, the page is ranked + sliced in memory.
     *  - POLICE / GENERAL / no category → by waitingNumber (waiting rank), ascending;
     *                  paginated in the DB.
     * availableSeats is scoped to the active academic year. Every entry returns
     * amountPaid so the management ranking is transparent.
     */
    async getWaitingList(query: { courseId?: string; status?: string; category?: string; page?: number; limit?: number }) {
        const { courseId, status, category, page = 1, limit = 50 } = query;
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

        // Sum of SUCCESS payments per student (active year) — the management sort key.
        const paidByStudent = async (studentIds: string[]) => {
            if (studentIds.length === 0 || !activeYear) return new Map<string, number>();
            const sums = await prisma.payment.groupBy({
                by: ['studentId'],
                where: { studentId: { in: studentIds }, status: PaymentStatus.SUCCESS, academicYearId: activeYear.id },
                _sum: { amount: true },
            });
            return new Map(sums.map(s => [s.studentId, s._sum.amount ?? 0]));
        };

        const sortByPaid = category === WaitingListCategory.MANAGEMENT;
        let pageEntries: any[];
        let total: number;
        let paidMap: Map<string, number>;

        if (sortByPaid) {
            // Computed sort key → fetch all matching, rank by paid desc, slice in memory.
            const all = await prisma.waitingList.findMany({
                where,
                orderBy: { waitingNumber: 'asc' },
                include,
            });
            paidMap = await paidByStudent(Array.from(new Set(all.map(e => e.studentId))));
            all.sort((a, b) => {
                const pa = paidMap.get(a.studentId) ?? 0;
                const pb = paidMap.get(b.studentId) ?? 0;
                if (pb !== pa) return pb - pa;            // highest paid first
                return a.waitingNumber - b.waitingNumber;  // tie-break by rank
            });
            total = all.length;
            pageEntries = all.slice(skip, skip + take);
        } else {
            // Rank order — paginate in the DB.
            const [entries, count] = await Promise.all([
                prisma.waitingList.findMany({ where, skip, take, orderBy: { waitingNumber: 'asc' }, include }),
                prisma.waitingList.count({ where }),
            ]);
            pageEntries = entries;
            total = count;
            paidMap = await paidByStudent(pageEntries.map(e => e.studentId));
        }

        // Batch-load CourseCapacity for the active year, keyed by courseId
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
                    // waitingNumber = fixed token assigned at join (stable, may have gaps).
                    // position = live rank in this result ordering (rank or paid-rank).
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
            sortedBy: sortByPaid ? 'amountPaid' : 'waitingNumber',
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

    /**
     * Allot a seat from the waiting list. Moves student from WAITING → ALLOTTED,
     * sets admission to SEAT_ALLOTTED, and applies the chosen accommodation.
     *
     * allocation.type:
     *   - HOSTEL    → requires { hostelType (SHARING_*), hostelPaymentMode (YEARWISE|SEMWISE) }.
     *                 hostelId is OPTIONAL — the student picks sharing + payment mode here;
     *                 the specific hostel/bed is assigned later. With no hostelId the choice
     *                 is recorded on the admission and hostel fee demands are deferred to the
     *                 assign-hostel/allocate-bed step. With a hostelId, assignHostel runs now.
     *   - TRANSPORT → requires { transportRouteId }
     *   - NONE      → no accommodation
     * The seat is claimed first (the scarce resource); accommodation is applied
     * afterwards via AccommodationService and is best-effort — if it fails the seat
     * stays allotted and an accommodationWarning is returned (admin can re-run assign).
     */
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

        // Validate accommodation inputs up front (before claiming the seat).
        if (allocation.type === AccommodationType.HOSTEL) {
            // hostelId is optional at this stage — sharing + payment mode are what the
            // student picks; the specific hostel is allocated later.
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

            // 2. Update admission — seat + the student's accommodation choice.
            //    For HOSTEL we record type/sharing/mode now (hostelId may be null until
            //    the specific hostel is assigned). For TRANSPORT, assignTransport (below)
            //    sets the route. NONE leaves accommodationType = NONE.
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

            // 3. Mark this entry as ALLOTTED
            await tx.waitingList.update({
                where: { id: waitingListId },
                data: { status: WaitingListStatus.ALLOTTED, allottedAt: new Date(), allottedBy: adminId, updatedBy: adminId }
            });

            // 4. Cancel any other WAITING entries for this student in the SAME year.
            // With one-course-per-year this is normally a no-op; the year scope
            // ensures a future-year entry is never collaterally cancelled.
            await tx.waitingList.updateMany({
                where: {
                    studentId: entry.studentId,
                    academicYearId: entry.academicYearId,
                    status: WaitingListStatus.WAITING,
                    id: { not: waitingListId },
                },
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

        // Apply the chosen accommodation after the seat is secured. Best-effort:
        // a failure here must not undo the (already committed) seat allotment.
        let accommodationWarning: string | undefined;
        let accommodationNote: string | undefined;
        try {
            if (allocation.type === AccommodationType.HOSTEL) {
                if (allocation.hostelId) {
                    // Specific hostel chosen → assign now (creates pricing snapshot + demands).
                    await AccommodationService.assignHostel(
                        entry.studentId,
                        allocation.hostelId,
                        allocation.hostelPaymentMode as 'YEARWISE' | 'SEMWISE',
                        allocation.hostelType!,
                        adminId,
                    );
                    logger.info(`[allotFromWaitingList] Hostel assigned for student=${entry.studentId} hostel=${allocation.hostelId} type=${allocation.hostelType} mode=${allocation.hostelPaymentMode}`);
                } else {
                    // No specific hostel yet — choice (sharing + mode) is recorded on the
                    // admission; hostel fee demands + bed are created when assign-hostel runs.
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
            // NONE → nothing to assign; admission stays accommodationType=NONE.
        } catch (err: any) {
            accommodationWarning = `Seat allotted, but accommodation (${allocation.type}) could not be applied: ${err?.message || err}. Re-run the assign-${allocation.type === AccommodationType.HOSTEL ? 'hostel' : 'transport'} flow.`;
            logger.error(`[allotFromWaitingList] Accommodation apply failed for student=${entry.studentId}: ${err}`);
        }

        // Generate the allotment order (same as the regular seat-allotment flow) and
        // return a presigned URL to the PDF. Best-effort: a PDF/S3 hiccup must not undo
        // the committed allotment.
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
            // Top-level kept for the controller's success message + backward compatibility.
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
                url: allotmentOrderUrl,   // presigned (≈1h); null if generation/lookup failed
            },
            ...(accommodationNote ? { accommodationNote } : {}),
            ...(accommodationWarning ? { accommodationWarning } : {}),
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
