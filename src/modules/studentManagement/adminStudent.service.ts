import prisma from '../../config/prisma';
import { AdmissionStatus, CancellationStatus, RequestStatus, StudentDocumentStatus, AccommodationType, FeeStatus, Prisma, HostelType, PaymentMethod, PaymentStatus, PaymentMode, PaymentComponent, LedgerTransactionType, HostelPaymentMode, WaitingListStatus, AdmissionEntryType, ApplicationMode, QuotaType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { Role } from '../../constants/roles';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import Papa from 'papaparse';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import axios from 'axios';
import { registerStudent } from '../student/student.service';
import { FeeService, getApplicationFeeAmount } from '../finance/fee.service';
import { convertToPresignedUrl } from '../../utils/s3Utils';
import { maskAadhaar } from '../../utils/mask';
import { generateApplicationPDF } from '../../utils/applicationPdfGenerator';
import { getHostelCostTx, getSemwiseSurchargeTx } from '../../utils/hostelPricing';
import {
    incrementCourseCapacity,
    decrementCourseCapacity,
    tryAtomicIncrementCourseCapacity,
    getCourseCapacity,
} from '../../utils/courseCapacity';
import { assertHostelHasCapacity } from '../accommodation/hostel/hostel.service';
import {
    getStudentContext,
    getStudentYearOfStudy,
    assertActiveAdmission,
    assertHostelAccommodation,
    assertNoBedAllocated,
    resolveFeeHeadsByComponent,
    resolveFeeDemandContext,
    getAvailableHostelCredit,
    assertAcademicYearWritable,
    resolveHostelPriceCategory,
    resolveTransportRouteCost,
    getActiveAcademicYear,
} from '../../utils/studentContext';
import { getEnv } from '../../config/envValidator';
import { sendAdmissionFeeReceipt, sendPaymentReceipt, sendScholarshipUpdateEmail } from '../../utils/emailService';
// @ts-ignore
import { StandardCheckoutClient, Env, StandardCheckoutPayRequest } from 'pg-sdk-node';
import { InvoiceService } from '../finance/invoice.service';
import { getPhonePeClient, initiatePhonePePayment, generateAndSaveAllotmentOrder, generateAndSaveHostelAllotmentOrder } from '../finance/payment.service';

// Helpers + constants moved to ./adminStudent/_shared.ts as part of the file split.
// Re-imported here so existing in-file callers keep working unchanged.
import {
    PHONEPE_MERCHANT_ID,
    PHONEPE_SALT_KEY,
    PHONEPE_SALT_INDEX,
    PHONEPE_ENV,
    FRONTEND_URL_ADMISSION,
    PREF_COURSE_WITH_CAPACITY,
    attachCourseCapacity,
    buildApplicationFilters,
} from './adminStudent/_shared';


export const AdminStudentService = {
    async getAllApplications(query: any) {
        const { page = 1, limit = 10 } = query;
        const skip = (Number(page) - 1) * Number(limit);

        const where = await buildApplicationFilters(query);

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                skip,
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    admissionDetails: {
                        include: {
                            allottedCourse: true,
                            hostel: true,
                            transportRoute: true
                        }
                    },
                    examDetails: true,
                    documents: true,
                    academicQualifications: true,
                    scholarshipAllocation: { include: { rule: true } },
                    pref1Course: PREF_COURSE_WITH_CAPACITY,
                    pref2Course: PREF_COURSE_WITH_CAPACITY,
                    pref3Course: PREF_COURSE_WITH_CAPACITY,
                    feeDemands: {
                        include: {
                            feeStructure: {
                                include: {
                                    feeHead: true
                                }
                            },
                            payments: true
                        }
                    },
                    studentScholarship: true,
                    payments: true,
                    ledgerEntries: true,
                    courseChangeLogs: true,
                    discountRequests: true,
                    user: true,
                    enrollments: true,
                    hostelAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        include: { academicYear: { select: { id: true, code: true, isActive: true } } },
                    },
                    transportAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        include: { academicYear: { select: { id: true, code: true, isActive: true } } },
                    },
                    convenorDetails: true,
                    pro: true
                }
            }),
            prisma.student.count({ where })
        ]);

        const enhancedStudents = await Promise.all(students.map(async (student: any) => {
            // Convert document URLs to presigned URLs
            const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
                ...doc,
                url: await convertToPresignedUrl(doc.url)
            })));

            // Convert profile photo URL
            const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);

            const { transportAllocations: _ta, ...studentRest } = student;
            return {
                ...studentRest,
                aadharNumber: maskAadhaar(student.aadharNumber),
                profilePhotoUrl,
                documents: documentsWithPresignedUrls,
                pref1Course: attachCourseCapacity(student.pref1Course),
                pref2Course: attachCourseCapacity(student.pref2Course),
                pref3Course: attachCourseCapacity(student.pref3Course),
                transportAllocation: _ta?.[0] ?? null,
            };
        }));

        return {
            students: enhancedStudents,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / Number(limit))
            }
        };
    },

    async exportApplicationsCsv(query: any) {
        const where = await buildApplicationFilters(query);

        const students = await prisma.student.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                admissionDetails: { include: { allottedCourse: true } },
                examDetails: true,
                academicQualifications: true,
                pref1Course: true,
                pref2Course: true,
                pref3Course: true,
                studentScholarship: true,
                payments: true,
            }
        });

        // Collect all unique verifiedBy user IDs to resolve names
        const verifierIds = new Set<string>();
        for (const s of students) {
            for (const q of (s as any).academicQualifications || []) {
                if (q.verifiedBy) verifierIds.add(q.verifiedBy);
            }
        }
        const verifierMap = new Map<string, string>();
        if (verifierIds.size > 0) {
            const verifiers = await prisma.user.findMany({
                where: { id: { in: Array.from(verifierIds) } },
                select: { id: true, name: true }
            });
            for (const v of verifiers) {
                verifierMap.set(v.id, v.name || v.id);
            }
        }

        const rows = students.map((s: any) => {
            const q10th = s.academicQualifications?.find((q: any) => q.level === '10th');
            const q12th = s.academicQualifications?.find((q: any) => q.level === '12th');
            return {
            'Application ID': s.applicationId || '',
            'Name': s.name || '',
            'Gender': s.gender || '',
            'Email': s.email || '',
            'Phone': s.phone || '',
            'Degree Type': s.degreeType || '',
            'Quota Type': s.quotaType || '',
            'Preference 1': s.pref1Course?.name || '',
            'Preference 2': s.pref2Course?.name || '',
            'Preference 3': s.pref3Course?.name || '',
            'Allotted Course': s.admissionDetails?.allottedCourse?.name || '',
            'Admission Status': s.admissionDetails?.status || '',
            'Exam Date': s.examDetails?.testDate ? new Date(s.examDetails.testDate).toISOString().split('T')[0] : '',
            'Exam Score': s.examDetails?.examScore ?? '',
            'Is Qualified': s.examDetails?.isQualified ? 'Yes' : 'No',
            'Application Fee Paid': s.payments?.some((p: any) => p.component === PaymentComponent.APPLICATION_FEE && p.status === PaymentStatus.SUCCESS) ? 'PAID' : 'UNPAID',
            'Scholarship Eligible': s.studentScholarship?.isEligible || '',
            '10th Marks': q10th?.gpaOrMarks ?? '',
            '10th Board': q10th?.board || '',
            '10th Verification Status': q10th?.verificationStatus || '',
            '10th Verified By': q10th?.verifiedBy ? (verifierMap.get(q10th.verifiedBy) || q10th.verifiedBy) : '',
            '12th Marks': q12th?.gpaOrMarks ?? '',
            '12th Board': q12th?.board || '',
            '12th Verification Status': q12th?.verificationStatus || '',
            '12th Verified By': q12th?.verifiedBy ? (verifierMap.get(q12th.verifiedBy) || q12th.verifiedBy) : '',
            'Created At': s.createdAt ? new Date(s.createdAt).toISOString().split('T')[0] : '',
        };
        });

        return Papa.unparse(rows);
    },

    async getApplicationsExtended(query: any) {
        const { page = 1, limit = 10, search, status, quotaType, courseType, degree, applicationId, isScholarshipEligible, gender, preference, paymentStatus } = query;
        const skip = (Number(page) - 1) * Number(limit);

        const where: any = {};
        const andConditions: any[] = [];

        // Search Condition
        if (search) {
             andConditions.push({
                applicationId: { contains: String(search), mode: 'insensitive' }
            });
        }
        
        // Preference Condition
        if (preference) {
            andConditions.push({
                OR: [
                    { pref1Course: { name: { contains: String(preference), mode: 'insensitive' } } },
                    { pref2Course: { name: { contains: String(preference), mode: 'insensitive' } } },
                    { pref3Course: { name: { contains: String(preference), mode: 'insensitive' } } }
                ]
            });
        }
        
        if (andConditions.length > 0) {
            where.AND = andConditions;
        }

        if (applicationId) {
            where.applicationId = String(applicationId);
        }

        if (status) {
            where.admissionDetails = {
                status: status
            };
        }

        if (quotaType) {
            where.quotaType = quotaType;
        }

        if (courseType || degree) {
            where.degreeType = courseType || degree;
        }
        
        if (gender) {
            where.gender = { equals: gender, mode: 'insensitive' };
        }
        
        if (isScholarshipEligible) {
            if (String(isScholarshipEligible).toUpperCase() === 'NULL') {
                where.studentScholarship = null;
            } else if (String(isScholarshipEligible).toUpperCase() === 'NOT_NULL') {
                where.studentScholarship = { isNot: null };
            } else {
                where.studentScholarship = {
                    isEligible: String(isScholarshipEligible)
                };
            }
        }

        if (query.hasDocuments === 'true') {
            where.documents = {
                some: {} 
            };
        } else if (query.hasDocuments === 'false') {
             where.documents = {
                none: {} 
            };
        }

        // Payment Status Filter (Default: PAID)
        const pStatus = paymentStatus ? String(paymentStatus).toUpperCase() : 'PAID';

        if (pStatus === 'PAID') {
            where.payments = {
                some: {
                    component: PaymentComponent.APPLICATION_FEE,
                    status: PaymentStatus.SUCCESS
                }
            };
        } else if (pStatus === 'PENDING' || pStatus === 'UNPAID') {
             where.payments = {
                none: {
                    component: PaymentComponent.APPLICATION_FEE,
                    status: PaymentStatus.SUCCESS
                }
            };
        }
        // IF 'ALL', do nothing

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                skip,
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    admissionDetails: {
                        include: {
                            allottedCourse: true,
                            hostel: true,
                            transportRoute: true
                        }
                    },
                    examDetails: true,
                    documents: true,
                    academicQualifications: true,
                    scholarshipAllocation: { include: { rule: true } },
                    pref1Course: PREF_COURSE_WITH_CAPACITY,
                    pref2Course: PREF_COURSE_WITH_CAPACITY,
                    pref3Course: PREF_COURSE_WITH_CAPACITY,
                    feeDemands: {
                        include: {
                            feeStructure: {
                                include: {
                                    feeHead: true
                                }
                            },
                            payments: true
                        }
                    },
                    studentScholarship: true,
                    payments: true,
                    ledgerEntries: true,
                    courseChangeLogs: true,
                    discountRequests: true,
                    user: true,
                    enrollments: true,
                    hostelAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        include: { academicYear: { select: { id: true, code: true, isActive: true } } },
                    },
                    transportAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        include: { academicYear: { select: { id: true, code: true, isActive: true } } },
                    },
                    convenorDetails: true,
                    pro: true
                }
            }),
            prisma.student.count({ where })
        ]);

        const enhancedStudents = await Promise.all(students.map(async (student: any) => {
            // Convert document URLs to presigned URLs
            const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
                ...doc,
                url: await convertToPresignedUrl(doc.url)
            })));

            // Convert profile photo URL
            const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);

            const { transportAllocations: _ta, ...studentRest } = student;
            return {
                ...studentRest,
                aadharNumber: maskAadhaar(student.aadharNumber),
                profilePhotoUrl,
                documents: documentsWithPresignedUrls,
                pref1CourseName: student.pref1Course?.name || null,
                pref2CourseName: student.pref2Course?.name || null,
                pref3CourseName: student.pref3Course?.name || null,
                transportAllocation: _ta?.[0] ?? null,
            };
        }));

        return {
            students: enhancedStudents,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / Number(limit))
            }
        };
    },

    async processBulkApplications(fileContent: string, currentUserId: string | undefined) {
        const { data, errors } = Papa.parse(fileContent, {
            header: true,
            skipEmptyLines: true
        });

        if (errors.length > 0) {
            throw new AppError(MESSAGES.ERROR.CSV_PARSE_ERROR, 400);
        }

        const students: any[] = data;
        const results = [];

        for (const studentData of students) {
            try {
                let dob: Date;
                if (studentData.date_of_birth.includes('/')) {
                    const [day, month, year] = studentData.date_of_birth.split('/');
                    dob = new Date(`${year}-${month}-${day}`);
                } else {
                    dob = new Date(studentData.date_of_birth);
                }

                const mappedData = {
                    name: studentData.full_name,
                    fatherName: studentData.father_name,
                    motherName: studentData.mother_name,
                    email: studentData.email,
                    phone: studentData.mobile,
                    gender: studentData.gender,
                    dob: dob, 
                    aadharNumber: studentData.aadhar_number,
                    category: studentData.category,
                    address: studentData.address,
                    city: studentData.city,
                    state: studentData.state,
                    pincode: studentData.pincode,
                    pref1: studentData.branch_preference_1,
                    pref2: studentData.branch_preference_2,
                    pref3: studentData.branch_preference_3,
                    isOffline: true,
                    degreeType: studentData.course_type || 'B.Tech',
                    profilePhotoUrl: studentData.profile_photo_url || 'https://via.placeholder.com/150',
                };

                const student = await registerStudent(mappedData, null, currentUserId || null);
                results.push({ email: student.email, status: 'Success', id: student.applicationId });
            } catch (err: any) {
                results.push({ email: studentData.email, status: 'Failed', error: err.message });
            }
        }
        return results;
    },

    async requestCancellation(studentId: string, reason: string, refundAmount: number) {
        if (!studentId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_REASON_REQUIRED, 400);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const adminCancelYear = await getActiveAcademicYear();
        return await prisma.cancellationRequest.create({
            data: {
                studentId,
                academicYearId: adminCancelYear.id,
                reason,
                refundAmount: Number(refundAmount),
                status: CancellationStatus.REQUESTED
            }
        });
    },

    async approveCancellation(requestId: string, approved: boolean, adminRole: string | undefined, adminId: string | undefined) {
        if (adminRole !== Role.SUPER_ADMIN) {
            throw new AppError(MESSAGES.ERROR.FORBIDDEN, 403);
        }

        if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

        const request = await prisma.cancellationRequest.findUnique({
            where: { id: requestId },
            include: { student: { include: { admissionDetails: true } } }
        });

        if (!request) {
            throw new AppError(MESSAGES.ERROR.REQUEST_NOT_FOUND, 404);
        }

        const status = approved ? CancellationStatus.APPROVED : CancellationStatus.REJECTED;

        await prisma.$transaction(async (tx) => {
            await tx.cancellationRequest.update({
                where: { id: requestId },
                data: { status, approvedBy: adminId }
            });

            if (approved) {
                await tx.studentAdmission.update({
                    where: { studentId: request.studentId },
                    data: { status: AdmissionStatus.CANCELLED }
                });

                if (request.student.admissionDetails?.allottedCourseId && request.student.admissionDetails.academicYearId) {
                    await decrementCourseCapacity(
                        tx,
                        request.student.admissionDetails.allottedCourseId,
                        request.student.admissionDetails.academicYearId,
                    );
                }
            }
        });

        return { status };
    },

    async verifyAndAllotSeat(studentId: string, approved: boolean, allottedCourseId: string, adminId: string | undefined) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
        if (!approved) {
            return { success: false, message: MESSAGES.ERROR.DOCUMENTS_REJECTED };
        }

        if (!allottedCourseId) throw new AppError(MESSAGES.ERROR.ALLOTTED_COURSE_REQUIRED, 400);

        const student = await prisma.student.findUnique({ 
            where: { id: studentId },
            include: { examDetails: true }
        });
        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        // Verify Course
        const course = await prisma.course.findUnique({ where: { id: allottedCourseId } });
        if (!course) throw new AppError("Course not found", 404);

        await prisma.$transaction(async (tx) => {
            const admission = await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    status: AdmissionStatus.SEAT_ALLOTTED,
                    allottedCourseId: allottedCourseId
                },
                select: { academicYearId: true }
            });

            if (admission.academicYearId) {
                await incrementCourseCapacity(tx, allottedCourseId, admission.academicYearId);
            }

            await tx.seatAllocation.create({
                data: {
                    studentId,
                    academicYearId: admission.academicYearId,
                    newCourse: course.name, // Storing Name for readability
                    allocatedBy: adminId || 'ADMIN',
                    notes: 'Initial Seat Allotment'
                }
            });
        });

        // Scholarship Allocation (Runs independently of transaction to allow failure without rolling back seat? 
        // Or should it be atomic? 
        // User request: "Student will get to know how much he need to pay actual college fees and aslo he got scholarship"
        // It implies scholarship happens AT allocation. Best to be atomic or immediately following.
        // Since ScholarshipService handles its own transaction for slots, we call it separately logic-wise, 
        // but ideally we should wait for it.
        
        logger.info(`Skipping scholarship allocation for student ${studentId}: eligibleScholarshipRuleId removed from Student.`);

        return { success: true, message: MESSAGES.SUCCESS.SEAT_ALLOTTED };
    },

    async verifyStudentDocument(studentId: string, documentKey: string, status: string, remarks: string | undefined) {
        if (!studentId || !documentKey || !status) {
            throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);
        }

        const existingDoc = await prisma.studentDocument.findUnique({
            where: {
                studentId_documentKey: {
                    studentId,
                    documentKey
                }
            }
        });

        if (!existingDoc) {
            throw new AppError(MESSAGES.ERROR.DOCUMENT_NOT_FOUND, 404);
        }

        const updatedDoc = await prisma.studentDocument.update({
            where: {
                studentId_documentKey: {
                    studentId,
                    documentKey
                }
            },
            data: {
                status: status as StudentDocumentStatus,
                remarks
            }
        });

        // Check if all required documents are verified
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { documents: true }
        });

        if (student) {
            const currentAdmission = await prisma.studentAdmission.findUnique({
                where: { studentId },
                select: { status: true }
            });
            const protectedStatuses: AdmissionStatus[] = [
                AdmissionStatus.SEAT_ALLOTTED,
                AdmissionStatus.ADMISSION_CONFIRMED,
                AdmissionStatus.ENROLLED
            ];
            const isProtected = currentAdmission?.status && protectedStatuses.includes(currentAdmission.status as AdmissionStatus);

            if (!isProtected) {
                if (status === StudentDocumentStatus.REJECTED) {
                    await prisma.studentAdmission.update({
                        where: { studentId },
                        data: { status: AdmissionStatus.DOCUMENTS_PENDING }
                    });
                } else {
                    const requirements = await prisma.documentRequirement.findMany({
                        where: { degreeType: student.degreeType || '', isRequired: true }
                    });

                    const requiredKeys = requirements.map(r => r.documentKey);
                    const verifiedKeys = student.documents
                        .filter(d => d.status === StudentDocumentStatus.APPROVED)
                        .map(d => d.documentKey);

                    const allVerified = requiredKeys.every(key => verifiedKeys.includes(key));

                    if (allVerified) {
                        await prisma.studentAdmission.update({
                            where: { studentId },
                            data: { status: AdmissionStatus.DOCUMENTS_VERIFIED }
                        });
                    }
                }
            }
        }

        return updatedDoc;
    },

    /**
     * Request a BRANCH change — same degree program, different branch/specialization.
     * e.g. B.Tech CSE → B.Tech ECE
     */
    async requestBranchChange(studentId: string, newCourseId: string, reason: string, recommendedByManagement: boolean = false, branchChangeFee: number = 0) {
        if (!studentId || !newCourseId || !reason) {
            throw new AppError('studentId, newCourseId and reason are required', 400);
        }

        // Prevent duplicate pending requests
        const pendingRequest = await prisma.courseChangeRequest.findFirst({
            where: { studentId, status: { in: [RequestStatus.REQUESTED, RequestStatus.FORWARDED] } },
            select: { id: true }
        });
        if (pendingRequest) {
            throw new AppError(`A course/branch change request is already pending for this student (ID: ${pendingRequest.id}). Approve or reject it before raising a new one.`, 409);
        }

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: { include: { allottedCourse: true } } }
        });

        if (!student || !student.admissionDetails?.allottedCourseId) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NO_ALLOTTED_COURSE, 400);
        }

        const oldCourse = student.admissionDetails.allottedCourse;
        const newCourse = await prisma.course.findUnique({ where: { id: newCourseId } });
        if (!newCourse) throw new AppError('Target course not found', 404);

        // Validate: must be the SAME degree program
        if (oldCourse?.degree !== newCourse.degree) {
            throw new AppError(
                `Branch change requires the same degree program. Old: "${oldCourse?.degree}", New: "${newCourse.degree}". Use Program Change for cross-program transfers.`,
                400
            );
        }

        // Must not be the same course
        if (oldCourse?.id === newCourseId) {
            throw new AppError('The new branch must be different from the current branch.', 400);
        }

        return await prisma.courseChangeRequest.create({
            data: {
                studentId,
                fromCourse: oldCourse!.id,
                toCourse: newCourseId,
                fromDegree: oldCourse?.degree,
                toDegree: newCourse.degree,
                reason,
                recommendedByManagement,
                branchChangeFee: recommendedByManagement ? branchChangeFee : 0,
                status: RequestStatus.FORWARDED,
                forwardedTo: 'SUPER_ADMIN'
            } as any
        });
    },

    /**
     * Request a PROGRAM change — cross-program transfer.
     * Allowed combinations:
     * B.Tech ↔ BBA | M.Tech ↔ MBA | M.Tech ↔ MCA | MBA ↔ MCA
     */
    async requestProgramChange(studentId: string, newCourseId: string, reason: string) {
        if (!studentId || !newCourseId || !reason) {
            throw new AppError('studentId, newCourseId and reason are required', 400);
        }

        // Prevent duplicate pending requests
        const pendingRequest = await prisma.courseChangeRequest.findFirst({
            where: { studentId, status: { in: [RequestStatus.REQUESTED, RequestStatus.FORWARDED] } },
            select: { id: true }
        });
        if (pendingRequest) {
            throw new AppError(`A course/branch change request is already pending for this student (ID: ${pendingRequest.id}). Approve or reject it before raising a new one.`, 409);
        }

        // Allowed cross-program transfers (bidirectional)
        const ALLOWED_PROGRAM_CHANGES: [string, string][] = [
            ['B.TECH', 'BBA'],
            ['BBA', 'B.TECH'],
            ['M.TECH', 'MBA'],
            ['MBA', 'M.TECH'],
            ['M.TECH', 'MCA'],
            ['MCA', 'M.TECH'],
            ['MBA', 'MCA'],
            ['MCA', 'MBA'],
        ];

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: { include: { allottedCourse: true } } }
        });

        if (!student || !student.admissionDetails?.allottedCourseId) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NO_ALLOTTED_COURSE, 400);
        }

        const oldCourse = student.admissionDetails.allottedCourse;
        const newCourse = await prisma.course.findUnique({ where: { id: newCourseId } });
        if (!newCourse) throw new AppError('Target course not found', 404);

        const fromDegree = (oldCourse?.degree || '').toUpperCase().trim();
        const toDegree   = (newCourse.degree || '').toUpperCase().trim();

        // Validate: must be a DIFFERENT degree
        if (fromDegree === toDegree) {
            throw new AppError(
                `Program change requires different degree programs. Both are "${oldCourse?.degree}". Use Branch Change instead.`,
                400
            );
        }

        // Validate: combination must be in the allowed list
        const isAllowed = ALLOWED_PROGRAM_CHANGES.some(
            ([f, t]) => f === fromDegree && t === toDegree
        );
        if (!isAllowed) {
            throw new AppError(
                `Program change from "${oldCourse?.degree}" to "${newCourse.degree}" is not allowed. Allowed transfers: B.Tech↔BBA, M.Tech↔MBA, M.Tech↔MCA, MBA↔MCA.`,
                400
            );
        }

        return await prisma.courseChangeRequest.create({
            data: {
                studentId,
                fromCourse: oldCourse!.id,
                toCourse: newCourseId,
                fromDegree: oldCourse?.degree,
                toDegree: newCourse.degree,
                reason,
                status: RequestStatus.FORWARDED,
                forwardedTo: 'SUPER_ADMIN'
            } as any
        });
    },

    async requestCourseChange(studentId: string, newCourseId: string, reason: string) {
        if (!studentId || !newCourseId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_NEWCOURSE_REASON_REQUIRED, 400);

        // Prevent duplicate pending requests
        const pendingRequest = await prisma.courseChangeRequest.findFirst({
            where: { studentId, status: { in: [RequestStatus.REQUESTED, RequestStatus.FORWARDED] } },
            select: { id: true }
        });
        if (pendingRequest) {
            throw new AppError(`A course/branch change request is already pending for this student (ID: ${pendingRequest.id}). Approve or reject it before raising a new one.`, 409);
        }

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: { include: { allottedCourse: true } } }
        });

        if (!student || !student.admissionDetails?.allottedCourseId) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NO_ALLOTTED_COURSE, 400);
        }

        const newCourse = await prisma.course.findUnique({ where: { id: newCourseId } });
        if (!newCourse) throw new AppError('New course not found', 404);

        const oldCourse = student.admissionDetails.allottedCourse;

        return await prisma.courseChangeRequest.create({
            data: {
                studentId,
                fromCourse: oldCourse!.id,
                toCourse: newCourseId,
                fromDegree: oldCourse?.degree,
                toDegree: newCourse.degree,
                reason,
                status: RequestStatus.FORWARDED,
                forwardedTo: 'SUPER_ADMIN'
            } as any
        });
    },


    async approveCourseChange(requestId: string, approved: boolean, adminRole: string | undefined, adminId: string | undefined, recommendedByManagement?: boolean, branchChangeFee?: number) {
        if (adminRole !== Role.SUPER_ADMIN) {
            throw new AppError(MESSAGES.ERROR.ONLY_SUPER_ADMIN_APPROVE_COURSE, 403);
        }

        if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

        const request = await prisma.courseChangeRequest.findUnique({ where: { id: requestId } });
        if (!request) throw new AppError(MESSAGES.ERROR.REQUEST_NOT_FOUND, 404);

        // #2 FIX: Prevent double-processing
        if (request.status === RequestStatus.APPROVED || request.status === RequestStatus.REJECTED) {
            throw new AppError(`This request has already been ${request.status.toLowerCase()}`, 400);
        }

        const status = approved ? RequestStatus.APPROVED : RequestStatus.REJECTED;

        // Build update data for the request
        const updateData: any = {
            status,
            actionedBy: adminId,
            actionedAt: new Date()
        };
        if (recommendedByManagement !== undefined) {
            updateData.recommendedByManagement = recommendedByManagement;
        }
        if (branchChangeFee !== undefined) {
            updateData.branchChangeFee = branchChangeFee;
        }

        await prisma.$transaction(async (tx) => {
            await tx.courseChangeRequest.update({
                where: { id: requestId },
                data: updateData
            });

            if (approved) {
                const admission = await tx.studentAdmission.findUnique({
                    where: { studentId: request.studentId },
                    select: { academicYearId: true }
                });
                if (!admission?.academicYearId) {
                    throw new AppError('Student admission / academic year not found', 404);
                }
                const ayId = admission.academicYearId;

                // Check seat capacity (per academic year) before swapping
                const toCourse = await tx.course.findUnique({ where: { id: request.toCourse } });
                if (!toCourse) throw new AppError('Target course not found', 404);
                const toCapacity = await getCourseCapacity(tx, request.toCourse, ayId);
                if (toCapacity.filledSeats >= toCapacity.totalSeats) {
                    throw new AppError(`Target course "${toCourse.code || toCourse.name}" is fully booked (${toCapacity.filledSeats}/${toCapacity.totalSeats}). Cannot process branch change.`, 400);
                }

                // 1. Update Admission
                await tx.studentAdmission.update({
                    where: { studentId: request.studentId },
                    data: { allottedCourseId: request.toCourse }
                });

                // Update Degree if changed
                if ((request as any).fromDegree !== (request as any).toDegree) {
                    await tx.student.update({
                        where: { id: request.studentId },
                        data: { degreeType: (request as any).toDegree }
                    });
                }

                await decrementCourseCapacity(tx, request.fromCourse, ayId);
                await incrementCourseCapacity(tx, request.toCourse, ayId);

                await tx.courseChangeLog.create({
                    data: {
                        studentId: request.studentId,
                        oldCourse: request.fromCourse,
                        newCourse: request.toCourse,
                        oldDegree: (request as any).fromDegree,
                        newDegree: (request as any).toDegree,
                        approvedBy: adminId || 'SUPER_ADMIN'
                    } as any
                });

                // 2. FINANCIAL RECONCILIATION
                const student = await tx.student.findUnique({
                    where: { id: request.studentId },
                    include: { admissionDetails: true }
                });

                if (!student) return;

                // Find ALL demands for this student and their successful payments
                const studentDemands = await tx.studentFeeDemand.findMany({
                    where: { studentId: request.studentId },
                    include: {
                        feeHead: true,
                        payments: { where: { status: 'SUCCESS' } }
                    }
                });

                // Determine Academic Year for reconciliation
                const academicYearId = studentDemands.find(d => (d.feeHead?.name || '').toLowerCase().includes('tuition'))?.academicYearId
                                        || student.admissionDetails?.academicYearId;

                if (!academicYearId) {
                    logger.warn(`[approveCourseChange] No academic year found for student ${request.studentId}. Skipping financial reconciliation.`);
                    return;
                }

                // Find New Course Fee Structure
                const newCourseStructures = await tx.feeStructure.findMany({
                    where: {
                        courseId: request.toCourse,
                        academicYearId
                    },
                    include: { feeHead: true }
                });

                // Track which fee heads exist in new course (for orphan cleanup)
                const newCourseHeadIds = new Set(newCourseStructures.map(s => s.feeHeadId));

                let tuitionHeadId: string | null = null;
                const totalPaidAcrossAll = studentDemands.reduce((sum, d) => sum + d.payments.reduce((ps, p) => ps + p.amount, 0), 0);

                // Process each structure in the NEW course
                for (const struct of newCourseStructures) {
                    const existingDemand = studentDemands.find(d => d.feeHeadId === struct.feeHeadId);
                    const isTuition = (struct.feeHead?.name || '').toLowerCase().includes('tuition');

                    if (isTuition) tuitionHeadId = struct.feeHeadId;

                    if (existingDemand) {
                        const oldFee = existingDemand.amount;
                        const newFee = struct.amount;
                        const currentPaid = existingDemand.payments.reduce((sum, p) => sum + p.amount, 0);

                        // Proportional Scholarship Recalibration for Tuition
                        let newScholarshipAmt = 0;
                        let newDiscountTotal = existingDemand.discountAmount || 0;
                        const studentScholarship = isTuition ? await tx.studentScholarship.findUnique({ where: { studentId: request.studentId } }) : null;
                        const scholarshipPct = studentScholarship?.scholarshipPercentage || 0;
                        if (isTuition) {
                            const oldScholarship = existingDemand.scholarshipAmount || 0;
                            const manualDiscount = Math.max(0, (existingDemand.discountAmount || 0) - oldScholarship);
                            newScholarshipAmt = scholarshipPct > 0 ? (newFee * scholarshipPct / 100) : oldScholarship;
                            newDiscountTotal = manualDiscount + newScholarshipAmt;
                        }

                        const newNetAmount = newFee - newDiscountTotal;
                        const pending = newNetAmount - currentPaid;

                        // #3 FIX: Replace remarks instead of appending
                        await tx.studentFeeDemand.update({
                            where: { id: existingDemand.id },
                            data: {
                                amount: newFee,
                                scholarshipAmount: isTuition ? newScholarshipAmt : undefined,
                                discountAmount: isTuition ? newDiscountTotal : undefined,
                                netAmount: newNetAmount,
                                status: pending <= 0 ? FeeStatus.FULL : (currentPaid > 0 ? FeeStatus.PARTIAL : FeeStatus.PENDING),
                                remarks: oldFee !== newFee
                                    ? `Course Change: Fee updated from ${oldFee} to ${newFee}`
                                    : existingDemand.remarks
                            }
                        });

                        // Sync FEE_DEMAND ledger entry with updated amount
                        if (oldFee !== newFee) {
                            const existingDemandLedger = await tx.studentLedger.findFirst({
                                where: {
                                    studentId: request.studentId,
                                    feeHeadId: struct.feeHeadId,
                                    referenceType: 'FEE_DEMAND',
                                    type: 'DEBIT'
                                }
                            });

                            if (existingDemandLedger) {
                                // #3 FIX: Clean ledger description instead of appending
                                const baseName = (struct.feeHead?.name || 'Fee');
                                await tx.studentLedger.update({
                                    where: { id: existingDemandLedger.id },
                                    data: {
                                        amount: newFee,
                                        description: `Fee: ${baseName} (Updated: ${oldFee} → ${newFee})`,
                                    }
                                });
                            }

                            logger.info(`[approveCourseChange] FEE_DEMAND ledger synced for student ${request.studentId}. ${oldFee} → ${newFee}`);
                        }

                        // Sync scholarship ledger entry with recalculated amount
                        if (isTuition) {
                            const existingScholarshipLedger = await tx.studentLedger.findFirst({
                                where: {
                                    studentId: request.studentId,
                                    feeHeadId: struct.feeHeadId,
                                    referenceType: 'SCHOLARSHIP',
                                    type: 'CREDIT'
                                }
                            });

                            if (existingScholarshipLedger) {
                                if (newScholarshipAmt > 0) {
                                    await tx.studentLedger.update({
                                        where: { id: existingScholarshipLedger.id },
                                        data: {
                                            amount: newScholarshipAmt,
                                            description: `Scholarship adjusted during course change (${studentScholarship?.scholarshipPercentage || 0}%)`,
                                        }
                                    });
                                } else {
                                    await tx.studentLedger.delete({ where: { id: existingScholarshipLedger.id } });
                                }
                            } else if (newScholarshipAmt > 0) {
                                await tx.studentLedger.create({
                                    data: {
                                        studentId: request.studentId,
                                        type: LedgerTransactionType.CREDIT,
                                        amount: newScholarshipAmt,
                                        description: `Scholarship applied during course change (${studentScholarship?.scholarshipPercentage || 0}%)`,
                                        referenceType: 'SCHOLARSHIP',
                                        referenceId: existingDemand.id,
                                        feeHeadId: struct.feeHeadId,
                                        createdBy: adminId,
                                        academicYearId: academicYearId
                                    }
                                });
                            }

                            logger.info(`[approveCourseChange] Scholarship ledger synced for student ${request.studentId}. Old: ${existingScholarshipLedger?.amount || 0}, New: ${newScholarshipAmt}`);
                        }
                    } else {
                        // Create New Demand for missing heads in the new course
                        await tx.studentFeeDemand.create({
                            data: {
                                studentId: request.studentId,
                                feeHeadId: struct.feeHeadId,
                                feeStructureId: struct.id,
                                amount: struct.amount,
                                netAmount: struct.amount,
                                academicYearId,
                                yearOfStudy: struct.yearOfStudy ?? undefined,
                                dueDate: new Date(),
                                status: FeeStatus.PENDING,
                                remarks: `Added during course change to new course structure`
                            }
                        });
                    }
                }

                // #4 FIX: Soft-delete orphaned demands (fee heads in old course but not in new course)
                for (const demand of studentDemands) {
                    if (demand.feeHeadId && !newCourseHeadIds.has(demand.feeHeadId)) {
                        const headName = demand.feeHead?.name || demand.feeHeadId;
                        const paidOnDemand = demand.payments.reduce((sum, p) => sum + p.amount, 0);

                        await tx.studentFeeDemand.update({
                            where: { id: demand.id },
                            data: {
                                isDeleted: true,
                                deletedAt: new Date(),
                                deletedBy: adminId,
                                remarks: `Removed during course change: ${headName} not in new course structure`
                            }
                        });

                        // Soft-delete the corresponding ledger entry
                        await tx.studentLedger.updateMany({
                            where: {
                                studentId: request.studentId,
                                feeHeadId: demand.feeHeadId,
                                referenceType: 'FEE_DEMAND',
                                type: 'DEBIT',
                                isDeleted: false
                            },
                            data: { isDeleted: true, deletedAt: new Date(), deletedBy: adminId }
                        });

                        logger.info(`[approveCourseChange] Orphaned demand removed: ${headName} (paid: ${paidOnDemand}) for student ${request.studentId}`);
                    }
                }

                // 3a. SETTLE existing unsettled corrections (previous branch change refunds no longer valid)
                const existingCorrections = await tx.feeCorrection.findMany({
                    where: {
                        studentId: request.studentId,
                        isSettled: false,
                        type: 'BRANCH_CHANGE_REFUND'
                    }
                });

                if (existingCorrections.length > 0) {
                    const settledIds = existingCorrections.map((c: any) => c.id);
                    const settledTotal = existingCorrections.reduce((sum: number, c: any) => sum + c.amount, 0);

                    await tx.feeCorrection.updateMany({
                        where: { id: { in: settledIds } },
                        data: {
                            isSettled: true,
                            settledAt: new Date(),
                            settledBy: adminId,
                            // #6 FIX: Handle null remarks
                            remarks: `Settled: reversed by new branch change ${request.fromCourse} → ${request.toCourse}`
                        }
                    });

                    // Reverse the old CREDIT ledger entries by adding a DEBIT
                    await tx.studentLedger.create({
                        data: {
                            studentId: request.studentId,
                            type: LedgerTransactionType.DEBIT,
                            amount: settledTotal,
                            description: `Previous branch change corrections reversed (${existingCorrections.length} entries, total: ${settledTotal})`,
                            referenceType: 'FEE_CORRECTION_REVERSAL',
                            referenceId: requestId,
                            academicYearId,
                            createdBy: adminId
                        }
                    });

                    logger.info(`[approveCourseChange] Settled ${existingCorrections.length} previous corrections for student ${request.studentId}. Reversed: ${settledTotal}`);
                }

                // 3b. FEE CORRECTION — track overpaid amount per head (carry forward to next year)
                let totalCorrectionAmount = 0;

                // Re-fetch demands after updates to get accurate amounts
                const updatedDemands = await tx.studentFeeDemand.findMany({
                    where: { studentId: request.studentId, isDeleted: false },
                    include: {
                        feeHead: true,
                        payments: { where: { status: 'SUCCESS' } }
                    }
                });

                for (const demand of updatedDemands) {
                    const newFee = demand.amount;
                    const currentPaid = demand.payments.reduce((sum, p) => sum + p.amount, 0);
                    const excessPaid = currentPaid - newFee;

                    if (excessPaid > 0 && academicYearId) {
                        const headName = demand.feeHead?.name || demand.feeHeadId || 'Unknown';

                        await tx.feeCorrection.create({
                            data: {
                                studentId: request.studentId,
                                academicYearId,
                                amount: excessPaid,
                                reason: `Branch change refund: ${headName}. Fee: ${newFee}, Paid: ${currentPaid}, Excess: ${excessPaid}`,
                                type: 'BRANCH_CHANGE_REFUND',
                                referenceId: requestId,
                                referenceType: 'COURSE_CHANGE_REQUEST',
                                remarks: `Fee head: ${headName}, Fee: ${newFee}, Paid: ${currentPaid}, Refund: ${excessPaid}`,
                                carryForward: true,
                                isSettled: false,
                                createdBy: adminId
                            }
                        });

                        // CREDIT ledger entry for the overpaid correction
                        await tx.studentLedger.create({
                            data: {
                                studentId: request.studentId,
                                type: LedgerTransactionType.CREDIT,
                                amount: excessPaid,
                                description: `Branch change refund: ${headName}. Paid ${currentPaid} against fee ${newFee}. Carry forward.`,
                                referenceType: 'FEE_CORRECTION',
                                referenceId: requestId,
                                feeHeadId: demand.feeHeadId,
                                academicYearId,
                                createdBy: adminId
                            }
                        });

                        totalCorrectionAmount += excessPaid;
                    }
                }

                if (totalCorrectionAmount > 0) {
                    logger.info(`[approveCourseChange] FeeCorrections created for student ${request.studentId}. Total refund: ${totalCorrectionAmount}, carryForward: true`);
                }

                // 4. BRANCH CHANGE FEE — DEBIT ledger entry if fee applies
                // #1 FIX: Use admin-provided value first, then fall back to request value
                const changeFee = branchChangeFee ?? (request as any).branchChangeFee ?? 0;
                if (changeFee > 0) {
                    await tx.studentLedger.create({
                        data: {
                            studentId: request.studentId,
                            type: LedgerTransactionType.DEBIT,
                            amount: changeFee,
                            description: `Branch change fee: ${request.fromCourse} → ${request.toCourse}`,
                            referenceType: 'BRANCH_CHANGE_FEE',
                            referenceId: requestId,
                            academicYearId,
                            createdBy: adminId
                        }
                    });

                    logger.info(`[approveCourseChange] Branch change fee ledger DEBIT created for student ${request.studentId}. Amount: ${changeFee}`);
                }

                logger.info(`[approveCourseChange] Full reconciliation for Student ${student.id} to Course ${request.toCourse}. TotalPaid: ${totalPaidAcrossAll}`);
            }
        });

        // Regenerate allotment order with new course details (outside transaction)
        try {
            const { generateAndSaveAllotmentOrder } = await import('../finance/payment.service');
            await generateAndSaveAllotmentOrder(request.studentId);
            logger.info(`[approveCourseChange] Allotment order regenerated for student ${request.studentId}`);
        } catch (err) {
            logger.error(`[approveCourseChange] Failed to regenerate allotment order: ${err}`);
        }
    },

    /**
     * List vacant beds in a hostel, optionally filtered by sharing/roomType/floor.
     * Used by the assignment-UI dropdown.
     */
    async getAvailableBeds(hostelId: string, filters: { sharing?: number; roomType?: string; floor?: number }) {
        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError('Hostel is deleted', 400);

        const roomWhere: any = { hostelId, isDeleted: false };
        if (filters.sharing !== undefined) roomWhere.capacity = filters.sharing;
        if (filters.roomType !== undefined) roomWhere.type = filters.roomType;
        if (filters.floor !== undefined) roomWhere.floor = filters.floor;

        const rooms = await prisma.hostelRoom.findMany({
            where: roomWhere,
            include: {
                beds: {
                    where: { allocations: { none: { status: 'ACTIVE' } } },
                    orderBy: { number: 'asc' }
                }
            },
            orderBy: [{ floor: 'asc' }, { number: 'asc' }]
        });

        const beds = rooms.flatMap(room =>
            room.beds.map(bed => ({
                bedId: bed.id,
                bedNumber: bed.number,
                roomId: room.id,
                roomNumber: room.number,
                floor: room.floor,
                capacity: room.capacity,
                roomType: room.type
            }))
        );

        return { hostelId, count: beds.length, beds };
    },

    /**
     * List students who opted for hostel (accommodationType=HOSTEL) but
     * either have no HostelAllocation row, or whose allocation is non-active
     * (e.g. CANCELLED). Used by the bed-allocation worklist UI.
     */
    async getPendingHostelAllocations(query: any) {
        const {
            page = 1,
            limit = 10,
            search,
            hostelId,
            hostelType,
            gender,
        } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;

        const where: Prisma.StudentWhereInput = {
            admissionDetails: {
                // "Wants hostel" = has a specific hostel assigned. This is the
                // load-bearing signal for bed allocation. Some legacy admissions
                // have hostelId set but accommodationType=NONE — those still
                // belong on the worklist.
                ...(hostelId ? { hostelId } : { hostelId: { not: null } }),
                ...(hostelType ? { hostelType: hostelType as HostelType } : {}),
            },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            // "Not currently allocated" = no ACTIVE allocation row (regardless of year).
            hostelAllocations: { none: { status: 'ACTIVE' } },
            ...(search
                ? {
                      AND: [
                          {
                              OR: [
                                  { name: { contains: search, mode: 'insensitive' } },
                                  { phone: { contains: search } },
                                  { applicationId: { contains: search, mode: 'insensitive' } },
                              ],
                          },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                skip,
                take: limitNum,
                orderBy: [{ createdAt: 'desc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    gender: true,
                    phone: true,
                    email: true,
                    profilePhotoUrl: true,
                    createdAt: true,
                    admissionDetails: {
                        select: {
                            status: true,
                            hostelType: true,
                            hostelPaymentMode: true,
                            hostelId: true,
                            hostel: { select: { id: true, name: true, type: true } },
                            allottedCourse: { select: { id: true, name: true } },
                        },
                    },
                    hostelAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        select: {
                            id: true, status: true, startDate: true, endDate: true,
                            academicYearId: true,
                            academicYear: { select: { id: true, code: true, isActive: true } },
                        },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const enhanced = await Promise.all(
            students.map(async (s: any) => {
                const activeAlloc = s.hostelAllocations?.[0] ?? null;
                const { hostelAllocations, ...rest } = s;
                return {
                    ...rest,
                    hostelAllocation: activeAlloc,
                    profilePhotoUrl: await convertToPresignedUrl(s.profilePhotoUrl),
                    allocationStatus: activeAlloc?.status ?? 'NOT_ALLOCATED',
                };
            })
        );

        return {
            students: enhanced,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
            },
        };
    },

    /**
     * List every student with an active bed allocation (across all hostels).
     * Used for the "all bed-allocated students" report.
     */
    async getBedAllocatedStudents(query: any) {
        const { page = 1, limit = 10, search, gender, all } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;
        const fetchAll = !!all;

        const where: Prisma.StudentWhereInput = {
            hostelAllocations: { some: { status: 'ACTIVE' } },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            ...(search
                ? {
                      OR: [
                          { name: { contains: search, mode: 'insensitive' } },
                          { phone: { contains: search } },
                          { applicationId: { contains: search, mode: 'insensitive' } },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                ...(fetchAll ? {} : { skip, take: limitNum }),
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    phone: true,
                    gender: true,
                    admissionDetails: {
                        select: {
                            hostelType: true,
                            hostelPaymentMode: true,
                            allottedCourse: { select: { id: true, name: true } },
                        },
                    },
                    hostelAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        select: {
                            id: true,
                            startDate: true,
                            bedId: true,
                            academicYearId: true,
                            academicYear: { select: { id: true, code: true, isActive: true } },
                            bed: {
                                select: {
                                    id: true,
                                    number: true,
                                    room: {
                                        select: {
                                            id: true,
                                            number: true,
                                            floor: true,
                                            capacity: true,
                                            type: true,
                                            hostel: {
                                                select: { id: true, name: true, type: true },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const shaped = students.map((s: any) => {
            const alloc = s.hostelAllocations?.[0] ?? null;
            const bed = alloc?.bed;
            const room = bed?.room;
            const hostel = room?.hostel;
            return {
                id: s.id,
                applicationId: s.applicationId,
                name: s.name,
                fatherName: s.fatherName,
                phone: s.phone,
                gender: s.gender,
                courseType: s.admissionDetails?.allottedCourse?.name ?? null,
                hostelId: hostel?.id ?? null,
                hostelName: hostel?.name ?? null,
                hostelType: hostel?.type ?? null,
                sharingType: s.admissionDetails?.hostelType ?? (room ? `SHARING_${room.capacity}` : null),
                paymentMode: s.admissionDetails?.hostelPaymentMode ?? null,
                floor: room?.floor ?? null,
                roomId: room?.id ?? null,
                roomNumber: room?.number ?? null,
                roomType: room?.type ?? null,
                bedId: bed?.id ?? null,
                bedNumber: bed?.number ?? null,
                allocatedAt: alloc?.startDate ?? null,
            };
        });

        return {
            students: shaped,
            pagination: fetchAll
                ? { total, page: 1, limit: total, totalPages: 1 }
                : {
                      total,
                      page: pageNum,
                      limit: limitNum,
                      totalPages: Math.ceil(total / limitNum),
                  },
        };
    },

    /**
     * List every student with a transportRouteId set, with route fee + paid breakdown.
     * Used for the "all transport-allocated students" report.
     */
    async getTransportAllocatedStudents(query: any) {
        const { page = 1, limit = 10, search, gender, routeId, all } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;
        const fetchAll = !!all;

        const where: Prisma.StudentWhereInput = {
            AND: [
                {
                    admissionDetails: routeId
                        ? { transportRouteId: routeId }
                        : { transportRouteId: { not: null } },
                },
                ...(gender ? [{ gender: { equals: gender, mode: 'insensitive' as const } }] : []),
                ...(search
                    ? [
                          {
                              OR: [
                                  { name: { contains: search, mode: 'insensitive' as const } },
                                  { phone: { contains: search } },
                                  { applicationId: { contains: search, mode: 'insensitive' as const } },
                                  { admissionDetails: { transportRoute: { name: { contains: search, mode: 'insensitive' as const } } } },
                                  { admissionDetails: { transportRoute: { city: { contains: search, mode: 'insensitive' as const } } } },
                              ],
                          },
                      ]
                    : []),
            ],
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                ...(fetchAll ? {} : { skip, take: limitNum }),
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    phone: true,
                    gender: true,
                    degreeType: true,
                    admissionDetails: {
                        select: {
                            transportRouteId: true,
                            allottedCourse: { select: { id: true, name: true } },
                            transportRoute: {
                                select: { id: true, name: true, cost: true, busNumber: true, city: true },
                            },
                        },
                    },
                    feeDemands: {
                        where: {
                            isDeleted: false,
                            feeHead: { component: PaymentComponent.TRANSPORT },
                        },
                        select: { netAmount: true, amount: true, status: true },
                    },
                    payments: {
                        where: {
                            component: PaymentComponent.TRANSPORT,
                            status: PaymentStatus.SUCCESS,
                            isDeleted: false,
                        },
                        select: { amount: true },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const shaped = students.map((s: any) => {
            const route = s.admissionDetails?.transportRoute;
            const demandTotal = (s.feeDemands as any[]).reduce(
                (sum, d) => sum + (d.netAmount ?? d.amount ?? 0),
                0
            );
            const paidTotal = (s.payments as any[]).reduce(
                (sum, p) => sum + (p.amount ?? 0),
                0
            );
            // Route fee: prefer the frozen demand amount; fall back to route.cost
            // (covers students who have transportRouteId set but no demand yet).
            const transportRouteFee = demandTotal > 0 ? demandTotal : (route?.cost ?? 0);
            return {
                id: s.id,
                applicationId: s.applicationId,
                name: s.name,
                fatherName: s.fatherName,
                phone: s.phone,
                gender: s.gender,
                degreeType: s.degreeType,
                courseName: s.admissionDetails?.allottedCourse?.name ?? null,
                routeId: route?.id ?? null,
                routeName: route?.name ?? null,
                busNumber: route?.busNumber ?? null,
                city: route?.city ?? null,
                transportRouteFee,
                transportFeePaid: paidTotal,
                balance: Math.max(0, transportRouteFee - paidTotal),
            };
        });

        return {
            students: shaped,
            pagination: fetchAll
                ? { total, page: 1, limit: total, totalPages: 1 }
                : {
                      total,
                      page: pageNum,
                      limit: limitNum,
                      totalPages: Math.ceil(total / limitNum),
                  },
        };
    },

    /**
     * List all students with accommodationType=HOSTEL who have paid at least
     * ₹1 toward any hostel-tagged component (HOSTEL / HOSTEL_ACCOMMODATION /
     * HOSTEL_MESS / HOSTEL_LAUNDRY / HOSTEL_REGISTRATION).
     * No hostelId filter — spans all hostels.
     */
    async getHostelPaidStudents(query: any) {
        const { page = 1, limit = 10, search, gender, hostelType, all } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;
        const fetchAll = !!all;

        const hostelComponents = [
            PaymentComponent.HOSTEL,
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ];

        const where: Prisma.StudentWhereInput = {
            admissionDetails: {
                accommodationType: AccommodationType.HOSTEL,
                ...(hostelType ? { hostelType: hostelType as HostelType } : {}),
            },
            // At least one successful hostel-tagged payment exists for this student.
            payments: {
                some: {
                    component: { in: hostelComponents },
                    status: PaymentStatus.SUCCESS,
                    isDeleted: false,
                    amount: { gt: 0 },
                },
            },
            // Exclude students who already have an ACTIVE bed allocation (in any year).
            hostelAllocations: { none: { status: 'ACTIVE' } },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            ...(search
                ? {
                      OR: [
                          { name: { contains: search, mode: 'insensitive' } },
                          { phone: { contains: search } },
                          { applicationId: { contains: search, mode: 'insensitive' } },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                ...(fetchAll ? {} : { skip, take: limitNum }),
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    phone: true,
                    gender: true,
                    degreeType: true,
                    admissionDetails: {
                        select: {
                            hostelType: true,
                            hostelPaymentMode: true,
                            roomNumber: true,
                            hostelId: true,
                            hostel: { select: { id: true, name: true, type: true } },
                            allottedCourse: { select: { id: true, name: true } },
                        },
                    },
                    feeDemands: {
                        where: {
                            isDeleted: false,
                            feeHead: { component: { in: hostelComponents } },
                        },
                        select: { netAmount: true, amount: true },
                    },
                    payments: {
                        where: {
                            component: { in: hostelComponents },
                            status: PaymentStatus.SUCCESS,
                            isDeleted: false,
                        },
                        select: { amount: true },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const shaped = students.map((s: any) => {
            const hostelDemandTotal = (s.feeDemands as any[]).reduce(
                (sum, d) => sum + (d.netAmount ?? d.amount ?? 0),
                0
            );
            const hostelPaid = (s.payments as any[]).reduce(
                (sum, p) => sum + (p.amount ?? 0),
                0
            );
            return {
                id: s.id,
                applicationId: s.applicationId,
                name: s.name,
                fatherName: s.fatherName,
                phone: s.phone,
                gender: s.gender,
                degreeType: s.degreeType,
                courseName: s.admissionDetails?.allottedCourse?.name ?? null,
                hostelId: s.admissionDetails?.hostel?.id ?? null,
                hostelName: s.admissionDetails?.hostel?.name ?? null,
                hostelType: s.admissionDetails?.hostelType ?? null,
                hostelPaymentMode: s.admissionDetails?.hostelPaymentMode ?? null,
                roomNumber: s.admissionDetails?.roomNumber ?? null,
                hostelTotal: hostelDemandTotal,
                hostelPaid,
                balance: Math.max(0, hostelDemandTotal - hostelPaid),
            };
        });

        return {
            students: shaped,
            pagination: fetchAll
                ? { total, page: 1, limit: total, totalPages: 1 }
                : {
                      total,
                      page: pageNum,
                      limit: limitNum,
                      totalPages: Math.ceil(total / limitNum),
                  },
        };
    },

    /**
     * List all students with accommodationType=TRANSPORT who have paid at least
     * ₹1 toward the TRANSPORT component. Optional routeId filters to a single route.
     */
    async getTransportPaidStudents(query: any) {
        const { page = 1, limit = 10, search, gender, routeId, all } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;
        const fetchAll = !!all;

        const where: Prisma.StudentWhereInput = {
            admissionDetails: {
                accommodationType: AccommodationType.TRANSPORT,
                ...(routeId ? { transportRouteId: routeId } : {}),
            },
            // At least one successful TRANSPORT payment exists for this student.
            payments: {
                some: {
                    component: PaymentComponent.TRANSPORT,
                    status: PaymentStatus.SUCCESS,
                    isDeleted: false,
                    amount: { gt: 0 },
                },
            },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            ...(search
                ? {
                      OR: [
                          { name: { contains: search, mode: 'insensitive' } },
                          { phone: { contains: search } },
                          { applicationId: { contains: search, mode: 'insensitive' } },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                ...(fetchAll ? {} : { skip, take: limitNum }),
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    phone: true,
                    gender: true,
                    degreeType: true,
                    admissionDetails: {
                        select: {
                            transportRouteId: true,
                            allottedCourse: { select: { id: true, name: true } },
                            transportRoute: {
                                select: { id: true, name: true, cost: true, busNumber: true, city: true },
                            },
                        },
                    },
                    feeDemands: {
                        where: {
                            isDeleted: false,
                            feeHead: { component: PaymentComponent.TRANSPORT },
                        },
                        select: { netAmount: true, amount: true },
                    },
                    payments: {
                        where: {
                            component: PaymentComponent.TRANSPORT,
                            status: PaymentStatus.SUCCESS,
                            isDeleted: false,
                        },
                        select: { amount: true },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const shaped = students.map((s: any) => {
            const route = s.admissionDetails?.transportRoute;
            const demandTotal = (s.feeDemands as any[]).reduce(
                (sum, d) => sum + (d.netAmount ?? d.amount ?? 0),
                0
            );
            const paidTotal = (s.payments as any[]).reduce(
                (sum, p) => sum + (p.amount ?? 0),
                0
            );
            const transportRouteFee = demandTotal > 0 ? demandTotal : (route?.cost ?? 0);
            return {
                id: s.id,
                applicationId: s.applicationId,
                name: s.name,
                fatherName: s.fatherName,
                phone: s.phone,
                gender: s.gender,
                degreeType: s.degreeType,
                courseName: s.admissionDetails?.allottedCourse?.name ?? null,
                routeId: route?.id ?? null,
                routeName: route?.name ?? null,
                busNumber: route?.busNumber ?? null,
                city: route?.city ?? null,
                transportRouteFee,
                transportFeePaid: paidTotal,
                balance: Math.max(0, transportRouteFee - paidTotal),
            };
        });

        return {
            students: shaped,
            pagination: fetchAll
                ? { total, page: 1, limit: total, totalPages: 1 }
                : {
                      total,
                      page: pageNum,
                      limit: limitNum,
                      totalPages: Math.ceil(total / limitNum),
                  },
        };
    },

    /**
     * List all students assigned to a hostel (allocated or not).
     * Used by the hostel-detail roster view.
     */
    async getStudentsByHostel(hostelId: string, query: any) {
        const {
            page = 1,
            limit = 10,
            search,
            hostelType,
            gender,
            allottedCourseId,
            allocationStatus,
        } = query;

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 10;
        const skip = (pageNum - 1) * limitNum;

        const hostel = await prisma.hostel.findUnique({
            where: { id: hostelId },
            select: { id: true, name: true, type: true, isDeleted: true }
        });
        if (!hostel || hostel.isDeleted) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

        const allocationFilter: Prisma.StudentWhereInput = (() => {
            if (allocationStatus === 'ALLOCATED') {
                return { hostelAllocations: { some: { status: 'ACTIVE' } } };
            }
            if (allocationStatus === 'NOT_ALLOCATED') {
                return { hostelAllocations: { none: { status: 'ACTIVE' } } };
            }
            return {};
        })();

        const where: Prisma.StudentWhereInput = {
            admissionDetails: {
                hostelId,
                ...(hostelType ? { hostelType: hostelType as HostelType } : {}),
                ...(allottedCourseId ? { allottedCourseId } : {}),
            },
            ...(gender ? { gender: { equals: gender, mode: 'insensitive' } } : {}),
            ...allocationFilter,
            ...(search
                ? {
                      AND: [
                          {
                              OR: [
                                  { name: { contains: search, mode: 'insensitive' } },
                                  { phone: { contains: search } },
                                  { applicationId: { contains: search, mode: 'insensitive' } },
                              ],
                          },
                      ],
                  }
                : {}),
        };

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                skip,
                take: limitNum,
                orderBy: [{ name: 'asc' }],
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    fatherName: true,
                    motherName: true,
                    gender: true,
                    phone: true,
                    profilePhotoUrl: true,
                    admissionDetails: {
                        select: {
                            hostelType: true,
                            roomNumber: true,
                            hostelPaymentMode: true,
                            allottedCourse: { select: { id: true, name: true } },
                        },
                    },
                    hostelAllocations: {
                        where: { status: 'ACTIVE' },
                        take: 1,
                        orderBy: { startDate: 'desc' },
                        select: {
                            status: true,
                            startDate: true,
                            academicYearId: true,
                            academicYear: { select: { id: true, code: true, isActive: true } },
                            bed: {
                                select: {
                                    number: true,
                                    room: {
                                        select: { id: true, number: true, capacity: true, type: true, floor: true },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
            prisma.student.count({ where }),
        ]);

        const enhanced = await Promise.all(
            students.map(async (s) => {
                const activeAlloc = (s as any).hostelAllocations?.[0] ?? null;
                return {
                    applicationId: s.applicationId,
                    name: s.name,
                    fatherName: s.fatherName,
                    motherName: s.motherName,
                    gender: s.gender,
                    phone: s.phone,
                    profilePhotoUrl: await convertToPresignedUrl(s.profilePhotoUrl),
                    hostelType: s.admissionDetails?.hostelType ?? null,
                    hostelPaymentMode: s.admissionDetails?.hostelPaymentMode ?? null,
                    roomNumber:
                        activeAlloc?.bed?.room?.number
                        ?? s.admissionDetails?.roomNumber
                        ?? null,
                    bedNumber: activeAlloc?.bed?.number ?? null,
                    floor: activeAlloc?.bed?.room?.floor ?? null,
                    allottedCourse: s.admissionDetails?.allottedCourse?.name ?? null,
                    allocationStatus: activeAlloc?.status ?? 'NOT_ALLOCATED',
                    allocatedAt: activeAlloc?.startDate ?? null,
                };
            })
        );

        return {
            hostel: { id: hostel.id, name: hostel.name, type: hostel.type },
            students: enhanced,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
            },
        };
    },

    /**
     * Allocate a specific bed to a student who already has accommodationType=HOSTEL.
     * Atomically:
     *   - Validates student + bed eligibility
     *   - Updates StudentAdmission { hostelType, roomNumber }
     *   - Creates HostelAllocation row, marks bed occupied
     *   - Snapshots pricing into StudentAccommodationPricing
     *   - Creates StudentFeeDemand rows (one per fee component)
     *   - Increments StudentAdmission.totalFee
     */
    async allocateBed(studentId: string, bedId: string, hostelIdFromBody: string | undefined, _academicYearIdInput: string | undefined, adminId: string | undefined) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'allocate bed');
        assertHostelAccommodation(ctx.admission, 'Run assign-hostel first.');
        assertNoBedAllocated(ctx.accommodationPricing as any, 'Use re-allocation flow.'); // legacy guard kept; superseded by HostelAllocation lookup below
        const admission = ctx.admission!;
        if (!ctx.accommodationPricing) {
            throw new AppError('No pricing snapshot. Run assign-hostel first.', 400);
        }
        const existingAllocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });
        if (existingAllocation) {
            throw new AppError('Student already has an active bed allocation. Use the reassign-hostel flow.', 409);
        }

        const bed = await prisma.hostelBed.findUnique({
            where: { id: bedId },
            include: { room: true, allocations: { where: { status: 'ACTIVE' }, take: 1 } }
        });
        if (!bed) throw new AppError('Bed not found', 404);
        if ((bed as any).allocations?.length > 0) throw new AppError('Bed is already allocated to another student', 409);
        if (bed.room.isDeleted) throw new AppError('Cannot allocate a bed in a deleted room', 400);

        // hostelId resolution & consistency check:
        // Body-provided > admission.hostelId. Bed's room must belong to the resolved hostelId.
        const targetHostelId = hostelIdFromBody ?? admission.hostelId;
        if (!targetHostelId) {
            throw new AppError('Student has no hostel assigned. Pass hostelId in body or run assign-hostel first.', 400);
        }
        if (bed.room.hostelId !== targetHostelId) {
            throw new AppError("Bed does not belong to the assigned hostel", 400);
        }
        if (admission.hostelId && hostelIdFromBody && admission.hostelId !== hostelIdFromBody) {
            throw new AppError(`hostelId mismatch: admission has ${admission.hostelId}, body has ${hostelIdFromBody}`, 400);
        }

        // Snapshot's sharing tier must match the bed's room capacity.
        if (bed.room.capacity !== ctx.accommodationPricing.sharing) {
            throw new AppError(
                `Snapshot is for SHARING_${ctx.accommodationPricing.sharing} but bed is in a ${bed.room.capacity}-sharing room. Re-run assign-hostel with the correct hostelType.`,
                400
            );
        }

        const result = await prisma.$transaction(async (tx) => {
            // academicYearId is required (per-year allocation history). Fail fast if no active year.
            const hostelAllocYearId = (await getActiveAcademicYear(tx)).id;
            // Upsert by (studentId, academicYearId): re-allocating in the same year (after a
            // prior VACATED row in that year) updates the existing row instead of failing.
            await (tx.hostelAllocation as any).upsert({
                where: { studentId_academicYearId: { studentId, academicYearId: hostelAllocYearId } },
                create: {
                    studentId,
                    bedId,
                    startDate: new Date(),
                    status: 'ACTIVE',
                    academicYearId: hostelAllocYearId,
                    createdBy: adminId
                },
                update: {
                    bedId,
                    startDate: new Date(),
                    endDate: null,
                    status: 'ACTIVE',
                    updatedBy: adminId
                }
            });

            await tx.hostelBed.update({
                where: { id: bedId },
                data: { isOccupied: true, updatedBy: adminId }
            });

            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    hostelId: targetHostelId,             // persist (idempotent if already set)
                    roomNumber: bed.room.number,
                }
            });

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'BED_ALLOCATED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        bedId, bedNumber: bed.number,
                        roomId: bed.room.id, roomNumber: bed.room.number,
                        hostelId: targetHostelId,
                        hostelType: admission.hostelType,
                        hostelIdSource: hostelIdFromBody ? 'body' : 'admission',
                    }
                }
            });

            return {
                allocation: { studentId, bedId, hostelId: targetHostelId, roomNumber: bed.room.number, hostelType: admission.hostelType },
            };
        });

        // Generate hostel allotment order PDF (best-effort, post-transaction).
        generateAndSaveHostelAllotmentOrder(studentId).catch(() => { /* logged inside */ });

        return result;
    },

    /**
     * Bulk-allocate vacant beds in ONE room to a list of students.
     *
     * Use case: admin picks a room with N vacant beds + provides up to N student IDs.
     * System fills the beds in order (`bed.number` ASC).
     *
     * Pre-validates everyone first, then executes the whole batch atomically.
     * If ANY student fails validation, NONE are allocated — admin fixes the input list and retries.
     *
     * Each successful student gets:
     *   - StudentAdmission updated (accommodationType=HOSTEL, hostelId, hostelType, roomNumber, paymentMode, totalFee+=effectiveTotal)
     *   - HostelAllocation row created (status=ACTIVE)
     *   - HostelBed marked occupied
     *   - StudentAccommodationPricing snapshot created
     *   - StudentFeeDemand rows created (per available FeeHead)
     */
    async bulkAllocateRoomBeds(
        roomId: string,
        studentIds: string[],
        _academicYearIdInput: string | undefined,
        adminId: string | undefined
    ) {
        // 1. Validate room. "Vacant" = bed has no ACTIVE allocation (VACATED rows from prior years are OK).
        const room = await prisma.hostelRoom.findUnique({
            where: { id: roomId },
            include: {
                hostel: true,
                beds: {
                    where: { allocations: { none: { status: 'ACTIVE' } } },
                    orderBy: { number: 'asc' },
                    include: { allocations: { where: { status: 'ACTIVE' }, take: 1 } }
                }
            }
        });
        if (!room) throw new AppError('Room not found', 404);
        if (room.isDeleted) throw new AppError('Cannot allocate beds in a deleted room', 400);
        if (room.hostel.isDeleted) throw new AppError("Cannot allocate beds in a deleted hostel", 400);

        const vacantBeds = room.beds;
        if (vacantBeds.length === 0) {
            throw new AppError('No vacant beds in this room', 400);
        }
        if (studentIds.length > vacantBeds.length) {
            throw new AppError(
                `Room has ${vacantBeds.length} vacant bed(s) but ${studentIds.length} students supplied. Reduce the list or pick another room.`,
                400
            );
        }

        const hostelId = room.hostelId;
        const sharing = room.capacity;
        const hostelType = `SHARING_${sharing}` as HostelType;

        // 2. Validate every student up-front. Pricing was set at assign-hostel,
        // so we just verify each student has a snapshot matching this room's sharing tier.
        const students = await prisma.student.findMany({
            where: { id: { in: studentIds } },
            include: {
                admissionDetails: true,
                accommodationPricing: { where: { isActive: true }, take: 1 }
            } as any
        }) as any[];

        const studentMap = new Map(students.map(s => [s.id, s]));
        const validationErrors: { studentId: string; reason: string }[] = [];

        // Only ACTIVE allocations matter for blocking — VACATED rows are historical.
        const allocations = await prisma.hostelAllocation.findMany({
            where: { studentId: { in: studentIds }, status: 'ACTIVE' }
        });
        const allocByStudent = new Map(allocations.map(a => [a.studentId, a]));

        for (const sid of studentIds) {
            const s = studentMap.get(sid);
            if (!s) { validationErrors.push({ studentId: sid, reason: 'Student not found' }); continue; }
            if (!s.admissionDetails) {
                validationErrors.push({ studentId: sid, reason: 'No admission record' });
                continue;
            }
            if (s.admissionDetails.status === AdmissionStatus.CANCELLED) {
                validationErrors.push({ studentId: sid, reason: 'Admission is cancelled' });
                continue;
            }
            const existingAlloc = allocByStudent.get(sid);
            if (existingAlloc) {
                validationErrors.push({ studentId: sid, reason: 'Already has an active bed allocation' });
                continue;
            }
            if (s.admissionDetails.accommodationType !== AccommodationType.HOSTEL) {
                validationErrors.push({
                    studentId: sid,
                    reason: `accommodationType is ${s.admissionDetails.accommodationType}, expected HOSTEL. Run assign-hostel first.`
                });
                continue;
            }
            if (!s.admissionDetails.hostelId) {
                validationErrors.push({ studentId: sid, reason: 'No hostel assigned. Run assign-hostel first.' });
                continue;
            }
            if (s.admissionDetails.hostelId !== hostelId) {
                validationErrors.push({
                    studentId: sid,
                    reason: `Assigned to a different hostel (${s.admissionDetails.hostelId}). Reassign first.`
                });
                continue;
            }
            const activePricing = s.accommodationPricing?.[0];
            if (!activePricing) {
                validationErrors.push({
                    studentId: sid,
                    reason: 'No pricing snapshot. Run assign-hostel first.'
                });
                continue;
            }
            if (activePricing.sharing !== sharing) {
                validationErrors.push({
                    studentId: sid,
                    reason: `Snapshot is for SHARING_${activePricing.sharing} but room is SHARING_${sharing}. Re-run assign-hostel with the correct hostelType.`
                });
                continue;
            }
        }

        if (validationErrors.length > 0) {
            return {
                success: false,
                phase: 'PRE_VALIDATION',
                roomId,
                roomNumber: room.number,
                hostelId,
                requested: studentIds.length,
                vacantBedsAvailable: vacantBeds.length,
                allocated: 0,
                errors: validationErrors,
                message: 'No students were allocated. Fix the validation errors above and retry.'
            };
        }

        // Pair students with beds (in input order)
        const pairs = studentIds.map((sid, idx) => ({
            studentId: sid,
            bed: vacantBeds[idx]
        }));

        const allocated: any[] = [];
        await prisma.$transaction(async (tx) => {
            // academicYearId is required now (per-year history). Fail fast if no active year configured.
            const hostelAllocYearId = (await getActiveAcademicYear(tx)).id;
            for (const { studentId, bed } of pairs) {
                const student = studentMap.get(studentId)!;

                // Upsert by (studentId, academicYearId): if the student previously VACATED in this
                // same year, reuse that row instead of failing the composite unique.
                await (tx.hostelAllocation as any).upsert({
                    where: { studentId_academicYearId: { studentId, academicYearId: hostelAllocYearId } },
                    create: {
                        studentId,
                        bedId: bed.id,
                        startDate: new Date(),
                        status: 'ACTIVE',
                        academicYearId: hostelAllocYearId,
                        createdBy: adminId
                    },
                    update: {
                        bedId: bed.id,
                        startDate: new Date(),
                        endDate: null,
                        status: 'ACTIVE',
                        updatedBy: adminId
                    }
                });

                await tx.hostelBed.update({
                    where: { id: bed.id },
                    data: { isOccupied: true, updatedBy: adminId }
                });

                await tx.studentAdmission.update({
                    where: { studentId },
                    data: { roomNumber: room.number }
                });

                await tx.auditLog.create({
                    data: {
                        userId: adminId,
                        action: 'BED_ALLOCATED_BULK',
                        entity: 'StudentAdmission',
                        entityId: studentId,
                        details: {
                            bedId: bed.id, bedNumber: bed.number,
                            roomId, roomNumber: room.number,
                            hostelId,
                            hostelType,
                            sharing,
                            batchSize: pairs.length,
                        }
                    }
                });

                allocated.push({
                    studentId,
                    studentName: student.name,
                    bedId: bed.id,
                    bedNumber: bed.number,
                });
            }
        }, { timeout: 60000 });

        // Generate hostel allotment orders for each allocated student (best-effort, post-transaction).
        for (const a of allocated) {
            generateAndSaveHostelAllotmentOrder(a.studentId).catch(() => { /* logged inside */ });
        }

        return {
            success: true,
            phase: 'COMPLETED',
            roomId,
            roomNumber: room.number,
            hostelId,
            hostelType,
            requested: studentIds.length,
            allocated: allocated.length,
            remainingVacantInRoom: vacantBeds.length - allocated.length,
            allocations: allocated,
        };
    },

    /**
     * Re-assign a student to a different hostel/bed AFTER initial bed allocation.
     * Atomically:
     *   - Vacates old bed (HostelAllocation status flips to ACTIVE on new bed; old bed isOccupied=false)
     *   - Updates StudentAdmission (hostelId, hostelType, roomNumber, paymentMode, totalFee delta)
     *   - Replaces StudentAccommodationPricing snapshot
     *   - Soft-deletes outstanding hostel fee demands (paid history preserved)
     *   - Creates new fee demands for new pricing
     *   - Writes a StudentLedger entry for the audit trail
     */
    async reassignHostel(
        studentId: string,
        args: { hostelId: string; bedId: string; hostelPaymentMode: 'YEARWISE' | 'SEMWISE'; reason: string },
        adminId: string | undefined
    ) {
        // 1. Validate student
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'reassign hostel');
        assertHostelAccommodation(ctx.admission, 'Use assign-hostel + allocate-bed first.');
        const admission = ctx.admission!;
        const oldPricing = ctx.accommodationPricing;
        if (!oldPricing) {
            throw new AppError('Student has no allocated bed yet. Use allocate-bed first.', 400);
        }
        // Reject if the year these demands belong to has been closed.
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        // 2. Find old allocation (the current ACTIVE row regardless of year)
        const oldAllocation = await (prisma.hostelAllocation as any).findFirst({
            where: { studentId, status: 'ACTIVE' },
            include: { bed: { include: { room: true } } }
        });
        if (!oldAllocation) throw new AppError('No active bed allocation found', 404);

        // 3. Validate new bed
        const newBed = await prisma.hostelBed.findUnique({
            where: { id: args.bedId },
            include: { room: true, allocations: { where: { status: 'ACTIVE' }, take: 1 } }
        });
        if (!newBed) throw new AppError('New bed not found', 404);
        if (newBed.room.isDeleted) throw new AppError('Cannot allocate a bed in a deleted room', 400);
        if (newBed.room.hostelId !== args.hostelId) {
            throw new AppError('Bed does not belong to the selected hostel', 400);
        }
        // Allow same bed (paymentMode-only change), but block if different student holds it
        const newBedActive = (newBed as any).allocations?.[0];
        if (newBedActive && newBed.id !== oldAllocation.bedId) {
            throw new AppError('New bed is already allocated to another student', 409);
        }

        // 4. Validate new hostel
        const newHostel = await prisma.hostel.findUnique({ where: { id: args.hostelId } });
        if (!newHostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (newHostel.isDeleted) throw new AppError('Cannot reassign to a deleted hostel', 400);

        // Capacity check only if moving to a different hostel
        if (args.hostelId !== oldPricing.hostelId) {
            await assertHostelHasCapacity(args.hostelId);
        }

        // 5. Compute new pricing — year-scoped (falls back to legacy year-null row)
        const sharing = newBed.room.capacity;
        const roomType = newBed.room.type;
        const priceCategory = await resolveHostelPriceCategory(
            { sharing, roomType, academicYearId: admission.academicYearId }
        );
        if (!priceCategory) {
            throw new AppError(`No active price tier found for sharing=${sharing}, roomType=${roomType} in academic year ${admission.academicYearId ?? '<none>'}.`, 400);
        }

        const isSemwise = args.hostelPaymentMode === 'SEMWISE';
        const accommodationPrice = ((priceCategory as any)[isSemwise ? 'accommodationSemwise' : 'accommodationYearwise']) ?? 0;
        const messPrice = ((priceCategory as any)[isSemwise ? 'messSemwise' : 'messYearwise']) ?? 0;
        const laundryPrice = ((priceCategory as any)[isSemwise ? 'laundrySemwise' : 'laundryYearwise']) ?? 0;
        const registrationFee = (priceCategory as any).registrationFee ?? 0;
        const newEffectiveTotal = accommodationPrice + messPrice + laundryPrice + registrationFee;

        const newHostelType = `SHARING_${sharing}` as HostelType;
        const oldEffectiveTotal = oldPricing.effectiveTotal ?? 0;
        const totalFeeDelta = newEffectiveTotal - oldEffectiveTotal;
        const academicYearId = oldPricing.academicYearId ?? admission.academicYearId ?? undefined;

        // 6. Resolve hostel-related FeeHeads via component tag (with name-keyword fallback)
        const feeHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const accHead = feeHeadMap.get(PaymentComponent.HOSTEL_ACCOMMODATION);
        const messHead = feeHeadMap.get(PaymentComponent.HOSTEL_MESS);
        const laundryHead = feeHeadMap.get(PaymentComponent.HOSTEL_LAUNDRY);
        const regHead = feeHeadMap.get(PaymentComponent.HOSTEL_REGISTRATION);

        const hostelHeadIds = [accHead?.id, messHead?.id, laundryHead?.id, regHead?.id].filter(Boolean) as string[];

        // 7. Atomic transition. Uses Serializable isolation so two concurrent reassign
        // calls can't both read the same `availableCredit` and create duplicate
        // FeeCorrection refunds. Postgres will retry one if they collide.
        const result = await prisma.$transaction(async (tx) => {
            // 7a. Compute available hostel credit INSIDE the tx (was outside — race condition).
            // availableCredit = grossPaid − sum(prior FeeCorrection refunds, settled + pending).
            // See `getAvailableHostelCredit` in studentContext.ts.
            const credit          = await getAvailableHostelCredit(studentId, tx);
            const hostelPaid      = credit.grossPaid;
            const availableCredit = credit.availableCredit;
            const appliedToNew    = Math.min(availableCredit, newEffectiveTotal);
            const leftoverRefund  = Math.max(0, availableCredit - newEffectiveTotal);

            // Distribute appliedToNew proportionally across the 4 new demands.
            // Last (registration) absorbs rounding so discounts sum exactly to appliedToNew.
            const distribute = (componentPrice: number) =>
                newEffectiveTotal > 0 ? Math.round((componentPrice / newEffectiveTotal) * appliedToNew) : 0;
            const accDiscount     = distribute(accommodationPrice);
            const messDiscount    = distribute(messPrice);
            const laundryDiscount = distribute(laundryPrice);
            const regDiscount     = appliedToNew - accDiscount - messDiscount - laundryDiscount;
            // a. Vacate old bed (only if changing beds)
            if (newBed.id !== oldAllocation.bedId) {
                await tx.hostelBed.update({
                    where: { id: oldAllocation.bedId },
                    data: { isOccupied: false, updatedBy: adminId }
                });
                await tx.hostelBed.update({
                    where: { id: newBed.id },
                    data: { isOccupied: true, updatedBy: adminId }
                });
            }

            // b. Update the ACTIVE HostelAllocation row in place (one per student is active at a time).
            await (tx.hostelAllocation as any).updateMany({
                where: { studentId, status: 'ACTIVE' },
                data: {
                    bedId: newBed.id,
                    startDate: new Date(),
                    updatedBy: adminId
                }
            });

            // c. Update admission
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    hostelId: args.hostelId,
                    hostelType: newHostelType,
                    roomNumber: newBed.room.number,
                    hostelPaymentMode: isSemwise ? HostelPaymentMode.SEMWISE : HostelPaymentMode.YEARWISE,
                    totalFee: { increment: totalFeeDelta }
                }
            });

            // d. Supersede the previous snapshot and write a new active one.
            // Old rows are kept (isActive=false) for refund/audit history.
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId }
            });
            await (tx.studentAccommodationPricing as any).create({
                data: {
                    studentId,
                    academicYearId,
                    sharing,
                    roomType,
                    paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                    hostelId: args.hostelId,
                    accommodationPrice,
                    messPrice,
                    laundryPrice,
                    registrationFee,
                    effectiveTotal: newEffectiveTotal,
                    pricingSource: 'CONFIG',
                    isActive: true,
                    createdBy: adminId
                }
            });

            // e. Soft-delete outstanding hostel fee demands (PENDING). Paid demands stay as audit.
            let supersededDemands = 0;
            if (hostelHeadIds.length > 0) {
                const result = await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        isDeleted: false,
                        status: FeeStatus.PENDING,
                        feeHeadId: { in: hostelHeadIds }
                    },
                    data: {
                        isDeleted: true,
                        deletedAt: new Date(),
                        deletedBy: adminId,
                        remarks: `Superseded by hostel re-assignment to ${newHostelType} ${args.hostelPaymentMode}`
                    }
                });
                supersededDemands = result.count;
            }

            // f. Create new demands for the new pricing.
            // Apply already-paid amount as `discountAmount` per component (proportional).
            // netAmount = max(0, gross − discount). status = FULL when net=0, else PENDING.
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const components: { head: typeof accHead; amount: number; discount: number; label: string }[] = [
                { head: accHead,     amount: accommodationPrice, discount: accDiscount,     label: 'accommodation' },
                { head: messHead,    amount: messPrice,          discount: messDiscount,    label: 'mess' },
                { head: laundryHead, amount: laundryPrice,       discount: laundryDiscount, label: 'laundry' },
                { head: regHead,     amount: registrationFee,    discount: regDiscount,     label: 'registration' }
            ];
            const createdDemands: string[] = [];
            const skippedComponents: string[] = [];
            for (const c of components) {
                if (!c.head) { if (c.amount > 0) skippedComponents.push(c.label); continue; }
                if (c.amount <= 0) continue;
                const net = Math.max(0, c.amount - c.discount);
                const d = await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: c.head.id,
                        amount: c.amount,
                        discountAmount: c.discount,
                        netAmount: net,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: net === 0 ? FeeStatus.FULL : FeeStatus.PENDING,
                        remarks:
                            c.discount > 0
                                ? `Hostel ${c.label} (re-assigned: ${newHostelType}, ${args.hostelPaymentMode}). Previous-payment credit applied: ${c.discount}.`
                                : `Hostel ${c.label} (re-assigned: ${newHostelType}, ${args.hostelPaymentMode})`,
                        createdBy: adminId
                    }
                });
                createdDemands.push(d.id);
            }

            // f2. If old hostel paid > new cost, the excess is refundable. Park it in FeeCorrection.
            let feeCorrectionId: string | null = null;
            if (leftoverRefund > 0) {
                const fc = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: leftoverRefund,
                        reason: `Hostel re-assignment refund (${args.reason})`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: oldPricing.hostelId,
                        referenceType: 'HOSTEL_REASSIGNMENT',
                        remarks: `grossPaid: ${hostelPaid}, priorRefunds: ${credit.priorRefunds}, availableCredit: ${availableCredit}, oldEffectiveTotal: ${oldEffectiveTotal}, newEffectiveTotal: ${newEffectiveTotal}, appliedToNew: ${appliedToNew}, leftover: ${leftoverRefund}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
                feeCorrectionId = fc.id;
            }

            // g. Audit ledger entry (financial)
            await tx.studentLedger.create({
                data: {
                    studentId,
                    date: new Date(),
                    type: totalFeeDelta >= 0 ? LedgerTransactionType.DEBIT : LedgerTransactionType.CREDIT,
                    amount: Math.abs(totalFeeDelta),
                    description: `Hostel re-assigned: ${oldAllocation.bed.room.number} → ${newBed.room.number} (${newHostelType}, ${args.hostelPaymentMode}). Reason: ${args.reason}`,
                    referenceType: 'HOSTEL_REASSIGNMENT',
                    referenceId: studentId,
                    createdBy: adminId,
                    academicYearId: academicYearId
                }
            });

            // g2. Audit log entry (admin-action trace)
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'HOSTEL_REASSIGNED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousHostelId: oldPricing.hostelId,
                        previousRoomNumber: oldAllocation.bed.room.number,
                        previousBedId: oldAllocation.bedId,
                        previousPaymentMode: oldPricing.paymentMode,
                        previousEffectiveTotal: oldEffectiveTotal,
                        newHostelId: args.hostelId,
                        newRoomNumber: newBed.room.number,
                        newBedId: newBed.id,
                        newPaymentMode: args.hostelPaymentMode,
                        newEffectiveTotal,
                        feeDelta: totalFeeDelta,
                        hostelPaid,
                        appliedToNew,
                        leftoverRefund,
                        creditDistribution: { accDiscount, messDiscount, laundryDiscount, regDiscount },
                        feeCorrectionId,
                        reason: args.reason,
                    }
                }
            });

            return {
                previous: {
                    hostelId: oldPricing.hostelId,
                    hostelType: `SHARING_${oldPricing.sharing}`,
                    roomNumber: oldAllocation.bed.room.number,
                    bedNumber: oldAllocation.bed.number,
                    paymentMode: oldPricing.paymentMode,
                    effectiveTotal: oldEffectiveTotal,
                },
                current: {
                    hostelId: args.hostelId,
                    hostelType: newHostelType,
                    roomNumber: newBed.room.number,
                    bedNumber: newBed.number,
                    paymentMode: args.hostelPaymentMode,
                    effectiveTotal: newEffectiveTotal,
                },
                feeDelta: totalFeeDelta,
                financialAdjustment: {
                    hostelPaid,
                    appliedToNew,
                    studentOwes: Math.max(0, newEffectiveTotal - appliedToNew),
                    leftoverRefund,
                    creditDistribution: { accDiscount, messDiscount, laundryDiscount, regDiscount },
                    feeCorrectionId,
                },
                supersededDemands,
                newDemandsCreated: createdDemands.length,
                skippedComponents: skippedComponents.length > 0
                    ? `Missing FeeHead for: ${skippedComponents.join(', ')}`
                    : null,
                reason: args.reason
            };
        }, {
            // Serializable isolation prevents two concurrent reassign requests from
            // both reading the same `availableCredit` and creating duplicate
            // FeeCorrection refunds. Postgres will retry one of them automatically.
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });

        // Refresh hostel allotment order PDF post-reassignment (best-effort).
        // Replaces the existing StudentDocument under HOSTEL_ALLOTMENT_ORDER.
        generateAndSaveHostelAllotmentOrder(studentId).catch(() => { /* logged inside */ });

        return result;
    },

    /**
     * Set or update a student's hostel assignment (pre-bed-allocation).
     *
     * Allowed transitions:
     *   - NONE → HOSTEL (initial assignment)
     *   - HOSTEL → HOSTEL (change hostelId/paymentMode BEFORE bed is allocated)
     *
     * Locked once a bed is allocated (= StudentAccommodationPricing exists).
     * After bed allocation, use the re-assignment flow which handles vacating
     * the old bed and computing fee adjustments.
     */
    async assignHostel(
        studentId: string,
        hostelId: string,
        hostelPaymentMode: 'YEARWISE' | 'SEMWISE',
        hostelType: HostelType,
        adminId?: string
    ) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'assign hostel');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        // TRANSPORT/other → HOSTEL is a different flow. Block it.
        if (
            admission.accommodationType !== AccommodationType.NONE &&
            admission.accommodationType !== AccommodationType.HOSTEL
        ) {
            throw new AppError(
                `Student has accommodation type "${admission.accommodationType}". Use the change-accommodation flow to switch to HOSTEL.`,
                409
            );
        }

        // Block re-assignment after a bed is bound. Use reassign-hostel instead.
        const existingAllocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });
        if (existingAllocation) {
            throw new AppError('Bed already allocated. Use the reassign-hostel flow to change hostel/sharing/mode.', 409);
        }

        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);

        // Skip capacity check when just changing payment mode on the same hostel
        if (hostelId !== admission.hostelId) {
            await assertHostelHasCapacity(hostelId);
        }

        // Derive sharing tier from hostelType. Hardcoded roomType=AC (campus has AC only today).
        const sharing = parseInt(hostelType.split('_')[1], 10);
        const roomType = 'AC';

        // Look up active price tier — year-scoped first, falls back to legacy year-null
        const priceCategory = await resolveHostelPriceCategory(
            { sharing, roomType, academicYearId: admission.academicYearId }
        );
        if (!priceCategory) {
            throw new AppError(
                `No active price tier found for sharing=${sharing}, roomType=${roomType} in academic year ${admission.academicYearId ?? '<none>'}. Create one in HostelPriceCategory first.`,
                400
            );
        }

        const isSemwise = hostelPaymentMode === 'SEMWISE';
        const accommodationPrice = (isSemwise ? priceCategory.accommodationSemwise : priceCategory.accommodationYearwise) ?? 0;
        const messPrice          = (isSemwise ? priceCategory.messSemwise : priceCategory.messYearwise) ?? 0;
        const laundryPrice       = (isSemwise ? priceCategory.laundrySemwise : priceCategory.laundryYearwise) ?? 0;
        const registrationFee    = priceCategory.registrationFee ?? 0;
        const effectiveTotal     = accommodationPrice + messPrice + laundryPrice + registrationFee;

        const academicYearId = admission.academicYearId;

        // Resolve hostel fee heads
        const feeHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const accHead     = feeHeadMap.get(PaymentComponent.HOSTEL_ACCOMMODATION);
        const messHead    = feeHeadMap.get(PaymentComponent.HOSTEL_MESS);
        const laundryHead = feeHeadMap.get(PaymentComponent.HOSTEL_LAUNDRY);
        const regHead     = feeHeadMap.get(PaymentComponent.HOSTEL_REGISTRATION);

        // Diff against an existing snapshot (re-assign before bed allocation must adjust totalFee delta).
        const previousEffectiveTotal = ctx.accommodationPricing?.effectiveTotal ?? 0;
        const totalFeeDelta = effectiveTotal - previousEffectiveTotal;

        const result = await prisma.$transaction(async (tx) => {
            // 1. Update admission (mode + tier + totals)
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.HOSTEL,
                    hostelId,
                    hostelType,
                    hostelPaymentMode: hostelPaymentMode as HostelPaymentMode,
                    totalFee: { increment: totalFeeDelta }
                }
            });

            // 2. Soft-delete previous PENDING hostel demands so we don't double-bill.
            //    Paid/partially-paid history is preserved (only PENDING flips to deleted).
            const hostelHeadIds = [accHead?.id, messHead?.id, laundryHead?.id, regHead?.id].filter(Boolean) as string[];
            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                        status: FeeStatus.PENDING,
                        isDeleted: false
                    },
                    data: { isDeleted: true, updatedBy: adminId }
                });
            }

            // 3. Supersede any prior snapshot and write a new active one.
            // Prior rows from earlier hostel cycles are kept (isActive=false) for audit/refund history.
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId }
            });
            await (tx.studentAccommodationPricing as any).create({
                data: {
                    studentId,
                    academicYearId,
                    sharing,
                    roomType,
                    paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                    hostelId,
                    accommodationPrice,
                    messPrice,
                    laundryPrice,
                    registrationFee,
                    effectiveTotal,
                    pricingSource: 'CONFIG',
                    isActive: true,
                    createdBy: adminId
                }
            });

            // 4. Create fresh demands
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const demands: { feeHeadId: string; amount: number; label: string }[] = [];
            if (accHead && accommodationPrice > 0) demands.push({ feeHeadId: accHead.id, amount: accommodationPrice, label: 'accommodation' });
            if (messHead && messPrice > 0)         demands.push({ feeHeadId: messHead.id, amount: messPrice, label: 'mess' });
            if (laundryHead && laundryPrice > 0)   demands.push({ feeHeadId: laundryHead.id, amount: laundryPrice, label: 'laundry' });
            if (regHead && registrationFee > 0)    demands.push({ feeHeadId: regHead.id, amount: registrationFee, label: 'registration' });

            for (const d of demands) {
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: d.feeHeadId,
                        amount: d.amount,
                        netAmount: d.amount,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: FeeStatus.PENDING,
                        remarks: `Hostel ${d.label} (${hostelType}, ${roomType}, ${isSemwise ? 'SEMWISE' : 'YEARWISE'})`,
                        createdBy: adminId
                    }
                });
            }

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'HOSTEL_ASSIGNED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousHostelId: admission.hostelId,
                        previousAccommodationType: admission.accommodationType,
                        previousHostelType: admission.hostelType,
                        previousEffectiveTotal,
                        newHostelId: hostelId,
                        newHostelType: hostelType,
                        newPaymentMode: hostelPaymentMode,
                        newEffectiveTotal: effectiveTotal,
                        totalFeeDelta,
                        hostelName: hostel.name,
                        sharing,
                        roomType,
                        feeDemandsCreated: demands.length,
                    }
                }
            });

            return {
                hostelId,
                hostelType,
                paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                pricing: { accommodationPrice, messPrice, laundryPrice, registrationFee, effectiveTotal },
                feeDemandsCreated: demands.length,
                totalFeeDelta,
            };
        });

        return result;
    },

    /**
     * Set or update a student's transport assignment (pre-stop-allocation).
     *
     * Mirrors assignHostel but simpler — transport pricing is a single line
     * (TransportRoute.cost), no payment mode, no sharing tier.
     *
     * Allowed transitions:
     *   - NONE → TRANSPORT (initial assignment)
     *   - TRANSPORT → TRANSPORT (change route BEFORE TransportAllocation row exists)
     *
     * Locked once a TransportAllocation row exists for the student. Use a
     * separate reassign-transport flow after that.
     *
     * Side effects:
     *   - Sets accommodationType=TRANSPORT, transportRouteId on admission
     *   - Soft-deletes any prior PENDING TRANSPORT fee demand
     *   - Creates a fresh StudentFeeDemand tagged TRANSPORT with route.cost
     *   - Adjusts StudentAdmission.totalFee by the delta
     */
    async assignTransport(
        studentId: string,
        transportRouteId: string,
        adminId?: string
    ) {
        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'assign transport');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        // HOSTEL/other → TRANSPORT is a different flow. Block it.
        if (
            admission.accommodationType !== AccommodationType.NONE &&
            admission.accommodationType !== AccommodationType.TRANSPORT
        ) {
            throw new AppError(
                `Student has accommodation type "${admission.accommodationType}". Use the change-accommodation flow to switch to TRANSPORT.`,
                409
            );
        }

        // Block re-assignment after a TransportAllocation has been created.
        const existingAllocation = await prisma.transportAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });
        if (existingAllocation) {
            throw new AppError('Student already has an active transport allocation. Use the reassign-transport flow.', 409);
        }

        // Fetch existing transportRouteId directly (not exposed on ctx.admission shape)
        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true }
        });
        const previousRouteId = admissionRow?.transportRouteId ?? null;

        const route = await prisma.transportRoute.findUnique({ where: { id: transportRouteId } });
        if (!route) throw new AppError('Transport route not found', 404);
        if (route.isDeleted) throw new AppError('Cannot assign to a deleted route', 400);
        if ((route.capacity ?? 0) > 0 && (route.filled ?? 0) >= (route.capacity ?? 0)) {
            // Allow re-assigning to the SAME route (no capacity bump needed)
            if (transportRouteId !== previousRouteId) {
                throw new AppError('Transport route is full', 400);
            }
        }

        // Resolve the TRANSPORT fee head (single component)
        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

        // Year-aware route cost: prefer per-year override, fall back to route.cost
        const academicYearId = admission.academicYearId;
        const newCost = await resolveTransportRouteCost(transportRouteId, academicYearId ?? null);

        // Diff against existing PENDING TRANSPORT demand (if any) to compute totalFee delta.
        let previousCost = 0;
        if (transportHead) {
            const existingDemands = await prisma.studentFeeDemand.findMany({
                where: {
                    studentId,
                    feeHeadId: transportHead.id,
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                select: { netAmount: true, amount: true },
            });
            previousCost = existingDemands.reduce((s, d) => s + (d.netAmount ?? d.amount ?? 0), 0);
        }
        const totalFeeDelta = newCost - previousCost;

        const result = await prisma.$transaction(async (tx) => {
            // 1. Update admission
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.TRANSPORT,
                    transportRouteId,
                    totalFee: { increment: totalFeeDelta }
                }
            });

            // 2. Soft-delete previous PENDING transport demand(s)
            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        status: FeeStatus.PENDING,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId }
                });
            }

            // 3. Create fresh demand
            let feeDemandsCreated = 0;
            if (transportHead && newCost > 0) {
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 30);
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: transportHead.id,
                        amount: newCost,
                        netAmount: newCost,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: FeeStatus.PENDING,
                        remarks: `Transport (${route.name}, ${route.busNumber ?? '—'})`,
                        createdBy: adminId
                    }
                });
                feeDemandsCreated = 1;
            }

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'TRANSPORT_ASSIGNED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousAccommodationType: admission.accommodationType,
                        previousRouteId,
                        previousCost,
                        newRouteId: transportRouteId,
                        newCost,
                        totalFeeDelta,
                        routeName: route.name,
                        feeDemandsCreated,
                    }
                }
            });

            return {
                transportRouteId,
                routeName: route.name,
                cost: newCost,
                feeDemandsCreated,
                totalFeeDelta,
                missingFeeHead: !transportHead
                    ? 'No FeeHead tagged with component=TRANSPORT — fee demand was NOT created. Create the fee head and retry.'
                    : null,
            };
        });

        return result;
    },

    /**
     * Re-assign a TRANSPORT student to a different route.
     *
     * Transport doesn't have a separate "allocate" step — having a route on the
     * admission IS being on transport. So this is just: change route, replace
     * demand, adjust totalFee.
     *
     * Side effects (atomic):
     *   - Updates StudentAdmission.transportRouteId
     *   - Soft-deletes any prior PENDING TRANSPORT fee demand
     *   - Creates a fresh StudentFeeDemand using the new route's cost
     *   - Adjusts StudentAdmission.totalFee by the delta (newCost − previousPendingCost)
     *   - Writes audit log including the reason
     *
     * Pre-conditions:
     *   - Admission active, accommodationType === TRANSPORT
     *   - New route exists, not deleted, has capacity (skipped when same route)
     */
    async reassignTransport(
        studentId: string,
        args: { transportRouteId: string; reason: string },
        adminId?: string
    ) {
        const { transportRouteId, reason } = args;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'reassign transport');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(
                `Student is not on TRANSPORT (currently ${admission.accommodationType}). Use assign-transport instead.`,
                400
            );
        }

        const newRoute = await prisma.transportRoute.findUnique({ where: { id: transportRouteId } });
        if (!newRoute) throw new AppError('New transport route not found', 404);
        if (newRoute.isDeleted) throw new AppError('Cannot reassign to a deleted route', 400);

        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true }
        });
        const oldRouteId = admissionRow?.transportRouteId ?? null;

        // Capacity check on the NEW route, only when actually changing routes.
        if (transportRouteId !== oldRouteId) {
            const studentsOnNewRoute = await prisma.studentAdmission.count({
                where: { transportRouteId, status: { not: 'CANCELLED' } }
            });
            if ((newRoute.capacity ?? 0) > 0 && studentsOnNewRoute >= (newRoute.capacity ?? 0)) {
                throw new AppError('New transport route is full', 400);
            }
        }

        // Resolve TRANSPORT fee head and existing PENDING cost
        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

        const newCost = newRoute.cost ?? 0;
        let previousCost = 0;
        if (transportHead) {
            const existingDemands = await prisma.studentFeeDemand.findMany({
                where: {
                    studentId,
                    feeHeadId: transportHead.id,
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                select: { netAmount: true, amount: true },
            });
            previousCost = existingDemands.reduce((s, d) => s + (d.netAmount ?? d.amount ?? 0), 0);
        }
        const totalFeeDelta = newCost - previousCost;

        const academicYearId = admission.academicYearId;

        const result = await prisma.$transaction(async (tx) => {
            // 1. Update admission
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    transportRouteId,
                    totalFee: { increment: totalFeeDelta },
                }
            });

            // 2. Soft-delete prior PENDING transport demand(s)
            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        status: FeeStatus.PENDING,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId }
                });
            }

            // 3. Create fresh demand
            let feeDemandsCreated = 0;
            if (transportHead && newCost > 0) {
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 30);
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: transportHead.id,
                        amount: newCost,
                        netAmount: newCost,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: FeeStatus.PENDING,
                        remarks: `Transport (re-assigned: ${newRoute.name}). Reason: ${reason}`,
                        createdBy: adminId
                    }
                });
                feeDemandsCreated = 1;
            }

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'TRANSPORT_REASSIGNED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        oldRouteId,
                        newRouteId: transportRouteId,
                        previousCost,
                        newCost,
                        totalFeeDelta,
                        reason,
                        routeName: newRoute.name,
                    }
                }
            });

            return {
                transportRouteId,
                routeName: newRoute.name,
                cost: newCost,
                feeDemandsCreated,
                totalFeeDelta,
                missingFeeHead: !transportHead
                    ? 'No FeeHead tagged with component=TRANSPORT — fee demand was NOT created. Create the fee head and retry.'
                    : null,
            };
        });

        return result;
    },

    /**
     * Cancel a student's HOSTEL allocation: flip back to NONE, clear hostel fields,
     * vacate bed, soft-delete pending demands, drop pricing snapshot, and create a
     * FeeCorrection (type=ACCOMMODATION_CHANGE_REFUND) for any refundable amount.
     *
     * Refund formula: max(0, hostelPaid − cancellationFee).
     * - cancellationFee is the amount the college keeps as a non-refundable charge.
     * - If paid < cancellationFee, no refund is created (admin can chase the balance separately).
     */
    async cancelHostel(
        studentId: string,
        args: { cancellationFee?: number; reason: string },
        adminId?: string
    ) {
        const cancellationFee = Math.max(0, args.cancellationFee ?? 0);
        const reason = args.reason;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel hostel');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        if (admission.accommodationType !== AccommodationType.HOSTEL) {
            throw new AppError(
                `Student is not on HOSTEL (currently ${admission.accommodationType}). Nothing to cancel.`,
                400
            );
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) {
            throw new AppError('Cannot cancel: student has no academicYearId on admission', 400);
        }

        // Resolve hostel fee heads
        const feeHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const hostelHeadIds = Array.from(feeHeadMap.values()).filter(Boolean).map((h: any) => h.id);

        // Sum pending hostel demand (to back out from totalFee). Read outside tx —
        // the value is just a totalFee delta and doesn't affect availableCredit.
        let pendingDemandTotal = 0;
        if (hostelHeadIds.length > 0) {
            const pendingAgg = await prisma.studentFeeDemand.aggregate({
                where: {
                    studentId,
                    feeHeadId: { in: hostelHeadIds },
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                _sum: { netAmount: true },
            });
            pendingDemandTotal = pendingAgg._sum.netAmount ?? 0;
        }

        const previousHostelId = admission.hostelId;
        const previousHostelType = admission.hostelType;
        const allocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });

        const result = await prisma.$transaction(async (tx) => {
            // Compute availableCredit INSIDE the tx (race-condition-safe).
            // availableCredit = grossPaid − sum(prior FeeCorrection refunds).
            // refundAmount uses availableCredit so prior unsettled FeeCorrection rows
            // are not double-counted into this cancellation refund.
            const credit = await getAvailableHostelCredit(studentId, tx);
            const paid = credit.grossPaid;
            const availableCredit = credit.availableCredit;
            const refundAmount = Math.max(0, availableCredit - cancellationFee);
            // 1. Vacate active allocation if any
            if (allocation) {
                await (tx.hostelAllocation as any).updateMany({
                    where: { studentId, status: 'ACTIVE' },
                    data: { status: 'VACATED', endDate: new Date(), updatedBy: adminId },
                });
                await tx.hostelBed.update({
                    where: { id: allocation.bedId },
                    data: { isOccupied: false, updatedBy: adminId },
                });
            }

            // 2. Soft-delete pending hostel demands
            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                        status: FeeStatus.PENDING,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId },
                });
            }

            // 3. Mark snapshot inactive (preserved for refund/audit history; future
            //    re-assign creates a new active row).
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId },
            });

            // 4. Reset admission to NONE
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.NONE,
                    hostelId: null,
                    hostelType: null,
                    hostelPaymentMode: null,
                    roomNumber: null,
                    totalFee: { decrement: pendingDemandTotal },
                },
            });

            // 5. Refund -> FeeCorrection
            let feeCorrection: any = null;
            if (refundAmount > 0) {
                feeCorrection = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: refundAmount,
                        reason: `Hostel cancellation: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousHostelId,
                        referenceType: 'HOSTEL_CANCELLATION',
                        remarks: `grossPaid: ${paid}, priorRefunds: ${credit.priorRefunds}, availableCredit: ${availableCredit}, cancellationFee: ${cancellationFee}, refund: ${refundAmount}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
            }

            // 6. Audit
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'HOSTEL_CANCELLED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousHostelId,
                        previousHostelType,
                        paid,
                        cancellationFee,
                        refundAmount,
                        pendingDemandRemoved: pendingDemandTotal,
                        bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                        reason,
                    },
                },
            });

            return {
                paid,
                cancellationFee,
                refundAmount,
                pendingDemandRemoved: pendingDemandTotal,
                bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                feeCorrectionId: feeCorrection?.id ?? null,
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });

        return result;
    },

    /**
     * Cancel a student's TRANSPORT route: flip back to NONE, clear transportRouteId,
     * soft-delete pending TRANSPORT demand, and create a FeeCorrection
     * (type=ACCOMMODATION_CHANGE_REFUND) for any refundable amount.
     */
    async cancelTransport(
        studentId: string,
        args: { cancellationFee?: number; reason: string },
        adminId?: string
    ) {
        const cancellationFee = Math.max(0, args.cancellationFee ?? 0);
        const reason = args.reason;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'cancel transport');
        const admission = ctx.admission!;
        if (admission.academicYearId) {
            await assertAcademicYearWritable(admission.academicYearId);
        }

        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(
                `Student is not on TRANSPORT (currently ${admission.accommodationType}). Nothing to cancel.`,
                400
            );
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) {
            throw new AppError('Cannot cancel: student has no academicYearId on admission', 400);
        }

        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true },
        });
        const previousRouteId = admissionRow?.transportRouteId ?? null;

        // Resolve TRANSPORT fee head
        const feeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = feeHeadMap.get(PaymentComponent.TRANSPORT);

        // Sum transport-tagged successful payments
        const paidAgg = await prisma.payment.aggregate({
            where: {
                studentId,
                status: PaymentStatus.SUCCESS,
                isDeleted: false,
                component: PaymentComponent.TRANSPORT,
            },
            _sum: { amount: true },
        });
        const paid = paidAgg._sum.amount ?? 0;

        // Sum pending demand
        let pendingDemandTotal = 0;
        if (transportHead) {
            const pendingAgg = await prisma.studentFeeDemand.aggregate({
                where: {
                    studentId,
                    feeHeadId: transportHead.id,
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                _sum: { netAmount: true },
            });
            pendingDemandTotal = pendingAgg._sum.netAmount ?? 0;
        }

        const refundAmount = Math.max(0, paid - cancellationFee);

        const result = await prisma.$transaction(async (tx) => {
            // 1. Soft-delete pending transport demand(s)
            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        status: FeeStatus.PENDING,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId },
                });
            }

            // 2. Reset admission
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.NONE,
                    transportRouteId: null,
                    totalFee: { decrement: pendingDemandTotal },
                },
            });

            // 3. Refund -> FeeCorrection
            let feeCorrection: any = null;
            if (refundAmount > 0) {
                feeCorrection = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: refundAmount,
                        reason: `Transport cancellation: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousRouteId,
                        referenceType: 'TRANSPORT_CANCELLATION',
                        remarks: `Paid: ${paid}, cancellationFee: ${cancellationFee}, refund: ${refundAmount}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
            }

            // 4. Audit
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'TRANSPORT_CANCELLED',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousRouteId,
                        paid,
                        cancellationFee,
                        refundAmount,
                        pendingDemandRemoved: pendingDemandTotal,
                        reason,
                    },
                },
            });

            return {
                paid,
                cancellationFee,
                refundAmount,
                pendingDemandRemoved: pendingDemandTotal,
                feeCorrectionId: feeCorrection?.id ?? null,
            };
        });

        return result;
    },

    /**
     * One-shot switch from HOSTEL to TRANSPORT with proration.
     *
     * Money flow:
     *   refundPool   = max(0, hostelPaid − chargeRetained)
     *   appliedToNew = min(refundPool, transportRoute.cost)   // covered as a discount on the new demand
     *   leftover     = refundPool − appliedToNew              // goes to FeeCorrection (refund)
     *
     * The new TRANSPORT StudentFeeDemand carries `discountAmount = appliedToNew`,
     * `netAmount = newCost − appliedToNew`. Student owes only `netAmount` (or zero
     * if the credit fully covers the new route).
     */
    async switchHostelToTransport(
        studentId: string,
        args: { chargeRetained?: number; reason: string; transportRouteId: string },
        adminId?: string
    ) {
        const chargeRetained = Math.max(0, args.chargeRetained ?? 0);
        const { reason, transportRouteId } = args;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'switch hostel to transport');
        const admission = ctx.admission!;

        if (admission.accommodationType !== AccommodationType.HOSTEL) {
            throw new AppError(
                `Student is not on HOSTEL (currently ${admission.accommodationType}). Use assign-transport directly.`,
                400
            );
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) throw new AppError('Cannot switch: student has no academicYearId on admission', 400);
        await assertAcademicYearWritable(academicYearId);

        // Resolve fee heads
        const hostelHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const hostelHeadIds = Array.from(hostelHeadMap.values()).filter(Boolean).map((h: any) => h.id);
        const transportHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = transportHeadMap.get(PaymentComponent.TRANSPORT);

        let pendingHostelTotal = 0;
        if (hostelHeadIds.length > 0) {
            const pAgg = await prisma.studentFeeDemand.aggregate({
                where: {
                    studentId,
                    feeHeadId: { in: hostelHeadIds },
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                _sum: { netAmount: true },
            });
            pendingHostelTotal = pAgg._sum.netAmount ?? 0;
        }

        // Validate new route
        const route = await prisma.transportRoute.findUnique({ where: { id: transportRouteId } });
        if (!route) throw new AppError('Transport route not found', 404);
        if (route.isDeleted) throw new AppError('Cannot assign to a deleted route', 400);
        const studentsOnRoute = await prisma.studentAdmission.count({
            where: { transportRouteId, status: { not: 'CANCELLED' } },
        });
        if ((route.capacity ?? 0) > 0 && studentsOnRoute >= (route.capacity ?? 0)) {
            throw new AppError('Transport route is full', 400);
        }

        // Year-aware route cost: prefer per-year override, fall back to route.cost
        const newCost = await resolveTransportRouteCost(transportRouteId, academicYearId);
        const previousHostelId = admission.hostelId;
        const previousHostelType = admission.hostelType;
        const allocation = await prisma.hostelAllocation.findFirst({ where: { studentId, status: 'ACTIVE' } });

        const result = await prisma.$transaction(async (tx) => {
            // Compute availableCredit INSIDE the tx (race-condition-safe).
            // refundPool uses availableCredit (paid − prior FeeCorrection refunds), NOT gross
            // hostelPaid — otherwise prior refunds get re-counted into this one.
            const credit          = await getAvailableHostelCredit(studentId, tx);
            const hostelPaid      = credit.grossPaid;
            const availableCredit = credit.availableCredit;
            const refundPool      = Math.max(0, availableCredit - chargeRetained);
            const appliedToNew    = Math.min(refundPool, newCost);
            const leftover        = refundPool - appliedToNew;
            const newDemandNet    = Math.max(0, newCost - appliedToNew);

            // ── 1. Cancel hostel ──
            if (allocation) {
                await (tx.hostelAllocation as any).updateMany({
                    where: { studentId, status: 'ACTIVE' },
                    data: { status: 'VACATED', endDate: new Date(), updatedBy: adminId },
                });
                await tx.hostelBed.update({
                    where: { id: allocation.bedId },
                    data: { isOccupied: false, updatedBy: adminId },
                });
            }
            if (hostelHeadIds.length > 0) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: { in: hostelHeadIds },
                        status: FeeStatus.PENDING,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId },
                });
            }
            // Mark snapshot inactive (preserved for refund/audit history).
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId },
            });

            // ── 2. Switch admission to TRANSPORT ──
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.TRANSPORT,
                    transportRouteId,
                    hostelId: null,
                    hostelType: null,
                    hostelPaymentMode: null,
                    roomNumber: null,
                    // totalFee: subtract pending hostel removed, add new transport gross
                    totalFee: { increment: newCost - pendingHostelTotal },
                },
            });

            // ── 3. Create new TRANSPORT demand with credit applied as discount ──
            let feeDemandsCreated = 0;
            let createdDemandId: string | null = null;
            if (transportHead && newCost > 0) {
                const dueDate = new Date();
                dueDate.setDate(dueDate.getDate() + 30);
                const demand = await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: transportHead.id,
                        amount: newCost,
                        discountAmount: appliedToNew,
                        netAmount: newDemandNet,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: newDemandNet === 0 ? FeeStatus.FULL : FeeStatus.PENDING,
                        remarks:
                            appliedToNew > 0
                                ? `Transport (${route.name}). Hostel-cancellation credit applied: ${appliedToNew}. Reason: ${reason}`
                                : `Transport (${route.name}). Reason: ${reason}`,
                        createdBy: adminId,
                    },
                });
                feeDemandsCreated = 1;
                createdDemandId = demand.id;
            }

            // ── 4. Refund leftover to FeeCorrection ──
            let feeCorrectionId: string | null = null;
            if (leftover > 0) {
                const fc = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: leftover,
                        reason: `Hostel→Transport switch leftover refund: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousHostelId,
                        referenceType: 'HOSTEL_TO_TRANSPORT_SWITCH',
                        remarks: `grossPaid: ${hostelPaid}, priorRefunds: ${credit.priorRefunds}, availableCredit: ${availableCredit}, chargeRetained: ${chargeRetained}, refundPool: ${refundPool}, appliedToNewTransport: ${appliedToNew}, leftover: ${leftover}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
                feeCorrectionId = fc.id;
            }

            // ── 5. Audit ──
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'HOSTEL_TO_TRANSPORT_SWITCH',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousHostelId,
                        previousHostelType,
                        newRouteId: transportRouteId,
                        routeName: route.name,
                        hostelPaid,
                        chargeRetained,
                        refundPool,
                        appliedToNew,
                        leftover,
                        newCost,
                        newDemandNet,
                        pendingHostelRemoved: pendingHostelTotal,
                        bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                        feeDemandsCreated,
                        createdDemandId,
                        feeCorrectionId,
                        reason,
                    },
                },
            });

            return {
                cancellation: {
                    hostelPaid,
                    chargeRetained,
                    refundPool,
                    pendingHostelRemoved: pendingHostelTotal,
                    bedVacated: !!(allocation && allocation.status === 'ACTIVE'),
                },
                newAssignment: {
                    transportRouteId,
                    routeName: route.name,
                    cost: newCost,
                    creditApplied: appliedToNew,
                    studentOwes: newDemandNet,
                    feeDemandsCreated,
                    demandId: createdDemandId,
                },
                refund: {
                    leftover,
                    feeCorrectionId,
                },
                missingFeeHead: !transportHead
                    ? 'No FeeHead tagged with component=TRANSPORT — fee demand was NOT created.'
                    : null,
            };
        }, {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });

        return result;
    },

    /**
     * One-shot switch from TRANSPORT to HOSTEL with proration.
     * Same idea as the reverse: refund pool from transport (paid − chargeRetained) is
     * applied as a discount across the NEW hostel demand rows (split proportionally
     * across the four components), and any leftover goes to FeeCorrection.
     */
    async switchTransportToHostel(
        studentId: string,
        args: {
            chargeRetained?: number;
            reason: string;
            hostelId: string;
            hostelType: HostelType;
            hostelPaymentMode: 'YEARWISE' | 'SEMWISE';
        },
        adminId?: string
    ) {
        const chargeRetained = Math.max(0, args.chargeRetained ?? 0);
        const { reason, hostelId, hostelType, hostelPaymentMode } = args;

        const ctx = await getStudentContext(studentId);
        assertActiveAdmission(ctx.admission, 'switch transport to hostel');
        const admission = ctx.admission!;

        if (admission.accommodationType !== AccommodationType.TRANSPORT) {
            throw new AppError(
                `Student is not on TRANSPORT (currently ${admission.accommodationType}). Use assign-hostel directly.`,
                400
            );
        }
        const academicYearId = admission.academicYearId;
        if (!academicYearId) throw new AppError('Cannot switch: student has no academicYearId on admission', 400);
        await assertAcademicYearWritable(academicYearId);

        // Resolve fee heads
        const transportHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.TRANSPORT]);
        const transportHead = transportHeadMap.get(PaymentComponent.TRANSPORT);
        const hostelHeadMap = await resolveFeeHeadsByComponent([
            PaymentComponent.HOSTEL_ACCOMMODATION,
            PaymentComponent.HOSTEL_MESS,
            PaymentComponent.HOSTEL_LAUNDRY,
            PaymentComponent.HOSTEL_REGISTRATION,
        ]);
        const accHead = hostelHeadMap.get(PaymentComponent.HOSTEL_ACCOMMODATION);
        const messHead = hostelHeadMap.get(PaymentComponent.HOSTEL_MESS);
        const laundryHead = hostelHeadMap.get(PaymentComponent.HOSTEL_LAUNDRY);
        const regHead = hostelHeadMap.get(PaymentComponent.HOSTEL_REGISTRATION);

        // Validate new hostel
        const hostel = await prisma.hostel.findUnique({ where: { id: hostelId } });
        if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);
        if (hostel.isDeleted) throw new AppError('Cannot assign to a deleted hostel', 400);
        await assertHostelHasCapacity(hostelId);

        const sharing = parseInt(hostelType.split('_')[1], 10);
        const roomType = 'AC';
        const priceCategory = await resolveHostelPriceCategory(
            { sharing, roomType, academicYearId }
        );
        if (!priceCategory) {
            throw new AppError(`No active price tier for sharing=${sharing}, roomType=${roomType} in academic year ${academicYearId}.`, 400);
        }
        const isSemwise = hostelPaymentMode === 'SEMWISE';
        const accommodationPrice = (isSemwise ? priceCategory.accommodationSemwise : priceCategory.accommodationYearwise) ?? 0;
        const messPrice = (isSemwise ? priceCategory.messSemwise : priceCategory.messYearwise) ?? 0;
        const laundryPrice = (isSemwise ? priceCategory.laundrySemwise : priceCategory.laundryYearwise) ?? 0;
        const registrationFee = priceCategory.registrationFee ?? 0;
        const effectiveTotal = accommodationPrice + messPrice + laundryPrice + registrationFee;

        // Compute transportPaid + pendingTransportTotal
        const paidAgg = await prisma.payment.aggregate({
            where: {
                studentId,
                status: PaymentStatus.SUCCESS,
                isDeleted: false,
                component: PaymentComponent.TRANSPORT,
            },
            _sum: { amount: true },
        });
        const transportPaid = paidAgg._sum.amount ?? 0;

        let pendingTransportTotal = 0;
        if (transportHead) {
            const pAgg = await prisma.studentFeeDemand.aggregate({
                where: {
                    studentId,
                    feeHeadId: transportHead.id,
                    status: FeeStatus.PENDING,
                    isDeleted: false,
                },
                _sum: { netAmount: true },
            });
            pendingTransportTotal = pAgg._sum.netAmount ?? 0;
        }

        const refundPool = Math.max(0, transportPaid - chargeRetained);
        const appliedToNew = Math.min(refundPool, effectiveTotal);
        const leftover = refundPool - appliedToNew;

        // Distribute appliedToNew proportionally across the 4 components.
        // Last (registration) absorbs rounding so the discounts sum exactly to appliedToNew.
        const distribute = (amount: number) =>
            effectiveTotal > 0 ? Math.round((amount / effectiveTotal) * appliedToNew) : 0;
        const accDiscount = distribute(accommodationPrice);
        const messDiscount = distribute(messPrice);
        const laundryDiscount = distribute(laundryPrice);
        const regDiscount = appliedToNew - accDiscount - messDiscount - laundryDiscount;

        const admissionRow = await prisma.studentAdmission.findUnique({
            where: { studentId },
            select: { transportRouteId: true },
        });
        const previousRouteId = admissionRow?.transportRouteId ?? null;

        const result = await prisma.$transaction(async (tx) => {
            // ── 1. Cancel transport ──
            if (transportHead) {
                await tx.studentFeeDemand.updateMany({
                    where: {
                        studentId,
                        feeHeadId: transportHead.id,
                        status: FeeStatus.PENDING,
                        isDeleted: false,
                    },
                    data: { isDeleted: true, updatedBy: adminId },
                });
            }

            // ── 2. Switch admission to HOSTEL ──
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType: AccommodationType.HOSTEL,
                    transportRouteId: null,
                    hostelId,
                    hostelType,
                    hostelPaymentMode: hostelPaymentMode as HostelPaymentMode,
                    // totalFee: subtract pending transport, add full new hostel gross
                    totalFee: { increment: effectiveTotal - pendingTransportTotal },
                },
            });

            // ── 3. Supersede prior snapshot and write a new active one ──
            // Prior rows are kept (isActive=false) for refund/audit history.
            await (tx.studentAccommodationPricing as any).updateMany({
                where: { studentId, isActive: true },
                data: { isActive: false, supersededAt: new Date(), updatedBy: adminId },
            });
            await (tx.studentAccommodationPricing as any).create({
                data: {
                    studentId,
                    academicYearId,
                    sharing,
                    roomType,
                    paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                    hostelId,
                    accommodationPrice,
                    messPrice,
                    laundryPrice,
                    registrationFee,
                    effectiveTotal,
                    pricingSource: 'CONFIG',
                    isActive: true,
                    createdBy: adminId,
                },
            });

            // ── 4. Create 4 hostel demands with proportional discounts ──
            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() + 30);
            const buildDemand = async (
                head: any,
                gross: number,
                discount: number,
                label: string
            ) => {
                if (!head || gross <= 0) return false;
                const net = Math.max(0, gross - discount);
                await tx.studentFeeDemand.create({
                    data: {
                        studentId,
                        feeHeadId: head.id,
                        amount: gross,
                        discountAmount: discount,
                        netAmount: net,
                        academicYearId,
                        yearOfStudy: ctx.yearOfStudy,
                        dueDate,
                        status: net === 0 ? FeeStatus.FULL : FeeStatus.PENDING,
                        remarks:
                            discount > 0
                                ? `Hostel ${label} (${hostelType}, ${roomType}, ${isSemwise ? 'SEMWISE' : 'YEARWISE'}). Transport-cancellation credit applied: ${discount}. Reason: ${reason}`
                                : `Hostel ${label} (${hostelType}, ${roomType}, ${isSemwise ? 'SEMWISE' : 'YEARWISE'}). Reason: ${reason}`,
                        createdBy: adminId,
                    },
                });
                return true;
            };
            let feeDemandsCreated = 0;
            if (await buildDemand(accHead, accommodationPrice, accDiscount, 'accommodation')) feeDemandsCreated++;
            if (await buildDemand(messHead, messPrice, messDiscount, 'mess')) feeDemandsCreated++;
            if (await buildDemand(laundryHead, laundryPrice, laundryDiscount, 'laundry')) feeDemandsCreated++;
            if (await buildDemand(regHead, registrationFee, regDiscount, 'registration')) feeDemandsCreated++;

            // ── 5. Refund leftover ──
            let feeCorrectionId: string | null = null;
            if (leftover > 0) {
                const fc = await (tx.feeCorrection as any).create({
                    data: {
                        studentId,
                        academicYearId,
                        amount: leftover,
                        reason: `Transport→Hostel switch leftover refund: ${reason}`,
                        type: 'ACCOMMODATION_CHANGE_REFUND',
                        referenceId: previousRouteId,
                        referenceType: 'TRANSPORT_TO_HOSTEL_SWITCH',
                        remarks: `transportPaid: ${transportPaid}, chargeRetained: ${chargeRetained}, refundPool: ${refundPool}, appliedToNewHostel: ${appliedToNew}, leftover: ${leftover}`,
                        carryForward: true,
                        isSettled: false,
                        createdBy: adminId,
                    },
                });
                feeCorrectionId = fc.id;
            }

            // ── 6. Audit ──
            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'TRANSPORT_TO_HOSTEL_SWITCH',
                    entity: 'StudentAdmission',
                    entityId: studentId,
                    details: {
                        previousRouteId,
                        newHostelId: hostelId,
                        hostelType,
                        hostelPaymentMode,
                        transportPaid,
                        chargeRetained,
                        refundPool,
                        appliedToNew,
                        leftover,
                        effectiveTotal,
                        pendingTransportRemoved: pendingTransportTotal,
                        feeDemandsCreated,
                        feeCorrectionId,
                        reason,
                    },
                },
            });

            return {
                cancellation: {
                    transportPaid,
                    chargeRetained,
                    refundPool,
                    pendingTransportRemoved: pendingTransportTotal,
                },
                newAssignment: {
                    hostelId,
                    hostelType,
                    paymentMode: isSemwise ? 'SEMWISE' : 'YEARWISE',
                    pricing: { accommodationPrice, messPrice, laundryPrice, registrationFee, effectiveTotal },
                    creditApplied: appliedToNew,
                    creditDistribution: { accDiscount, messDiscount, laundryDiscount, regDiscount },
                    studentOwes: Math.max(0, effectiveTotal - appliedToNew),
                    feeDemandsCreated,
                },
                refund: {
                    leftover,
                    feeCorrectionId,
                },
            };
        });

        return result;
    },

    async updateAdmissionDetails(data: any, adminId: string | undefined) {
        const { studentId, accommodationType, hostelType, hostelId, transportRouteId, paidAmount, hostelPaymentMode } = data;

        if (!studentId || !accommodationType) throw new AppError(MESSAGES.ERROR.STUDENT_ACCOMMODATION_REQUIRED, 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: true }
        });
        if (!student || !student.admissionDetails) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const admission = student.admissionDetails;
        const oldAccType = admission.accommodationType;
        // Initialize adjustment delta
        let feeAdjustment = 0;
        let oldCost = 0;
        let newCost = 0;
        let oldDescription = '';
        let newDescription = '';

        await prisma.$transaction(async (tx) => {
            // Release previous allocation and calculate subtraction from Total Fee
            if (admission.accommodationType === AccommodationType.HOSTEL && admission.hostelId) {
                if (accommodationType !== AccommodationType.HOSTEL || hostelId !== admission.hostelId) {
                    const oldHostel = await tx.hostel.findUnique({ where: { id: admission.hostelId } });
                    if (oldHostel) {
                        const oldPricing = await getHostelCostTx(admission.hostelType, tx);
                        oldCost = oldPricing.totalPrice;
                        oldDescription = `Hostel: ${oldHostel.name || admission.hostelId}`;
                        feeAdjustment -= oldCost;
                    }
                }
            } else if (admission.accommodationType === AccommodationType.TRANSPORT && admission.transportRouteId) {
                if (accommodationType !== AccommodationType.TRANSPORT || transportRouteId !== admission.transportRouteId) {
                    const oldRoute = await tx.transportRoute.findUnique({ where: { id: admission.transportRouteId } });
                    if (oldRoute) {
                        if ((oldRoute.filled ?? 0) > 0) {
                            await tx.transportRoute.update({
                                where: { id: admission.transportRouteId },
                                data: { filled: { decrement: 1 }, updatedBy: adminId }
                            });
                        }
                        oldCost = oldRoute.cost || 0;
                        oldDescription = `Transport: ${oldRoute.name || admission.transportRouteId}`;
                        feeAdjustment -= oldCost;
                    }
                }
            }

            // Assign new allocation and calculate addition to Total Fee
            if (accommodationType === AccommodationType.HOSTEL) {
                if (!hostelId) throw new AppError(MESSAGES.ERROR.HOSTEL_ID_REQUIRED, 400);

                if (hostelId !== admission.hostelId) {
                    const hostel = await tx.hostel.findUnique({ where: { id: hostelId } });
                    if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

                    await assertHostelHasCapacity(hostelId, tx);

                    const newPricing = await getHostelCostTx(hostelType, tx);
                    newCost = newPricing.totalPrice;
                    newDescription = `Hostel: ${hostel.name || hostelId}`;
                    feeAdjustment += newCost;
                }
            }
            else if (accommodationType === AccommodationType.TRANSPORT) {
                if (!transportRouteId) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_ID_REQUIRED, 400);

                if (transportRouteId !== admission.transportRouteId) {
                    const route = await tx.transportRoute.findUnique({ where: { id: transportRouteId } });
                    if (!route) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_NOT_FOUND, 404);

                    if ((route.filled ?? 0) >= (route.capacity ?? 0)) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_FULL, 400);

                    await tx.transportRoute.update({
                        where: { id: transportRouteId },
                        data: { filled: { increment: 1 }, updatedBy: adminId }
                    });

                    newCost = route.cost || 0;
                    newDescription = `Transport: ${route.name || transportRouteId}`;
                    feeAdjustment += newCost;
                }
            }

            // Handle Hostel Payment Mode Adjustment
            if (admission.accommodationType === AccommodationType.HOSTEL && admission.hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                const oldSemFee = await getSemwiseSurchargeTx(admission.hostelType, tx);
                oldCost += oldSemFee;
                feeAdjustment -= oldSemFee;
            }
            if (accommodationType === AccommodationType.HOSTEL && hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                const newSemFee = await getSemwiseSurchargeTx(hostelType, tx);
                newCost += newSemFee;
                feeAdjustment += newSemFee;
            }

            const currentPaid = (admission.paidFee ?? 0) + Number(paidAmount || 0);
            const newTotalFee = (admission.totalFee ?? 0) + feeAdjustment;

            let feeStatus: FeeStatus = FeeStatus.PENDING;
            if (currentPaid >= newTotalFee && newTotalFee > 0) feeStatus = FeeStatus.FULL;
            else if (currentPaid > 0) feeStatus = FeeStatus.PARTIAL;

            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType,
                    hostelType: accommodationType === AccommodationType.HOSTEL ? hostelType : null,
                    hostelId: accommodationType === AccommodationType.HOSTEL ? hostelId : null,
                    transportRouteId: accommodationType === AccommodationType.TRANSPORT ? transportRouteId : null,
                    totalFee: { increment: feeAdjustment },
                    paidFee: currentPaid,
                    feeStatus,
                    hostelPaymentMode: accommodationType === AccommodationType.HOSTEL ? hostelPaymentMode : null,
                }
            });

            // --- LEDGER & FEE CORRECTION ---
            const academicYearId = admission.academicYearId;
            const changeDescription = oldDescription && newDescription
                ? `Accommodation change: ${oldDescription} → ${newDescription}`
                : oldDescription
                    ? `Accommodation removed: ${oldDescription}`
                    : newDescription
                        ? `Accommodation added: ${newDescription}`
                        : 'Accommodation updated';

            // Calculate how much student paid on the old accommodation type
            const isRealChange = oldAccType && oldAccType !== AccommodationType.NONE && (oldCost > 0 || feeAdjustment !== 0);
            if (isRealChange && academicYearId) {
                const oldComponents = oldAccType === AccommodationType.HOSTEL
                    ? [PaymentComponent.HOSTEL, PaymentComponent.HOSTEL_ACCOMMODATION, PaymentComponent.HOSTEL_MESS]
                    : [PaymentComponent.TRANSPORT];

                const paidOnOld = await tx.payment.aggregate({
                    where: {
                        studentId,
                        status: PaymentStatus.SUCCESS,
                        component: { in: oldComponents }
                    },
                    _sum: { amount: true }
                });
                const totalPaidOnOld = (paidOnOld._sum as any)?.amount || 0;

                // Effective new cost: if same type change (hostel→hostel), use newCost; if type changed or NONE, it's 0
                const effectiveNewCost = (accommodationType === oldAccType) ? newCost : 0;
                const excessPaid = totalPaidOnOld - effectiveNewCost;

                if (excessPaid > 0) {
                    // Settle any previous accommodation corrections first
                    const prevCorrections = await tx.feeCorrection.findMany({
                        where: { studentId, isSettled: false, type: 'ACCOMMODATION_CHANGE_REFUND' }
                    });
                    if (prevCorrections.length > 0) {
                        const prevTotal = prevCorrections.reduce((sum: number, c: any) => sum + c.amount, 0);
                        await tx.feeCorrection.updateMany({
                            where: { id: { in: prevCorrections.map((c: any) => c.id) } },
                            data: { isSettled: true, settledAt: new Date(), settledBy: adminId, remarks: `Settled: reversed by new accommodation change` }
                        });
                        await tx.studentLedger.create({
                            data: {
                                studentId,
                                type: LedgerTransactionType.DEBIT,
                                amount: prevTotal,
                                description: `Previous accommodation corrections reversed (${prevCorrections.length} entries, total: ${prevTotal})`,
                                referenceType: 'FEE_CORRECTION_REVERSAL',
                                academicYearId,
                                createdBy: adminId
                            }
                        });
                        logger.info(`[updateAdmissionDetails] Settled ${prevCorrections.length} previous accommodation corrections for student ${studentId}. Reversed: ${prevTotal}`);
                    }

                    // Create new correction
                    const oldLabel = oldAccType === AccommodationType.HOSTEL ? 'Hostel' : 'Transport';
                    await tx.feeCorrection.create({
                        data: {
                            studentId,
                            academicYearId,
                            amount: excessPaid,
                            reason: `Accommodation change refund: ${oldLabel}. Paid: ${totalPaidOnOld}, New cost: ${effectiveNewCost}, Excess: ${excessPaid}`,
                            type: 'ACCOMMODATION_CHANGE_REFUND',
                            referenceType: 'ACCOMMODATION_CHANGE',
                            remarks: `${changeDescription}. Paid: ${totalPaidOnOld}, Refund: ${excessPaid}`,
                            carryForward: true,
                            isSettled: false,
                            createdBy: adminId
                        }
                    });

                    await tx.studentLedger.create({
                        data: {
                            studentId,
                            type: LedgerTransactionType.CREDIT,
                            amount: excessPaid,
                            description: `Accommodation change refund: ${oldLabel}. Paid ${totalPaidOnOld} against new cost ${effectiveNewCost}. Carry forward.`,
                            referenceType: 'FEE_CORRECTION',
                            academicYearId,
                            createdBy: adminId
                        }
                    });

                    logger.info(`[updateAdmissionDetails] FeeCorrection created for student ${studentId}. Refund: ${excessPaid}, carryForward: true`);
                }
            }

            logger.info(`[updateAdmissionDetails] Accommodation updated for student ${studentId}. ${oldAccType} → ${accommodationType}. Fee adjustment: ${feeAdjustment}`);
        });
    },

    async getStudentCertificates(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                documents: true,
                examDetails: true
            }
        });
    
        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }
    
        // Convert all document URLs to presigned URLs
        const documentPromises = student.documents.map(async (doc: any) => {
            const presignedUrl = await convertToPresignedUrl(doc.url);
            return { key: doc.documentKey, url: presignedUrl };
        });

        const documentArray = await Promise.all(documentPromises);
        const documentMap = documentArray.reduce((acc: any, item) => {
            acc[item.key] = item.url;
            return acc;
        }, {});

        // Convert profile photo and hall ticket URLs
        const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);
        const hallTicketUrl = await convertToPresignedUrl(student.examDetails?.hallTicketUrl);

        return {
            profilePhotoUrl,
            hallTicketUrl,
            ...documentMap
        };
    },

    async generateStudentDocumentsZip(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
    
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                documents: true,
                examDetails: true
            }
        });
    
        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }
    
        const documents = [
            { name: 'profile_photo', url: student.profilePhotoUrl },
            { name: 'hall_ticket', url: student.examDetails?.hallTicketUrl },
            ...student.documents.map((doc: any) => ({ name: doc.documentKey, url: doc.url })),
            { name: 'discount_doc', url: (await prisma.discountRequest.findFirst({ where: { studentId } }))?.documentUrl }
        ].filter(doc => doc.url);
    
        if (documents.length === 0) {
            throw new AppError(MESSAGES.ERROR.NO_DOCUMENTS_FOUND, 400);
        }
    
        const zipFileName = `${student.applicationId}_documents.zip`;
        const tempDir = path.join(__dirname, '../../temp');
        const zipFilePath = path.join(tempDir, zipFileName);
    
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
    
        return new Promise<string>((resolve, reject) => {
            const output = fs.createWriteStream(zipFilePath);
            const archive = archiver('zip', { zlib: { level: 9 } });
    
            output.on('close', () => {
                resolve(zipFilePath);
            });
    
            archive.on('error', (err: any) => {
                reject(err);
            });
    
            archive.pipe(output);
    
            (async () => {
                for (const doc of documents) {
                    if (doc.url) {
                        try {
                            const response = await axios.get(doc.url, { responseType: 'stream' });
                            const ext = path.extname(doc.url) || '.pdf'; 
                            archive.append(response.data, { name: `${doc.name}${ext}` });
                        } catch (err: any) {
                            logger.error(`Failed to download ${doc.name} from ${doc.url}`);
                        }
                    }
                }
                await archive.finalize();
            })();
        });
    },

    async downloadApplication(studentId: string) {
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                admissionDetails: {
                    include: {
                        allottedCourse: true
                    }
                },
                academicQualifications: true,
                documents: true,
                pref1Course: true
            }
        });

        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        // Convert profile photo URL to presigned
        const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);

        // Prepare data for PDF
        const pdfData = {
            applicationId: student.applicationId || 'N/A',
            studentName: student.name,
            dob: student.dob,
            gender: student.gender,
            phone: student.phone,
            email: student.email,
            address: student.address,
            city: student.city,
            state: student.state,
            pincode: student.pincode,
            profilePhotoUrl: profilePhotoUrl,
            
            fatherName: student.fatherName,
            motherName: student.motherName,
            category: student.category,
            
            courseName: student.admissionDetails?.allottedCourse?.name || student.pref1Course?.name || 'Not Listed',
            quotaType: student.quotaType || undefined,
            admissionStatus: student.admissionDetails?.status || undefined,
            
            qualifications: student.academicQualifications.map(q => ({
                level: q.level,
                institution: q.schoolName || q.board,
                board: q.board,
                yearOfPassing: q.yearOfPassing,
                percentage: q.percentage || 0
            })),
            
            documents: student.documents.map(d => ({
                name: d.documentKey,
                status: d.status || 'PENDING'
            }))
        };
        
        return await generateApplicationPDF(pdfData);
    },

    async updateRollNumber(studentId: string, rollNumber: string, sectionId: string, academicYearId: string, userId?: string) {
        const student = await prisma.student.findUnique({
             where: { id: studentId }
        });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        
        // Upsert Enrollment
        const enrollment = await (prisma.studentEnrollment as any).upsert({
            where: { studentId },
            update: { rollNumber, sectionId, academicYearId, updatedBy: userId },
            create: {
                studentId,
                rollNumber,
                sectionId,
                academicYearId,
                createdBy: userId
            }
        });
        
        return enrollment;
    },

    async updateStudentAdmissionStatus(studentId: string, status: AdmissionStatus, adminId: string | undefined) {
        if (!studentId || !status) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        if (!Object.values(AdmissionStatus).includes(status)) {
            throw new AppError('Invalid admission status', 400);
        }
        
        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        await prisma.studentAdmission.update({
            where: { studentId },
            data: { status }
        });

        return { success: true, message: `Admission status updated to ${status}` };
    },

    async setScholarshipEligibility(studentId: string, ruleId: string) {
        if (!studentId || !ruleId) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        const rule = await prisma.scholarshipRule.findUnique({ where: { id: ruleId } });
        if (!rule) throw new AppError('Scholarship Rule not found', 404);
        if (!rule.isActive) throw new AppError('Scholarship Rule is inactive', 400);

        logger.info(`setScholarshipEligibility: eligibleScholarshipRuleId field removed from Student; no-op for student ${studentId}, rule ${ruleId}`);
        return student;
    },

    async updateStudentScores(studentId: string, scores: any, adminId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        const { class12Aggregate, jeePercentile, satScore, vvitPercentile } = scores;

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        // Update StudentExam
        return await prisma.studentExam.upsert({
            where: { studentId },
            update: {
                class12Aggregate,
                jeePercentile,
                satScore,
                vvitPercentile,
                examScore: vvitPercentile ?? undefined,
                updatedBy: adminId
            },
            create: {
                studentId,
                class12Aggregate,
                jeePercentile,
                satScore,
                vvitPercentile,
                examScore: vvitPercentile ?? undefined,
                createdBy: adminId,
                updatedBy: adminId
            }
        });
    },


    async updateStudentPersonalDetails(studentId: string, data: any, adminId: string | undefined) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        // Allow updates to all personal details including phone and aadhar
        const { ...updateData } = data;

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        // 1. Check Email Uniqueness
        if (updateData.email && updateData.email !== student.email) {
            const existingEmail = await prisma.student.findUnique({ where: { email: updateData.email } });
            if (existingEmail) throw new AppError('Email already in use by another student', 400);
            
            // Check against User table
            if (student.userId) {
                const existingUserEmail = await prisma.user.findUnique({ where: { email: updateData.email } });
                if (existingUserEmail && existingUserEmail.id !== student.userId) {
                    throw new AppError('Email already in use by another user', 400);
                }
            } else {
                 const existingUserEmail = await prisma.user.findUnique({ where: { email: updateData.email } });
                 if (existingUserEmail) throw new AppError('Email already in use by a user', 400);
            }
        }

        // 2. Check Phone Uniqueness
        if (updateData.phone && updateData.phone !== student.phone) {
             const existingPhone = await prisma.student.findFirst({ where: { phone: updateData.phone } });
             if (existingPhone) throw new AppError('Phone number already in use by another student', 400);
        }

        // 3. Check Aadhar Uniqueness
        if (updateData.aadharNumber && updateData.aadharNumber !== student.aadharNumber) {
             const existingAadhar = await prisma.student.findFirst({ where: { aadharNumber: updateData.aadharNumber } });
             if (existingAadhar) throw new AppError('Aadhar number already in use by another student', 400);
        }

        await prisma.$transaction(async (tx) => {
             // Update Student
             await tx.student.update({
                 where: { id: studentId },
                 data: {
                     ...updateData,
                     updatedBy: adminId
                 }
             });

             // Update User if linked and email is changed
             if (student.userId && updateData.email && updateData.email !== student.email) {
                 await tx.user.update({
                     where: { id: student.userId },
                     data: { email: updateData.email }
                 });
             }
        });

        // Return presigned profilePhotoUrl if it was updated
        let presignedPhotoUrl: string | null = null;
        if (updateData.profilePhotoUrl) {
            presignedPhotoUrl = await convertToPresignedUrl(updateData.profilePhotoUrl) || updateData.profilePhotoUrl;
        }

        return { success: true, message: 'Student personal details updated successfully', profilePhotoUrl: presignedPhotoUrl };
    },

    async getStudentDetails(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: {
                admissionDetails: {
                    include: {
                        allottedCourse: true,
                        hostel: true,
                        transportRoute: true
                    }
                },
                examDetails: true,
                documents: true,
                academicQualifications: true,
                scholarshipAllocation: { include: { rule: true } },
                studentScholarship: true,
                pref1Course: PREF_COURSE_WITH_CAPACITY,
                pref2Course: PREF_COURSE_WITH_CAPACITY,
                pref3Course: PREF_COURSE_WITH_CAPACITY,
                feeDemands: {
                    include: {
                        feeStructure: {
                            include: { feeHead: true }
                        },
                        payments: true
                    }
                },
                payments: true,
                courseChangeLogs: true,
                courseChangeRequests: {
                    where: { status: { in: ['REQUESTED', 'FORWARDED'] } },
                    orderBy: { createdAt: 'desc' }
                },
                discountRequests: true,
                ledgerEntries: true,
                enrollments: {
                     include: {
                         academicYear: true,
                         section: { include: { batch: true } }
                     }
                },
                hostelAllocations: { where: { status: 'ACTIVE' }, take: 1, orderBy: { startDate: 'desc' }, include: { bed: { include: { room: { include: { hostel: true } } } }, academicYear: { select: { id: true, code: true, isActive: true } } } },
                transportAllocations: { where: { status: 'ACTIVE' }, take: 1, orderBy: { startDate: 'desc' }, include: { route: true, stop: true, academicYear: { select: { id: true, code: true, isActive: true } } } },
                convenorDetails: true,
                pro: true,
                user: { select: { id: true, email: true, phone: true, role: true, isDeleted: true } }
            }
        });

        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        // Convert key documents to presigned
        const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);
        const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
            ...doc,
            url: await convertToPresignedUrl(doc.url)
        })));

        let hallTicketUrl = null;
        if (student.examDetails?.hallTicketUrl) {
            hallTicketUrl = await convertToPresignedUrl(student.examDetails.hallTicketUrl);
        }

        const { hostelAllocations: _hostelAllocations, transportAllocations: _transportAllocations, ...studentRest } = student as any;
        return {
            ...studentRest,
            hostelAllocation: _hostelAllocations?.[0] ?? null,
            transportAllocation: _transportAllocations?.[0] ?? null,
            pref1Course: attachCourseCapacity((student as any).pref1Course),
            pref2Course: attachCourseCapacity((student as any).pref2Course),
            pref3Course: attachCourseCapacity((student as any).pref3Course),
            profilePhotoUrl,
            documents: documentsWithPresignedUrls,
            examDetails: {
                ...student.examDetails,
                hallTicketUrl
            }
        };
    },

    async getStudentDetailsByApplicationId(applicationId: string) {
        if (!applicationId) throw new AppError('Application ID is required', 400);

        const student = await prisma.student.findFirst({
            where: {
                OR: [
                    { applicationId: { contains: applicationId, mode: 'insensitive' } },
                    { name: { contains: applicationId, mode: 'insensitive' } },
                    { email: { contains: applicationId, mode: 'insensitive' } },
                    { phone: { contains: applicationId } },
                ]
            },
            include: {
                admissionDetails: {
                    include: {
                        allottedCourse: true,
                        hostel: true,
                        transportRoute: true
                    }
                },
                examDetails: true,
                documents: true,
                academicQualifications: true,
                scholarshipAllocation: { include: { rule: true } },
                studentScholarship: true,
                pref1Course: PREF_COURSE_WITH_CAPACITY,
                pref2Course: PREF_COURSE_WITH_CAPACITY,
                pref3Course: PREF_COURSE_WITH_CAPACITY,
                feeDemands: {
                    include: {
                        feeStructure: {
                            include: { feeHead: true }
                        },
                        payments: true
                    }
                },
                payments: true,
                courseChangeLogs: true,
                courseChangeRequests: {
                    where: { status: { in: ['REQUESTED', 'FORWARDED'] } },
                    orderBy: { createdAt: 'desc' }
                },
                discountRequests: true,
                ledgerEntries: true,
                enrollments: {
                     include: {
                         academicYear: true,
                         section: { include: { batch: true } }
                     }
                },
                hostelAllocations: { where: { status: 'ACTIVE' }, take: 1, orderBy: { startDate: 'desc' }, include: { bed: { include: { room: { include: { hostel: true } } } }, academicYear: { select: { id: true, code: true, isActive: true } } } },
                transportAllocations: { where: { status: 'ACTIVE' }, take: 1, orderBy: { startDate: 'desc' }, include: { route: true, stop: true, academicYear: { select: { id: true, code: true, isActive: true } } } },
                convenorDetails: true,
                pro: true,
                user: { select: { id: true, email: true, phone: true, role: true, isDeleted: true } }
            }
        });

        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        // Convert key documents to presigned
        const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);
        const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
            ...doc,
            url: await convertToPresignedUrl(doc.url)
        })));

        let hallTicketUrl = null;
        if (student.examDetails?.hallTicketUrl) {
            hallTicketUrl = await convertToPresignedUrl(student.examDetails.hallTicketUrl);
        }

        const { hostelAllocations: _hostelAllocations, transportAllocations: _transportAllocations, ...studentRest } = student as any;
        return {
            ...studentRest,
            hostelAllocation: _hostelAllocations?.[0] ?? null,
            transportAllocation: _transportAllocations?.[0] ?? null,
            pref1Course: attachCourseCapacity((student as any).pref1Course),
            pref2Course: attachCourseCapacity((student as any).pref2Course),
            pref3Course: attachCourseCapacity((student as any).pref3Course),
            profilePhotoUrl,
            documents: documentsWithPresignedUrls,
            examDetails: {
                ...student.examDetails,
                hallTicketUrl
            }
        };
    },

    async updateAcademicQualification(id: string, data: any, adminId: string | undefined) {
        if (!id) throw new AppError('Qualification ID is required', 400);

        const qualification = await prisma.academicQualification.findUnique({
            where: { id }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        return await prisma.academicQualification.update({
            where: { id },
            data: {
                ...data,
                updatedBy: adminId
            }
        });
    },

    async deleteAcademicQualification(id: string) {
        if (!id) throw new AppError('Qualification ID is required', 400);

        const qualification = await prisma.academicQualification.findUnique({
            where: { id }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        await prisma.academicQualification.delete({
            where: { id }
        });

        return { success: true, message: 'Qualification deleted successfully' };
    },

    async validateAcademicQualification(qualificationId: string, status: string, remarks: string | undefined, adminId: string | undefined) {
        if (!qualificationId || !status) throw new AppError(MESSAGES.ERROR.ALL_FIELDS_REQUIRED, 400);

        const qualification = await prisma.academicQualification.findUnique({
             where: { id: qualificationId }
        });

        if (!qualification) throw new AppError('Qualification not found', 404);

        // Update verification column via Prisma
        const updatedQualification = await prisma.academicQualification.update({
            where: { id: qualificationId },
            data: {
                verificationStatus: status,
                remarks: remarks ?? null,
                verifiedBy: adminId ?? null,
                updatedBy: adminId ?? null
            }
        });

        return { success: true, message: 'Qualification status updated successfully' };
    },
    
    async updateStudentScholarship(studentId: string, data: any, adminId: string | undefined) {
         if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

         const { id, type, degreeType, score, remarks, scholarshipPercentage, qualificationId, isEligible } = data;

         // Check if qualification exists if provided
         if (qualificationId) {
             const qual = await prisma.academicQualification.findUnique({ where: { id: qualificationId } });
             if (!qual) throw new AppError('Qualification not found', 404);
         }

         // Check if scholarship already exists for this student
         const existing = await prisma.studentScholarship.findFirst({
             where: { studentId }
         });

         if (existing) {
             // UPDATE Existing (Dynamic Update as requested)
             // key fields to exclude from update
             const { studentId: _sid, id: _id, ...updateProps } = data;

             // Apply conversions if specific fields are present
             if (updateProps.score !== undefined) updateProps.score = Number(updateProps.score);
             if (updateProps.scholarshipPercentage !== undefined) {
                 updateProps.scholarshipPercentage = Number(updateProps.scholarshipPercentage);
                 if (updateProps.scholarshipPercentage > 0) updateProps.isEligible = 'YES';
             }

             // Check qualification existence if updating it
             if (updateProps.qualificationId) {
                  const qual = await prisma.academicQualification.findUnique({ where: { id: updateProps.qualificationId } });
                  if (!qual) throw new AppError('Qualification not found', 404);
             }

             const oldPct = existing.scholarshipPercentage || 0;

             const updated = await prisma.$transaction(async (tx) => {
                 const result = await tx.studentScholarship.update({
                     where: { id: existing.id },
                     data: {
                         ...updateProps,
                         updatedBy: adminId
                     }
                 });

                 // Propagate fee changes when scholarship percentage is updated
                 const newPct = result.scholarshipPercentage || 0;
                 await this.propagateScholarshipUpdate(studentId, newPct, adminId, tx);

                 return result;
             });

             // Send email notification if percentage changed
             const newPct = updated.scholarshipPercentage || 0;
             if (oldPct !== newPct) {
                 const student = await prisma.student.findUnique({
                     where: { id: studentId },
                     select: { name: true, email: true, applicationId: true },
                 });
                 if (student?.email) {
                     sendScholarshipUpdateEmail(student.email, {
                         studentName: student.name,
                         applicationId: student.applicationId || studentId.substring(0, 8).toUpperCase(),
                         oldPercentage: oldPct,
                         newPercentage: newPct,
                     }).catch(err => logger.warn(`[updateStudentScholarship] Email failed (non-fatal): ${err}`));
                 }

                 // Regenerate allotment order only if student has an allotted course
                 try {
                     const adm = await prisma.studentAdmission.findUnique({
                         where: { studentId },
                         select: { allottedCourseId: true }
                     });
                     if (adm?.allottedCourseId) {
                         await generateAndSaveAllotmentOrder(studentId);
                         logger.info(`[updateStudentScholarship] Allotment order regenerated for student ${studentId}`);
                     }
                 } catch (err) {
                     logger.error(`[updateStudentScholarship] Failed to regenerate allotment order: ${err}`);
                 }
             }

             return updated;
         }

         // CREATE New — tag with the active academic year (required since the phase-3 year-tag migration).
         const newScholarshipYearId: string = (await getActiveAcademicYear()).id;
         const newScholarship = await prisma.studentScholarship.create({
             data: {
                 studentId,
                 type,
                 degreeType,
                 score: score !== undefined ? Number(score) : undefined,
                 remarks,
                 scholarshipPercentage: scholarshipPercentage !== undefined ? Number(scholarshipPercentage) : undefined,
                 qualificationId,
                 academicYearId: newScholarshipYearId,
                 isEligible: (scholarshipPercentage !== undefined && Number(scholarshipPercentage) > 0) ? 'YES' : isEligible,
                 createdBy: adminId,
                 updatedBy: adminId
             }
         });
         
         // Propagate changes for NEW scholarship too (if fee demands exist)
         const newPct = newScholarship.scholarshipPercentage || 0;
         if (newPct > 0) {
             await prisma.$transaction(async (tx) => {
                  await this.propagateScholarshipUpdate(studentId, newPct, adminId, tx);
             });

             // Send email notification for new scholarship
             const student = await prisma.student.findUnique({
                 where: { id: studentId },
                 select: { name: true, email: true, applicationId: true },
             });
             if (student?.email) {
                 sendScholarshipUpdateEmail(student.email, {
                     studentName: student.name,
                     applicationId: student.applicationId || studentId.substring(0, 8).toUpperCase(),
                     oldPercentage: 0,
                     newPercentage: newPct,
                 }).catch(err => logger.warn(`[updateStudentScholarship] Email failed (non-fatal): ${err}`));
             }

             // Regenerate allotment order only if student has an allotted course
             try {
                 const adm = await prisma.studentAdmission.findUnique({
                     where: { studentId },
                     select: { allottedCourseId: true }
                 });
                 if (adm?.allottedCourseId) {
                     await generateAndSaveAllotmentOrder(studentId);
                     logger.info(`[updateStudentScholarship] Allotment order regenerated for student ${studentId}`);
                 }
             } catch (err) {
                 logger.error(`[updateStudentScholarship] Failed to regenerate allotment order: ${err}`);
             }
         }

         return newScholarship;
    },

    async getStudentScholarships(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        return await prisma.studentScholarship.findMany({
            where: { studentId },
            include: { qualification: true },
            orderBy: { createdAt: 'desc' }
        });
    },

    async editStudentScholarship(scholarshipId: string, data: any, adminId: string | undefined) {
        if (!scholarshipId) throw new AppError('Scholarship ID is required', 400);

        const existing = await prisma.studentScholarship.findUnique({ where: { id: scholarshipId } });
        if (!existing) throw new AppError('Scholarship record not found', 404);

        const { type, degreeType, score, remarks, scholarshipPercentage, qualificationId, isEligible } = data;

        // Check qualification existence if updating it
        if (qualificationId) {
             const qual = await prisma.academicQualification.findUnique({ where: { id: qualificationId } });
             if (!qual) throw new AppError('Qualification not found', 404);
        }

        const oldPct = existing.scholarshipPercentage || 0;

        const updatedScholarship = await prisma.$transaction(async (tx) => {
            // 1. Update the Scholarship Record
            const result = await tx.studentScholarship.update({
                where: { id: scholarshipId },
                data: {
                    type,
                    degreeType,
                    score: score ? Number(score) : undefined,
                    remarks,
                    scholarshipPercentage: scholarshipPercentage ? Number(scholarshipPercentage) : undefined,
                    qualificationId,
                    isEligible,
                    updatedBy: adminId
                }
            });

            // 2. Propagate Changes to Demands & Ledger (Using Helper)
            const newPct = result.scholarshipPercentage || 0;
            const sid = result.studentId;

            logger.info(`[editStudentScholarship] Propagating update to ${newPct}% for student ${sid}`);

            await this.propagateScholarshipUpdate(sid, newPct, adminId, tx);

            return result;
        });

        // Send email notification if percentage changed
        const newPct = updatedScholarship.scholarshipPercentage || 0;
        if (oldPct !== newPct) {
            const student = await prisma.student.findUnique({
                where: { id: updatedScholarship.studentId },
                select: { name: true, email: true, applicationId: true },
            });
            if (student?.email) {
                sendScholarshipUpdateEmail(student.email, {
                    studentName: student.name,
                    applicationId: student.applicationId || updatedScholarship.studentId.substring(0, 8).toUpperCase(),
                    oldPercentage: oldPct,
                    newPercentage: newPct,
                }).catch(err => logger.warn(`[editStudentScholarship] Email failed (non-fatal): ${err}`));
            }

            // Regenerate allotment order only if student has an allotted course
            try {
                const adm = await prisma.studentAdmission.findUnique({
                    where: { studentId: updatedScholarship.studentId },
                    select: { allottedCourseId: true }
                });
                if (adm?.allottedCourseId) {
                    await generateAndSaveAllotmentOrder(updatedScholarship.studentId);
                    logger.info(`[editStudentScholarship] Allotment order regenerated for student ${updatedScholarship.studentId}`);
                }
            } catch (err) {
                logger.error(`[editStudentScholarship] Failed to regenerate allotment order: ${err}`);
            }
        }

        return updatedScholarship;
    },

    async getScholarshipStats() {
        // Group by degreeType and scholarshipPercentage
        const dbStats = await prisma.studentScholarship.groupBy({
            by: ['degreeType', 'scholarshipPercentage'],
            where: {
                student: {
                    admissionDetails: {
                        allottedCourseId: { not: null }
                    }
                }
            },
            _count: {
                studentId: true
            }
        });

        // Define required combinations
        const manualDefaults = [
            { degreeType: 'B.Tech', scholarshipPercentage: 50, total: 400 },
            { degreeType: 'B.Tech', scholarshipPercentage: 25, total: 200 },
            { degreeType: 'B.Tech', scholarshipPercentage: 15, total: 400 },
            { degreeType: 'BBA', scholarshipPercentage: 50, total: 0 },
            { degreeType: 'BBA', scholarshipPercentage: 30, total: 0 },
            { degreeType: 'M.Tech', scholarshipPercentage: 50, total: 0 },
            { degreeType: 'M.Tech', scholarshipPercentage: 25, total: 0 },
            { degreeType: 'MCA', scholarshipPercentage: 50, total: 0 },
            { degreeType: 'MCA', scholarshipPercentage: 25, total: 0 },
            { degreeType: 'MBA', scholarshipPercentage: 50, total: 0 },
            { degreeType: 'MBA', scholarshipPercentage: 25, total: 0 }
        ];

        // Create a map of existing stats
        // Key: "DegreeType-Percentage"
        const statsMap = new Map();
        dbStats.forEach(item => {
            const key = `${item.degreeType}-${item.scholarshipPercentage}`;
            statsMap.set(key, item._count.studentId);
        });

        const finalStats: { degreeType: string; scholarshipPercentage: number | null; count: number; total: number }[] = [];

        // 1. Add required defaults (overwriting with actuals if present)
        manualDefaults.forEach(def => {
            const key = `${def.degreeType}-${def.scholarshipPercentage}`;
            const count = statsMap.get(key) || 0;
            finalStats.push({
                degreeType: def.degreeType,
                scholarshipPercentage: def.scholarshipPercentage,
                count: count,
                total: def.total
            });
            // Mark as processed so we don't duplicate if we want to show "others"
            statsMap.delete(key);
        });

        // 2. Add any other combinations found in DB that were not in manual defaults
        dbStats.forEach(item => {
             const isDefault = manualDefaults.some(d => d.degreeType === item.degreeType && d.scholarshipPercentage === item.scholarshipPercentage);
             if (!isDefault) {
                 finalStats.push({
                     degreeType: item.degreeType || 'Unknown',
                     scholarshipPercentage: item.scholarshipPercentage,
                     count: item._count.studentId,
                     total: 0
                 });
             }
        });

        return finalStats;

    },



    // --- HELPER: Propagate Scholarship Changes ---
    propagateScholarshipUpdate: async (studentId: string, newPct: number, adminId: string | undefined, tx: any) => {
        logger.info(`[propagateScholarshipUpdate] Updating demands to ${newPct}% for student ${studentId}`);

        // Fetch demands with their linked Fee Heads (Direct or via Structure)
        const demands = await tx.studentFeeDemand.findMany({
            where: { studentId },
            include: { 
                feeHead: true, 
                feeStructure: { include: { feeHead: true } } 
            }
        });

        // Filter to demands tied to the TUITION component (strict — no name keyword match)
        const tuitionDemands = demands.filter((d: any) => {
            const head = d.feeHead || d.feeStructure?.feeHead;
            return head?.component === 'TUITION';
        });

        for (const demand of tuitionDemands) {
            const baseAmount = demand.amount; 
            const newDiscount = (baseAmount * newPct) / 100;
            const newNet = baseAmount - newDiscount;

            logger.info(`[propagateScholarshipUpdate] Updating Demand ${demand.id}: Base=${baseAmount}, NewDiscount=${newDiscount}`);

            // A. Update Demand
            await tx.studentFeeDemand.update({
                where: { id: demand.id },
                data: {
                    scholarshipAmount: newDiscount,
                    discountAmount: newDiscount,
                    netAmount: newNet,
                    remarks: `Scholarship applied: ${newPct}%`
                }
            });

            // B. Update/Create Ledger
            const ledger = await tx.studentLedger.findFirst({
                where: {
                    referenceId: demand.id,
                    referenceType: 'SCHOLARSHIP',
                    type: 'CREDIT',
                    isDeleted: false
                }
            });

            if (ledger) {
                if (newDiscount > 0) {
                    await tx.studentLedger.update({
                        where: { id: ledger.id },
                        data: {
                            amount: newDiscount,
                            description: `Scholarship (${newPct}%)`,
                            createdBy: adminId
                        }
                    });
                } else {
                    await tx.studentLedger.delete({ where: { id: ledger.id } });
                }
            } else if (newDiscount > 0) {
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: 'CREDIT', // Cast if needed
                        amount: newDiscount,
                        description: `Scholarship (${newPct}%)`,
                        referenceId: demand.id,
                        referenceType: 'SCHOLARSHIP',
                        feeHeadId: demand.feeHeadId,
                        createdBy: adminId
                    } as any
                });
            }
        }
    },

    /**
     * Helper: Processes logic after a successful payment (Offline or Online Verification).
     * Handles: Ledger Creation, Paid Fee Update, Demand Settlement, and Admission Updates.
     */
    async processPaymentSuccess(payment: any, adminId: string | undefined, tx: any) {
        const resolvedAdminId = adminId || 'SYSTEM';

        // Guard: skip if ledger entry already exists for this payment (prevents duplicate from race condition)
        const existingLedger = await tx.studentLedger.findFirst({
            where: {
                referenceId: payment.id,
                referenceType: 'PAYMENT',
                studentId: payment.studentId
            }
        });
        if (existingLedger) {
            logger.warn(`[processPaymentSuccess] Ledger already exists for payment ${payment.id}. Skipping duplicate.`);
            return;
        }

        // 1. Create Ledger Entry
        await tx.studentLedger.create({
            data: {
                studentId: payment.studentId,
                type: LedgerTransactionType.CREDIT,
                amount: payment.amount,
                description: `Admission Payment (${payment.method || 'ONLINE'}) - ${payment.component || 'FEE'}`,
                referenceId: payment.id,
                referenceType: 'PAYMENT',
                feeHeadId: payment.feeHeadId,
                createdBy: resolvedAdminId
            }
        });

        // 2. Increment Paid Fee
        await tx.studentAdmission.update({
             where: { studentId: payment.studentId },
             data: { paidFee: { increment: payment.amount } }
        });

        // 3. Settle Fee Demand (if linked)
        if (payment.feeDemandId) {
             const demand = await tx.studentFeeDemand.findUnique({ where: { id: payment.feeDemandId } });
             if (demand) {
                 // Check if fully paid (compare against netAmount if exists, else amount)
                 const targetAmount = demand.netAmount ?? demand.amount;
                 const newStatus = payment.amount >= targetAmount ? 'FULL' : 'PARTIAL';

                 await tx.studentFeeDemand.update({
                     where: { id: payment.feeDemandId },
                     data: { status: newStatus }
                 });
             }
        }

        // 4. Execute Admission Updates (Allocation/Scholarship) if metadata dictates
        const meta = payment.metadata as any;
        if (meta && meta.targetAction === 'FINALIZE_ADMISSION') {
             await this.executeAdmissionUpdates(payment.studentId, meta, payment.id, resolvedAdminId, tx);
        }
    },

    async sendAdmissionSuccessEmail(paymentId: string) {
         try {
             const p = await prisma.payment.findUnique({ 
                 where: { id: paymentId },
                 include: { student: true }
             });

             if (p && p.student.email) {
                let invoiceUrl = p.invoiceUrl;
                if (invoiceUrl) {
                    invoiceUrl = await convertToPresignedUrl(invoiceUrl);
                }

                // Derive Payment Name
                let paymentTypeName = 'Admission Fee'; 
                let emailPaymentType = 'ADMISSION_FEE';

                if (p.component === PaymentComponent.TUITION) {
                    paymentTypeName = 'Tuition Fee';
                    emailPaymentType = 'TUITION_FEE';
                } else if (p.component === PaymentComponent.APPLICATION_FEE) {
                    paymentTypeName = 'Application Fee';
                    emailPaymentType = 'APPLICATION_FEE';
                } else if (p.component === PaymentComponent.SCHOLARSHIP_TOKEN) {
                    paymentTypeName = 'Admission Fee';
                     emailPaymentType = 'ADMISSION_FEE';
                }

                await sendPaymentReceipt(p.student.email, {
                    studentName: p.student.name,
                    invoiceNumber: p.referenceNumber || p.id, 
                    applicationId: p.student.applicationId || 'N/A',
                    transactionId: p.referenceNumber || p.providerTxId || 'N/A',
                    amount: p.amount,
                    date: new Date(),
                    paymentType: emailPaymentType as any, 
                    customFeeType: paymentTypeName, 
                    invoiceUrl: invoiceUrl || undefined,
                    address: {
                        line1: p.student.address,
                        line2: p.student.address2 || '',
                        city: p.student.city,
                        state: p.student.state,
                        pincode: p.student.pincode
                    }
                });
                logger.info(`[sendAdmissionSuccessEmail] Email receipt sent to ${p.student.email}`);
             }
         } catch(e) {
             logger.error(`[sendAdmissionSuccessEmail] Failed to send email: ${e}`);
         }
    },

    async executeAdmissionUpdates(studentId: string, payload: any, paymentId: string, adminId: string, tx: any) {
        try {
            const { allocation, scholarship, course } = payload;
            logger.info(`[executeAdmissionUpdates] Allocation: ${allocation.type}, Scholarship: ${scholarship.percentage}%`);

            // --- 1. Accommodation Handling ---
            logger.debug(`[executeAdmissionUpdates] Processing Accommodation: ${allocation?.type}`);
            const student = await tx.student.findUnique({ where: { id: studentId }, include: { admissionDetails: true } });
            const oldAdmission = student?.admissionDetails;

            const ayId = oldAdmission?.academicYearId;
            if (!ayId) {
                throw new AppError('Student admission / academic year not found', 404);
            }

            // Release old seats if any
            if (oldAdmission) {
                if (oldAdmission.transportRouteId && (oldAdmission.transportRouteId !== allocation.transportRouteId || allocation.type !== AccommodationType.TRANSPORT)) {
                     logger.debug(`[executeAdmissionUpdates] Releasing old transport seat: ${oldAdmission.transportRouteId}`);
                     await tx.transportRoute.update({ where: { id: oldAdmission.transportRouteId }, data: { filled: { decrement: 1 } } });
                }
                // Course Seat (Decrement old if different)
                if (oldAdmission.allottedCourseId && oldAdmission.allottedCourseId !== course.allottedCourseId) {
                     logger.debug(`[executeAdmissionUpdates] Releasing old course seat: ${oldAdmission.allottedCourseId}`);
                     await decrementCourseCapacity(tx, oldAdmission.allottedCourseId, ayId);
                }
            }

            // Assign New Accommodation (hostel "filled" is computed on-demand from StudentAdmission.hostelId)
            if (allocation.type === AccommodationType.TRANSPORT) {
                logger.debug(`[executeAdmissionUpdates] Assigning new transport seat: ${allocation.transportRouteId}`);
                await tx.transportRoute.update({ where: { id: allocation.transportRouteId }, data: { filled: { increment: 1 } } });
            }

            // --- 2. Course Allocation ---
            if (!oldAdmission?.allottedCourseId || oldAdmission.allottedCourseId !== course.allottedCourseId) {
                logger.debug(`[executeAdmissionUpdates] Assigning new course seat: ${course.allottedCourseId}`);
                // Atomic check-and-increment via helper (prevents TOCTOU overbooking).
                const claimed = await tryAtomicIncrementCourseCapacity(tx, course.allottedCourseId, ayId);
                if (!claimed) {
                    const cap = await getCourseCapacity(tx, course.allottedCourseId, ayId);
                    logger.warn(`[executeAdmissionUpdates] Course ${course.allottedCourseId} is fully booked (${cap.filledSeats}/${cap.totalSeats}) for AY ${ayId}`);
                    throw new AppError("Course is fully booked. No seats available.", 400);
                }
            }

            // --- Calculate Accommodation Cost Delta ---
            let accCostDelta = 0;

            // 1. Subtract Old Cost
            if (oldAdmission) {
                 if (oldAdmission.accommodationType === AccommodationType.HOSTEL && oldAdmission.hostelId) {
                     const oldMode = oldAdmission.hostelPaymentMode === HostelPaymentMode.SEMWISE ? 'SEMWISE' : 'YEARWISE';
                     const oldPricing = await getHostelCostTx(oldAdmission.hostelType, tx, oldMode);
                     accCostDelta -= oldPricing.totalPrice;
                 } else if (oldAdmission.accommodationType === AccommodationType.TRANSPORT && oldAdmission.transportRouteId) {
                     const r = await tx.transportRoute.findUnique({ where: { id: oldAdmission.transportRouteId } });
                     if (r) accCostDelta -= (r.cost || 0);
                 }
            }

            // 2. Add New Cost
            if (allocation.type === AccommodationType.HOSTEL && allocation.hostelId) {
                 const newMode = allocation.hostelPaymentMode === HostelPaymentMode.SEMWISE ? 'SEMWISE' : 'YEARWISE';
                 const newPricing = await getHostelCostTx(allocation.hostelType, tx, newMode);
                 accCostDelta += newPricing.totalPrice;
             } else if (allocation.type === AccommodationType.TRANSPORT && allocation.transportRouteId) {
                 const r = await tx.transportRoute.findUnique({ where: { id: allocation.transportRouteId } });
                 if (r) accCostDelta += (r.cost || 0);
             }
            
            logger.debug(`[executeAdmissionUpdates] Total Fee Adjustment: ${accCostDelta}`);

            // --- Determine Base Tuition Fee (For New Admissions) ---
            let baseTuition = 0;
            const isNewAdmission = !oldAdmission || (oldAdmission.status !== AdmissionStatus.ADMISSION_CONFIRMED && oldAdmission.status !== AdmissionStatus.ENROLLED);

            // --- 3. Update Admission Record ---
            logger.debug(`[executeAdmissionUpdates] Updating Student Admission record`);
            await tx.studentAdmission.upsert({
                where: { studentId },
                update: {
                    status: AdmissionStatus.ADMISSION_CONFIRMED,
                    allottedCourseId: course.allottedCourseId,
                    accommodationType: allocation.type,
                    hostelId: allocation.type === AccommodationType.HOSTEL ? allocation.hostelId : null,
                    hostelType: allocation.type === AccommodationType.HOSTEL ? allocation.hostelType : null,
                    hostelPaymentMode: allocation.type === AccommodationType.HOSTEL ? allocation.hostelPaymentMode : null,
                    transportRouteId: allocation.type === AccommodationType.TRANSPORT ? allocation.transportRouteId : null,
                    totalFee: { increment: (accCostDelta + baseTuition) },
                    seatAllottedAt: new Date()
                },
                create: {
                    studentId,
                    status: AdmissionStatus.ADMISSION_CONFIRMED,
                    allottedCourseId: course.allottedCourseId,
                    accommodationType: allocation.type,
                    hostelId: allocation.type === AccommodationType.HOSTEL ? allocation.hostelId : null,
                    hostelType: allocation.type === AccommodationType.HOSTEL ? allocation.hostelType : null,
                    hostelPaymentMode: allocation.type === AccommodationType.HOSTEL ? allocation.hostelPaymentMode : null,
                    transportRouteId: allocation.type === AccommodationType.TRANSPORT ? allocation.transportRouteId : null,
                    totalFee: (accCostDelta + baseTuition) > 0 ? (accCostDelta + baseTuition) : 0,
                    seatAllottedAt: new Date()
                }
            });
            
            // --- 4. Update Scholarship ---
            const scholarshipPct = scholarship.percentage ?? 0;
            await tx.studentScholarship.update({
                where: { studentId },
                data: {
                    scholarshipPercentage: scholarshipPct,
                    isEligible: scholarshipPct > 0 ? 'YES' : 'NO',
                    updatedBy: adminId
                }
            });
            logger.debug(`[executeAdmissionUpdates] Scholarship updated: percentage=${scholarshipPct}`);

            if (scholarshipPct > 0) {
                await this.propagateScholarshipUpdate(studentId, scholarshipPct, adminId, tx);
            }

            logger.info(`[executeAdmissionUpdates] Successfully completed all updates for student=${studentId}`);
        } catch (error) {
            logger.error(`[executeAdmissionUpdates] Failed to execute updates: ${error}`);
            throw error; 
        }
    },

    /**
     * Finalizes the admission process for a student.
     * 
     * Handles two flows:
     * 1. ONLINE: Creates a Pending Payment and returns a Payment Link (PhonePe).
     * 2. OFFLINE: Creates a Success Payment immediately and finalizes admission (Allocation, Ledger, etc).
     * 
     * @param payload - Contains payment details, allocation preferences, and scholarship info.
     * @param adminId - ID of the admin performing the action.
     */
    async finalizeAdmission(payload: any, adminId: string) {
        logger.info(`[finalizeAdmission] Request received for student=${payload.studentId} method=${payload?.payment?.method}`);
        logger.debug(`[finalizeAdmission] Full Payload: ${JSON.stringify(payload)}`);
        
        // Ensure allocation exists (default to NONE) - User Request: neither hostel/transport mandatory
        if (!payload.allocation) {
            payload.allocation = { type: AccommodationType.NONE };
        }
        
        const { studentId, payment, scholarship, allocation, course } = payload;
        
        // 1. Validation Checks (Parallelized for Performance)
        const [student, validCourse, validFeeHead, validFeeStructure] = await Promise.all([
            prisma.student.findUnique({
                where: { id: studentId },
                include: { admissionDetails: true }
            }),
            prisma.course.findUnique({ where: { id: course.allottedCourseId } }),
            payment.feeHeadId ? prisma.feeHead.findUnique({ where: { id: payment.feeHeadId } }) : Promise.resolve({ id: 'skip' }),
            payment.feeStructureId ? prisma.feeStructure.findUnique({ where: { id: payment.feeStructureId } }) : Promise.resolve({ id: 'skip' })
        ]);

        if (!student) {
            logger.warn(`[finalizeAdmission] Student not found: ${studentId}`);
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const blockedStatuses: AdmissionStatus[] = [AdmissionStatus.ADMISSION_CONFIRMED, AdmissionStatus.ENROLLED, AdmissionStatus.CANCELLED];
        if (student.admissionDetails?.status && blockedStatuses.includes(student.admissionDetails.status)) {
             logger.info(`[finalizeAdmission] Student ${studentId} cannot be finalized (Status: ${student.admissionDetails?.status})`);
             throw new AppError("Student admission cannot be finalized in its current status.", 400);
        }
        // Refuse if the admission's academic year has been locked.
        if (student.admissionDetails?.academicYearId) {
            await assertAcademicYearWritable(student.admissionDetails.academicYearId);
        }

        if (!validCourse) {
            logger.warn(`[finalizeAdmission] Invalid Course ID: ${course.allottedCourseId}`);
            throw new AppError("Invalid Course ID" , 400);
        }

        if (!payment.amount || payment.amount <= 0) {
            logger.warn(`[finalizeAdmission] Invalid payment amount: ${payment.amount}`);
            throw new AppError("Payment amount must be greater than zero", 400);
        }

        // Check Mandatory Fee Head ID (Exempting specific types)
        const exemptComponents = [
            'HOSTEL_ACCOMMODATION',
            'HOSTEL_MESS',
            'TRANSPORT',
            'OTHER',
            'HOSTEL'
        ];

        if (!payment.feeHeadId && !exemptComponents.includes(payment.component || '')) {
            logger.warn(`[finalizeAdmission] Fee Head ID missing for student ${studentId} (Component: ${payment.component})`);
            throw new AppError("Fee Head ID is mandatory for admission finalization", 400);
        }

        if (payment.feeHeadId && !validFeeHead) {
            logger.warn(`[finalizeAdmission] Invalid Fee Head ID: ${payment.feeHeadId}`);
            throw new AppError("Invalid Fee Head ID", 400);
        }

        // Validate Allocation IDs
        if (allocation.type === AccommodationType.HOSTEL && allocation.hostelId) {
            const h = await prisma.hostel.findUnique({ where: { id: allocation.hostelId } });
            if (!h) {
                 logger.warn(`[finalizeAdmission] Invalid Hostel ID: ${allocation.hostelId}`);
                 throw new AppError("Invalid Hostel ID", 400);
            }
        }
        if (allocation.type === AccommodationType.TRANSPORT && allocation.transportRouteId) {
            const r = await prisma.transportRoute.findUnique({ where: { id: allocation.transportRouteId } });
            if (!r) {
                 logger.warn(`[finalizeAdmission] Invalid Transport Route ID: ${allocation.transportRouteId}`);
                 throw new AppError("Invalid Transport Route ID", 400);
            }
        }

        // Apply HOSTEL allocation up-front: flip accommodationType + create
        // StudentAccommodationPricing snapshot + 4 hostel StudentFeeDemand rows
        // + increment totalFee. This way, hostel components passed in
        // payment.component reconcile against demands that already exist.
        // Idempotent: assignHostel handles re-assignment before bed allocation.
        if (
            allocation.type === AccommodationType.HOSTEL &&
            allocation.hostelType &&
            allocation.hostelPaymentMode
        ) {
            // Body no longer requires hostelId — fall back to whatever the student
            // already has on their admission row (set in an earlier seat-allotment / assign-hostel step).
            const targetHostelId = allocation.hostelId
                ?? student.admissionDetails?.hostelId
                ?? null;

            if (!targetHostelId) {
                // No hostelId in body and none on admission. Skip the hostel allocation
                // block entirely — admin can run assign-hostel later.
                logger.warn(`[finalizeAdmission] HOSTEL allocation skipped for student=${studentId} — no hostelId in body and none on admission. Run assign-hostel later to set up hostel pricing/demands.`);
            } else {
                const hostelResult = await AdminStudentService.assignHostel(
                    studentId,
                    targetHostelId,
                    allocation.hostelPaymentMode as 'YEARWISE' | 'SEMWISE',
                    allocation.hostelType as HostelType,
                    adminId
                );
                if (hostelResult.feeDemandsCreated > 0) {
                    logger.info(`[finalizeAdmission] Hostel snapshot+demands created via assignHostel for student=${studentId} hostelId=${targetHostelId} type=${allocation.hostelType} mode=${allocation.hostelPaymentMode} demandsCreated=${hostelResult.feeDemandsCreated}`);
                } else {
                    logger.warn(`[finalizeAdmission] Hostel snapshot created BUT no fee demands for student=${studentId} — likely no FeeHead tagged with HOSTEL_ACCOMMODATION/MESS/LAUNDRY/REGISTRATION components, OR all component prices are 0. Result=${JSON.stringify(hostelResult)}`);
                }
            }
        }

        // Apply TRANSPORT allocation up-front: flip accommodationType + create
        // single TRANSPORT StudentFeeDemand using route.cost + increment totalFee.
        // Idempotent: assignTransport handles re-assignment before TransportAllocation row exists.
        if (
            allocation.type === AccommodationType.TRANSPORT &&
            allocation.transportRouteId
        ) {
            const transportResult = await AdminStudentService.assignTransport(
                studentId,
                allocation.transportRouteId,
                adminId
            );
            if (transportResult.feeDemandsCreated > 0) {
                logger.info(`[finalizeAdmission] Transport demand created via assignTransport for student=${studentId} routeId=${allocation.transportRouteId} cost=${transportResult.cost}`);
            } else if (transportResult.missingFeeHead) {
                logger.warn(`[finalizeAdmission] Transport demand NOT created for student=${studentId} — ${transportResult.missingFeeHead}`);
            } else {
                logger.warn(`[finalizeAdmission] Transport demand NOT created for student=${studentId} routeId=${allocation.transportRouteId} — route cost may be 0 (got cost=${transportResult.cost})`);
            }
        }

        // Validate Fee Structure ID if provided and resolve Demand
        // validFeeStructure is either the fetched record or {id:'skip'} (when feeStructureId was not provided).
        // When feeStructureId IS provided, Promise.all ran prisma.feeStructure.findUnique which returns Object | null.
        let feeDemandId = null;
        if (payment.feeStructureId) {
            if (!validFeeStructure || (validFeeStructure as any).id === 'skip') {
                logger.warn(`[finalizeAdmission] Invalid Fee Structure ID: ${payment.feeStructureId}`);
                throw new AppError("Invalid Fee Structure ID", 400);
            }

            // Try to find matching Demand to link
            const demand = await prisma.studentFeeDemand.findFirst({
                where: {
                    studentId,
                    feeStructureId: payment.feeStructureId
                }
            });
            if (demand) {
                feeDemandId = demand.id;
                logger.info(`[finalizeAdmission] Linking payment to existing Demand: ${demand.id}`);
            }
        }

        // 2. Identify Flow
        const isOnline = !([
            PaymentMethod.CASH, 
            PaymentMethod.CHEQUE, 
            PaymentMethod.DEMAND_DRAFT,
            PaymentMethod.NEFT,
            PaymentMethod.RTGS,
            PaymentMethod.IMPS,
            PaymentMethod.NEFT_RTGS
        ].includes(payment.method));
        logger.info(`[finalizeAdmission] Flow Type detected: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);

            if (isOnline) {
             // === ONLINE FLOW (Initiate) ===
             try {

             const targetComponent = payment.component || PaymentComponent.TUITION;

             // ------------------------------------------------------------------
             // BLOCK 3 & 4: IDEMPOTENCY CHECK + CREATE — wrapped in a transaction
             // to prevent duplicate PENDING records under concurrent requests.
             // ------------------------------------------------------------------
             let newPayment = await prisma.$transaction(async (itx) => {
                 const existingPending = await itx.payment.findFirst({
                     where: {
                         studentId,
                         component: targetComponent,
                         status: PaymentStatus.PENDING
                     }
                 });

                 if (existingPending) {
                     logger.info(`[finalizeAdmission] Found existing PENDING payment ${existingPending.id}. Reusing it.`);
                     // Refresh amount and metadata with the latest payload in case they changed
                     const refreshed = await itx.payment.update({
                         where: { id: existingPending.id },
                         data: {
                             amount: payment.amount,
                             providerTxId: (existingPending.providerTxId?.startsWith('TXN_'))
                                 ? existingPending.providerTxId
                                 : `TXN_${Date.now()}_${studentId.substring(0, 8)}`,
                             metadata: {
                                 scholarship,
                                 allocation,
                                 course,
                                 feeComponent: targetComponent,
                                 amount: payment.amount,
                                 feeStructureId: payment.feeStructureId,
                                 targetAction: 'FINALIZE_ADMISSION'
                             }
                         }
                     });
                     return refreshed;
                 }

                 // ------------------------------------------------------------------
                 // No existing payment found — create a fresh PENDING record.
                 // ------------------------------------------------------------------
                 logger.info(`[finalizeAdmission][Online] Step 1: Creating PENDING payment record`);
                 const merchantTransactionId = `TXN_${Date.now()}_${studentId.substring(0, 8)}`;
                 const yearCtx = await resolveFeeDemandContext(feeDemandId, itx);

                 return itx.payment.create({
                     data: {
                         studentId,
                         amount: payment.amount,
                         method: payment.method,
                         mode: PaymentMode.ONLINE,
                         status: PaymentStatus.PENDING,
                         component: targetComponent,
                         providerTxId: merchantTransactionId,
                         idempotencyKey: `${merchantTransactionId}_${targetComponent}`,
                         feeHeadId: payment.feeHeadId,
                         feeDemandId: feeDemandId || undefined,
                         academicYearId: yearCtx.academicYearId,
                         yearOfStudy: yearCtx.yearOfStudy,
                         collectedBy: adminId,
                         createdBy: adminId,
                         metadata: {
                             scholarship,
                             allocation,
                             course,
                             feeComponent: targetComponent,
                             amount: payment.amount,
                             feeStructureId: payment.feeStructureId,
                             targetAction: 'FINALIZE_ADMISSION'
                         }
                     }
                 });
             });

             // Use stored providerTxId or regenerate if missing (shouldn't happen for new ones)
             const merchantTransactionId = newPayment.providerTxId || newPayment.id.replace(/-/g, '');


                 // ------------------------------------------------------------------
                 // BLOCK 5: PAYMENT GATEWAY INTEGRATION
                 // Initiate the payment request with PhonePe SDK.
                 // We receive a redirect URL to send to the frontend.
                 // ------------------------------------------------------------------
                 // Step 2: PhonePe Integration
                 logger.info(`[finalizeAdmission][Online] Step 2: Initiating PhonePe Request`);

                 let clientType: 'ADMISSION' | 'HOSTEL' | 'MESS' = 'ADMISSION';
                 if (targetComponent === PaymentComponent.HOSTEL || targetComponent === PaymentComponent.HOSTEL_ACCOMMODATION) clientType = 'HOSTEL';
                 else if (targetComponent === PaymentComponent.HOSTEL_MESS) clientType = 'MESS';

                 const callbackUrl = `${FRONTEND_URL_ADMISSION}/admin/seatallotment/details?studentId=${studentId}&paymentId=${newPayment.id}`;
                 
                 const result = await initiatePhonePePayment(studentId, payment.amount, merchantTransactionId, callbackUrl, clientType);
                 const redirectUrl = result.redirectUrl;

                 logger.info(`[finalizeAdmission][Online] Payment initiated successfully. ID=${newPayment.id} PhonePeTxId=${merchantTransactionId}`);

                 return { 
                     success: true, 
                     type: 'ONLINE_INITIATED', 
                     message: "Payment Link Generated", 
                     paymentId: newPayment.id,
                     redirectUrl: redirectUrl 
                 };

             } catch (error) {
                 logger.error(`[finalizeAdmission][Online] Failed to initiate payment: ${error}`);
                 throw error;
             }

        } else {
             // === OFFLINE FLOW (Immediate) ===
             // ------------------------------------------------------------------
             // BLOCK 6: OFFLINE TRANSACTION
             // Processing Cash/Cheque/DD payment.
             // We create a SUCCESS payment record immediately and executing admission logic.
             // This happens in a single transaction.
             // ------------------------------------------------------------------
             if (!payment.referenceNumber && payment.method !== PaymentMethod.CASH) {
                 throw new AppError("Reference Number is required for Non-Cash payments", 400);
             }

             const offlineResult = await prisma.$transaction(async (tx) => {
                 logger.info(`[finalizeAdmission][Offline] Starting transaction for student=${studentId}`);

                 // Determine Payment Name based on Component
                 const feeComponent = payment.component || PaymentComponent.TUITION;

                 // Idempotency: reject if a SUCCESS payment already exists for this student + component
                 const existingSuccess = await tx.payment.findFirst({
                     where: { studentId, component: feeComponent, status: PaymentStatus.SUCCESS }
                 });
                 if (existingSuccess) {
                     logger.warn(`[finalizeAdmission][Offline] Duplicate payment detected for student=${studentId} component=${feeComponent}`);
                     throw new AppError("Payment for this component has already been completed.", 409);
                 }

                 // Resolve feeDemandId inside the transaction to avoid stale links
                 let resolvedFeeDemandId = feeDemandId;
                 if (payment.feeStructureId && !resolvedFeeDemandId) {
                     const demand = await tx.studentFeeDemand.findFirst({
                         where: { studentId, feeStructureId: payment.feeStructureId }
                     });
                     if (demand) {
                         resolvedFeeDemandId = demand.id;
                         logger.info(`[finalizeAdmission][Offline] Resolved feeDemandId inside TX: ${demand.id}`);
                     }
                 }

                 // ------------------------------------------------------------------
                 // SUB-BLOCK 6.1: RECORD PAYMENT
                 // Create a payment record with status SUCCESS.
                 // ------------------------------------------------------------------
                 // 1. Create Successful Payment
                 const yearCtx = await resolveFeeDemandContext(resolvedFeeDemandId, tx);
                 const _refForKey = payment.referenceNumber || `OFF_${Date.now()}`;
                 const newPayment = await tx.payment.create({
                    data: {
                        studentId,
                        amount: payment.amount,
                        method: payment.method,
                        mode: PaymentMode.OFFLINE,
                        status: PaymentStatus.SUCCESS,
                        component: feeComponent,
                        feeHeadId: payment.feeHeadId,
                        feeDemandId: resolvedFeeDemandId || undefined,
                        academicYearId: yearCtx.academicYearId,
                        yearOfStudy: yearCtx.yearOfStudy,
                        idempotencyKey: `${_refForKey}_${feeComponent}`,
                        referenceNumber: (() => {
                            if (!payment.referenceNumber) {
                                const autoRef = `REF-${Date.now()}`;
                                logger.warn(`[finalizeAdmission][Offline] No referenceNumber provided for CASH payment. Auto-generating: ${autoRef}. This may affect audit/reconciliation.`);
                                return autoRef;
                            }
                            return payment.referenceNumber;
                        })(),
                        instrumentDate: payment.date ? new Date(payment.date) : new Date(),
                        collectedBy: adminId,
                        createdBy: adminId, // Strict data
                        metadata: {
                            scholarship,
                            allocation,
                            course,
                            feeComponent,
                            amount: payment.amount,
                            feeStructureId: payment.feeStructureId,
                            notes: 'Offline Immediate Finalization',
                            targetAction: 'FINALIZE_ADMISSION'
                        }
                    }
                });
                logger.debug(`[finalizeAdmission][Offline] Payment record created: ${newPayment.id}`);

                // Step 2 & 3 & 4 & 5: Centralized Success Processing
                logger.info(`[finalizeAdmission][Offline] Processing Post-Payment actions`);
                await this.processPaymentSuccess(newPayment, adminId, tx);

                logger.info(`[finalizeAdmission][Offline] Transaction committed successfully.`);
                return { success: true, type: 'OFFLINE_COMPLETED', message: "Admission Finalized Successfully", paymentId: newPayment.id };
             });


             // Pre-generate Allotment Order (must happen before invoice so email can attach it)
             try {
                if (offlineResult.paymentId) {
                    const offPayment = await prisma.payment.findUnique({ where: { id: offlineResult.paymentId }, select: { studentId: true, component: true } });
                    if (offPayment && (offPayment.component === PaymentComponent.SCHOLARSHIP_TOKEN || offPayment.component === PaymentComponent.TUITION)) {
                        const existingAllotment = await prisma.studentDocument.findUnique({
                            where: { studentId_documentKey: { studentId: offPayment.studentId, documentKey: 'ALLOTMENT_ORDER' } }
                        });
                        if (!existingAllotment?.url) {
                            await generateAndSaveAllotmentOrder(offPayment.studentId);
                            logger.info(`[finalizeAdmission] Allotment Order generated for student=${offPayment.studentId}`);
                        }
                    }
                }
             } catch (err) {
                logger.warn(`[finalizeAdmission] Failed to generate allotment order: ${err}`);
             }

             // Auto-generate invoice (Outside TX)
             try {
                if (offlineResult.paymentId) {
                    await InvoiceService.generateInvoiceForPayment(offlineResult.paymentId);
                }
             } catch (err) {
                logger.warn(`[finalizeAdmission] Failed to auto-generate invoice: ${err}`);
             }

             // Send Email Notification (Offline) - Handled by InvoiceService
             // if (offlineResult.paymentId) {
             //    await this.sendAdmissionSuccessEmail(offlineResult.paymentId);
             // }

             // Fetch final details for response
             const finalPayment = await prisma.payment.findUnique({ where: { id: offlineResult.paymentId } });
             let responseInvoiceUrl = finalPayment?.invoiceUrl;
             if (responseInvoiceUrl) {
                 responseInvoiceUrl = await convertToPresignedUrl(responseInvoiceUrl);
             }

             return { 
                 ...offlineResult,
                 data: {
                    paymentId: finalPayment?.id,
                    invoiceUrl: responseInvoiceUrl,
                    amount: finalPayment?.amount,
                    transactionId: finalPayment?.referenceNumber, // Use reference for offline
                    payment: finalPayment
                 }
             };
        }
    },

    // New Method for Callbacks
    /**
     * Verifies the status of an Online Payment with PhonePe and completes admission if successful.
     * 
     * Steps:
     * 1. Validates Payment existence.
     * 2. Calls PhonePe Status API.
     * 3. If Success -> Calls _completeAdmissionTransaction to finalize.
     */
    async verifyAndCompletePayment(paymentId: string, adminId: string | undefined) {
        logger.info(`[verifyAndCompletePayment] Verifying paymentId=${paymentId}`);
        // 1. Fetch Payment
        const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
        if (!payment) {
            throw new AppError("Payment not found", 404);
        }
        
        // Find Siblings (Bundled Payments)
        let relatedPayments = [payment];
        if (payment.providerTxId && payment.providerTxId.startsWith('TXN_')) {
             const siblings = await prisma.payment.findMany({
                 where: { 
                     providerTxId: payment.providerTxId,
                     id: { not: payment.id } 
                 }
             });
             relatedPayments = [payment, ...siblings];
             logger.info(`[verifyAndCompletePayment] Found ${siblings.length} sibling payments for bundle.`);
        }

        const isSuccess = payment.status === PaymentStatus.SUCCESS;
        if (isSuccess) {
             logger.info(`[verifyAndCompletePayment] Payment ${paymentId} already processed.`);
             return { 
                success: true, 
                message: "Payment successfully processed", 
                status: PaymentStatus.SUCCESS,
                data: {
                    paymentId: payment.id,
                    invoiceUrl: await convertToPresignedUrl(payment.invoiceUrl),
                    amount: payment.amount,
                    transactionId: payment.providerTxId,
                    payment: payment
                }
             };
        }

        try {
             // Verify Gateway using PRIMARY ID
             const merchantTransactionId = payment.providerTxId || payment.id.replace(/-/g, '');
             
             // USE SHARED CLIENT
             let feeType: 'ADMISSION' | 'HOSTEL' | 'MESS' = 'ADMISSION';
             if (payment.component === PaymentComponent.HOSTEL || payment.component === PaymentComponent.HOSTEL_ACCOMMODATION) feeType = 'HOSTEL';
             if (payment.component === PaymentComponent.HOSTEL_MESS) feeType = 'MESS';

             const client = getPhonePeClient(feeType);
             logger.info(`[verifyAndCompletePayment] Verifying with Client Type: ${feeType}`);
             
             const response = await client.getOrderStatus(merchantTransactionId); 
             
             const responseData = (response as any).data || {};
             const statusState = (response as any).state || responseData.state || responseData.responseCode;
             const statusCode = (response as any).code || responseData.code;

             logger.info(`[verifyAndCompletePayment] PhonePe Response: Code=${statusCode}, State=${statusState}`);
             logger.debug(`[verifyAndCompletePayment] Full Response: ${JSON.stringify(response)}`);

             const isGatewaySuccess =
                (statusCode === 'PAYMENT_SUCCESS' && (statusState === 'COMPLETED' || statusState === 'SUCCESS')) ||
                (!statusCode && (statusState === 'COMPLETED' || statusState === 'SUCCESS'));

             if (isGatewaySuccess) {
                 const responseData = (response as any).data || response;
                 const realProviderTxId = responseData.paymentInstrument?.pgTransactionId || merchantTransactionId;
                 return await this._completeAdmissionTransaction(relatedPayments, adminId, realProviderTxId, response);
             } else if (statusState === 'PENDING' || response.state === 'PENDING') {
                 return { success: false, message: "Payment is still pending", status: PaymentStatus.PENDING };
             } else {
                 await prisma.payment.updateMany({
                     where: { id: { in: relatedPayments.map(p => p.id) } },
                     data: { status: PaymentStatus.FAILED }
                  });
                  return { success: false, message: "Payment Failed", status: PaymentStatus.FAILED };
             }
        } catch (error) {
            logger.error(`[verifyAndCompletePayment] Error verifying payment: ${error}`);
            throw new AppError("Payment Verification Failed", 500);
        }
    },

    /**
     * Internal Helper: Executes the final admission steps after a successful payment (Online or Bypass).
     * 
     * Steps:
     * 1. Marks Payment as SUCCESS.
     * 2. Calls executeAdmissionUpdates (Allocation, Scholarship).
     * 3. Creates Ledger Entry.
     */
    async _completeAdmissionTransaction(payments: any[], adminId: string | undefined, providerTxId?: string, gatewayResponse?: any) {
        if (!payments || payments.length === 0) return;
        const primaryPayment = payments[0];
        logger.info(`[_completeAdmissionTransaction] Completing ${payments.length} payments. Primary=${primaryPayment.id}`);

        await prisma.$transaction(async (tx) => {
             // Filter out already processed
             const pendingPayments = payments.filter(p => p.status !== PaymentStatus.SUCCESS);
             if (pendingPayments.length === 0) return { success: true, status: PaymentStatus.SUCCESS };

             const paymentIds = pendingPayments.map(p => p.id);
             
             // Update All to SUCCESS
             await tx.payment.updateMany({
                 where: { id: { in: paymentIds } },
                 data: { 
                     status: PaymentStatus.SUCCESS,
                     providerTxId: providerTxId || primaryPayment.providerTxId,
                     metadata: gatewayResponse || undefined // Update with gateway response if available
                 }
             });

             // Logic for Each Payment (Sequential to avoid lock contention)
             for (const payment of pendingPayments) {
                  await this.processPaymentSuccess(payment, adminId, tx);
             }
             
             return { success: true, status: PaymentStatus.SUCCESS };
         });

         // Pre-generate Allotment Order for admission payments
         const hasAdmissionComponent = payments.some((p: any) => p.component === PaymentComponent.SCHOLARSHIP_TOKEN || p.component === PaymentComponent.TUITION);
         if (hasAdmissionComponent) {
             try {
                 const existingAllotment = await prisma.studentDocument.findUnique({
                     where: { studentId_documentKey: { studentId: primaryPayment.studentId, documentKey: 'ALLOTMENT_ORDER' } }
                 });
                 if (!existingAllotment?.url) {
                     await generateAndSaveAllotmentOrder(primaryPayment.studentId);
                     logger.info(`[verifyAndFinalizePayment] Allotment Order generated for student=${primaryPayment.studentId}`);
                 }
             } catch (err) { logger.warn(`Failed to generate allotment order: ${err}`); }
         }

         // Invoice (Unified) for Bundle
         try {
             await InvoiceService.generateInvoiceForPayment(primaryPayment.id);
         } catch (err) { logger.warn(`Failed to auto-generate invoice: ${err}`); }

         // Send Email Notification - Handled by InvoiceService
         // await this.sendAdmissionSuccessEmail(primaryPayment.id);
         
         // Final Return
         const finalPayment = await prisma.payment.findUnique({ where: { id: primaryPayment.id } });
         return { 
             success: true, 
             message: "Payment Verified and Finalized", 
             status: PaymentStatus.SUCCESS,
             data: {
                 paymentId: finalPayment?.id,
                 invoiceUrl: await convertToPresignedUrl(finalPayment?.invoiceUrl),
                 amount: payments.reduce((sum, p) => sum + p.amount, 0),
                 transactionId: finalPayment?.providerTxId
             }
         };
    },

    async getAdmissionInvoice(studentId: string) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);

        // Find the successful admission payment (Tuition)
        const payment = await prisma.payment.findFirst({
            where: {
                studentId,
                status: PaymentStatus.SUCCESS,
                component: PaymentComponent.TUITION
            },
            orderBy: { createdAt: 'desc' }, // Get latest if multiple
            include: { student: true }
        });

        if (!payment) {
            throw new AppError("No admission fee payment found for this student.", 404);
        }

        // Return existing or generate if missing
        if (payment.invoiceUrl) {
            // Convert to Presigned URL
            const finalUrl = await convertToPresignedUrl(payment.invoiceUrl);
            return { invoiceUrl: finalUrl };
        } else {
            // Generate
            const result = await InvoiceService.generateInvoiceForPayment(payment.id);
            // Convert to Presigned URL just in case the service returns a raw S3 key (though it returns URL usually, let's be safe)
            // InvoiceService returns { invoiceUrl } which is usually the key or full URL? 
            // Looking at InvoiceService.ts, it returns uploadFileToS3 result. 
            // uploadFileToS3 usually returns the S3 KEY or Location. 
            // Best to ensure we return a presigned URL if it's private.
            // But InvoiceService usually returns what uploadFileToS3 returns.
            return { invoiceUrl: await convertToPresignedUrl(result.invoiceUrl) };
        }
    },










    async sendStatusEmail(data: { studentId: string; updateType: string; approvedItems?: any[]; rejectedItems?: any[]; pendingItems?: any[] }) {
        const { studentId, updateType, approvedItems, rejectedItems, pendingItems } = data;

        if (!studentId || !updateType) {
            throw new AppError('Student ID and Update Type are required', 400);
        }

        const student = await prisma.student.findUnique({
            where: { id: studentId }
        });

        if (!student || !student.email) {
            throw new AppError('Student not found or email missing', 404);
        }

        // Import locally to avoid circular dependencies if any (though utils should be fine)
        const { sendStatusUpdateEmail } = require('../../utils/emailService');

        const emailData = {
            studentName: student.name,
            applicationId: student.applicationId || studentId, // Fallback if no app ID
            updateType: updateType as any,
            approvedItems,
            rejectedItems,
            pendingItems
        };


        const result = await sendStatusUpdateEmail(student.email, emailData);

        if (!result.success) {
            throw new AppError('Failed to send status email', 500);
        }

        return { success: true };
    },

    async debugCourseAllotments(courseId: string) {
        if (!courseId) throw new AppError('courseId is required', 400);

        const course = await prisma.course.findUnique({
            where: { id: courseId },
            select: {
                id: true, code: true, name: true,
                capacities: { select: { academicYearId: true, totalSeats: true, filledSeats: true } },
            }
        });
        if (!course) throw new AppError('Course not found', 404);

        // Raw query: ALL StudentAdmission records pointing to this course (no filters)
        const allAdmissions = await prisma.studentAdmission.findMany({
            where: { allottedCourseId: courseId },
            select: {
                id: true,
                studentId: true,
                status: true,
                allottedCourseId: true,
                createdAt: true,
                student: {
                    select: {
                        applicationId: true,
                        name: true,
                        phone: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        // Apply same filter as the seat counting query
        const activeAdmissions = allAdmissions.filter(a =>
            a.allottedCourseId !== null && a.status !== 'CANCELLED'
        );

        // Group by status
        const byStatus: Record<string, number> = {};
        for (const a of allAdmissions) {
            const key = a.status || 'NULL';
            byStatus[key] = (byStatus[key] || 0) + 1;
        }

        return {
            course,
            counts: {
                totalAdmissionsForCourse: allAdmissions.length,
                activeAdmissions: activeAdmissions.length,
                capacities: course.capacities,
                byStatus
            },
            allAdmissions
        };
    },

    async getCourseChangeRequests(filters: any) {
        const { status, studentId, applicationId, page = 1, limit = 10 } = filters;
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.max(1, Math.min(100, parseInt(limit)));
        const skip = (pageNum - 1) * limitNum;

        let resolvedStudentId = studentId;
        if (applicationId && !resolvedStudentId) {
            const student = await prisma.student.findUnique({ where: { applicationId } });
            if (student) resolvedStudentId = student.id;
        }

        const where = {
            ...(status ? { status } : {}),
            ...(resolvedStudentId ? { studentId: resolvedStudentId } : {})
        } as any;

        const [requests, total] = await Promise.all([
            prisma.courseChangeRequest.findMany({
                where,
                include: { student: true } as any,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limitNum
            }),
            prisma.courseChangeRequest.count({ where })
        ]);

        const courseIds = [...new Set(requests.flatMap((r: any) => [r.fromCourse, r.toCourse].filter(Boolean)))];

        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            select: { id: true },
        });

        const courses = await prisma.course.findMany({
            where: { id: { in: courseIds } },
            select: {
                id: true,
                name: true,
                capacities: activeYear
                    ? { where: { academicYearId: activeYear.id }, select: { totalSeats: true, filledSeats: true } }
                    : undefined,
            }
        });
        const courseMap = Object.fromEntries(courses.map(c => [c.id, {
            name: c.name,
            totalSeats:  c.capacities?.[0]?.totalSeats  ?? null,
            filledSeats: c.capacities?.[0]?.filledSeats ?? null,
        }]));

        const data = requests.map((r: any) => {
            const fromCourse = courseMap[r.fromCourse];
            const toCourse = courseMap[r.toCourse];
            return {
                ...r,
                fromCourseName: fromCourse?.name || null,
                toCourseName: toCourse?.name || null,
                fromCourseFilledSeats: fromCourse?.filledSeats ?? null,
                fromCourseTotalSeats: fromCourse?.totalSeats ?? null,
                toCourseFilledSeats: toCourse?.filledSeats ?? null,
                toCourseTotalSeats: toCourse?.totalSeats ?? null,
            };
        });

        return {
            data,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                totalPages: Math.ceil(total / limitNum)
            }
        };
    },

    /**
     * Reverses a mistakenly recorded offline/bank-transfer admission payment.
     *
     * Atomically:
     * 1. Validates the payment exists and is an offline SUCCESS payment.
     * 2. Deletes all StudentLedger entries linked to this payment (referenceId = payment.id).
     * 3. Deletes the Payment record itself.
     * 4. Resets StudentAdmission:
     *    - paidFee decremented by payment.amount
     *    - totalFee decremented by the same amount
     *    - status reverted to SEAT_ALLOTTED
     *    - allottedCourseId cleared, accommodationType reset to NONE
     * 5. Decrements Course.filledSeats (if course was allotted).
     * 6. Decrements Hostel.filled / TransportRoute.filled if accommodation was set.
     * 7. Resets linked StudentFeeDemand status back to PENDING (if any demand was settled).
     *
     * Only OFFLINE (NEFT, RTGS, IMPS, Cheque, DD, Cash) SUCCESS payments
     * whose metadata.targetAction === 'FINALIZE_ADMISSION' can be reversed here.
     */
    async reverseAdmissionPayment(paymentId: string, adminId: string, reason?: string) {
        logger.info(`[reverseAdmissionPayment] paymentId=${paymentId} adminId=${adminId}`);

        // 1. Fetch payment with related data
        const payment = await prisma.payment.findUnique({
            where: { id: paymentId },
            include: {
                student: { include: { admissionDetails: true } }
            }
        });

        if (!payment) {
            throw new AppError('Payment not found', 404);
        }

        // Guard: only OFFLINE mode
        if (payment.mode !== PaymentMode.OFFLINE) {
            throw new AppError(
                'Only offline/bank-transfer payments can be reversed via this endpoint. ' +
                'For online payments, use the payment gateway refund flow.',
                400
            );
        }

        // Guard: only SUCCESS payments
        if (payment.status !== PaymentStatus.SUCCESS) {
            throw new AppError(
                `Payment cannot be reversed — current status is "${payment.status}". Only SUCCESS payments can be reversed.`,
                400
            );
        }

        // Guard: must be an admission finalization payment
        const meta = payment.metadata as any;
        if (meta?.targetAction !== 'FINALIZE_ADMISSION') {
            throw new AppError(
                'This payment is not linked to an admission finalization. Only payments recorded via the Finalize Admission flow can be reversed here.',
                400
            );
        }

        const admission = payment.student?.admissionDetails;
        const studentId = payment.studentId;
        const paidAmount = payment.amount;
        const allottedCourseId = admission?.allottedCourseId ?? meta?.course?.allottedCourseId;
        const accommodationType = admission?.accommodationType;
        const transportRouteId = admission?.transportRouteId;

        // 2. Atomic rollback transaction
        await prisma.$transaction(async (tx) => {

            // 2a. Delete StudentLedger entries referencing this payment
            await (tx.studentLedger as any).deleteMany({
                where: { referenceId: paymentId, referenceType: 'PAYMENT' }
            });
            logger.info(`[reverseAdmissionPayment] Deleted payment ledger entries`);

            // 2b. Delete tuition FEE_GENERATION DEBIT ledger created during executeAdmissionUpdates
            //     (These use referenceType='FEE_GENERATION' and a referenceId like 'ADMISSION_<timestamp>')
            await (tx.studentLedger as any).deleteMany({
                where: {
                    studentId,
                    referenceType: 'FEE_GENERATION'
                }
            });
            logger.info(`[reverseAdmissionPayment] Deleted fee-generation ledger entries for student=${studentId}`);

            // 2c. Reset linked fee demand back to PENDING
            if (payment.feeDemandId) {
                try {
                    await tx.studentFeeDemand.update({
                        where: { id: payment.feeDemandId },
                        data: { status: FeeStatus.PENDING }
                    });
                } catch {
                    logger.warn(`[reverseAdmissionPayment] Could not reset fee demand ${payment.feeDemandId}`);
                }
            }

            // 2d. Delete the Payment record
            await tx.payment.delete({ where: { id: paymentId } });
            logger.info(`[reverseAdmissionPayment] Deleted payment record ${paymentId}`);

            // 2e. Decrement course capacity for the admission's academic year
            if (allottedCourseId && admission?.academicYearId) {
                await decrementCourseCapacity(tx, allottedCourseId, admission.academicYearId);
                logger.info(`[reverseAdmissionPayment] Decremented CourseCapacity for course=${allottedCourseId} year=${admission.academicYearId}`);
            }

            // 2f. Release transport seat (hostel "filled" is computed on-demand from StudentAdmission.hostelId)
            if (accommodationType === AccommodationType.TRANSPORT && transportRouteId) {
                await tx.transportRoute.update({
                    where: { id: transportRouteId },
                    data: { filled: { decrement: 1 } }
                });
            }

            // 2g. Reset StudentAdmission
            if (admission) {
                const newPaidFee = Math.max(0, (admission.paidFee ?? 0) - paidAmount);
                const newTotalFee = Math.max(0, (admission.totalFee ?? 0) - paidAmount);

                await tx.studentAdmission.update({
                    where: { studentId },
                    data: {
                        status: AdmissionStatus.SEAT_ALLOTTED,
                        paidFee: newPaidFee,
                        totalFee: newTotalFee,
                        feeStatus: FeeStatus.PENDING,
                        allottedCourseId: null,
                        accommodationType: AccommodationType.NONE,
                        hostelId: null,
                        hostelType: null,
                        hostelPaymentMode: null,
                        transportRouteId: null,
                        roomNumber: null
                    }
                });
                logger.info(`[reverseAdmissionPayment] Reset StudentAdmission for student=${studentId} → SEAT_ALLOTTED`);
            }
        });

        logger.info(`[reverseAdmissionPayment] Completed reversal. paymentId=${paymentId} student=${studentId} admin=${adminId} reason="${reason ?? 'none'}"`);

        return {
            success: true,
            message: 'Admission payment reversed successfully. The seat has been released and student status reset to SEAT_ALLOTTED.',
            reversed: {
                paymentId,
                studentId,
                amount: paidAmount,
                allottedCourseId,
                adminId,
                reason
            }
        };
    },

    async updateSeatAllotedBy(studentId: string, seatAllotedBy: string, adminId: string | undefined) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
        if (!seatAllotedBy) throw new AppError('seatAllotedBy is required', 400);

        const user = await prisma.user.findUnique({ where: { id: seatAllotedBy } });
        if (!user) throw new AppError('User not found for seatAllotedBy ID', 404);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);

        const admission = await prisma.studentAdmission.findUnique({ where: { studentId } });
        if (!admission) throw new AppError('Admission record not found for this student', 404);

        const updated = await prisma.studentAdmission.update({
            where: { studentId },
            data: {
                seatAllotedBy,
                seatAllottedAt: new Date()
            }
        });

        logger.info(`[updateSeatAllotedBy] studentId=${studentId} seatAllotedBy="${seatAllotedBy}" by admin=${adminId}`);

        return updated;
    },

    async getFinancialApplications(query: any) {
        const { page = 1, limit = 10, search, applicationId, gender, degree, feeType, dateRange, startDate, endDate, seatAllotedBy } = query;
        const skip = (Number(page) - 1) * Number(limit);
        const take = Number(limit);

        const where: any = {};

        if (search) {
            where.OR = [
                { name: { contains: String(search), mode: 'insensitive' } },
                { email: { contains: String(search), mode: 'insensitive' } },
                { phone: { contains: String(search), mode: 'insensitive' } },
                { applicationId: { contains: String(search), mode: 'insensitive' } }
            ];
        }

        if (applicationId) {
            where.applicationId = String(applicationId);
        }

        // seatAllottedAt date range filter
        if (dateRange) {
            const now = new Date();
            const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
            const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

            let gte: Date | undefined;
            let lte: Date | undefined;

            const val = String(dateRange).toUpperCase();

            if (val === 'TODAY') {
                gte = startOfDay(now);
                lte = endOfDay(now);
            } else if (val === 'YESTERDAY') {
                const yesterday = new Date(now);
                yesterday.setDate(now.getDate() - 1);
                gte = startOfDay(yesterday);
                lte = endOfDay(yesterday);
            } else if (val === '7DAYS') {
                const d = new Date(now);
                d.setDate(now.getDate() - 7);
                gte = startOfDay(d);
                lte = endOfDay(now);
            } else if (val === '15DAYS') {
                const d = new Date(now);
                d.setDate(now.getDate() - 15);
                gte = startOfDay(d);
                lte = endOfDay(now);
            } else if (val === '30DAYS') {
                const d = new Date(now);
                d.setDate(now.getDate() - 30);
                gte = startOfDay(d);
                lte = endOfDay(now);
            } else if (val === 'CUSTOM' && startDate && endDate) {
                gte = startOfDay(new Date(String(startDate)));
                lte = endOfDay(new Date(String(endDate)));
            }

            if (gte && lte) {
                where.admissionDetails = {
                    ...where.admissionDetails,
                    seatAllottedAt: { gte, lte }
                };
            }
        }

        // seatAllotedBy filter
        if (seatAllotedBy) {
            where.admissionDetails = {
                ...where.admissionDetails,
                seatAllotedBy: String(seatAllotedBy)
            };
        }

        // Gender filter
        if (gender) {
            where.gender = { equals: String(gender), mode: 'insensitive' };
        }

        // Degree/Course filter — via allotted course
        if (degree) {
            where.admissionDetails = {
                ...where.admissionDetails,
                allottedCourse: { degree: String(degree) }
            };
        }

        // Fee Statistics filter — students who have paid that fee type
        logger.info(`[getFinancialApplications] feeType=${feeType} gender=${gender} degree=${degree}`);
        if (feeType) {
            const val = String(feeType).toUpperCase();
            if (val === 'APPLICATION_FEE') {
                where.payments = {
                    some: { component: PaymentComponent.APPLICATION_FEE, status: PaymentStatus.SUCCESS }
                };
            } else if (val === 'TUITION') {
                where.ledgerEntries = {
                    some: { type: LedgerTransactionType.CREDIT, isDeleted: false, description: { contains: 'TUITION', mode: 'insensitive' } }
                };
            } else if (val === 'ADMISSION') {
                where.ledgerEntries = {
                    some: { type: LedgerTransactionType.CREDIT, isDeleted: false, description: { contains: 'ADMISSION', mode: 'insensitive' } }
                };
            } else if (val === 'BOOK_BANK') {
                where.ledgerEntries = {
                    some: {
                        type: LedgerTransactionType.CREDIT,
                        isDeleted: false,
                        OR: [
                            { description: { endsWith: '- BOOK_BANK', mode: 'insensitive' } },
                            { description: { endsWith: '(BOOK_BANK)', mode: 'insensitive' } }
                        ]
                    }
                };
            } else if (val === 'HOSTEL') {
                where.ledgerEntries = {
                    some: {
                        type: LedgerTransactionType.CREDIT,
                        isDeleted: false,
                        OR: [
                            { description: { contains: 'HOSTEL_ACCOMODATION', mode: 'insensitive' } },
                            { description: { contains: 'HOSTEL_MESS', mode: 'insensitive' } }
                        ]
                    }
                };
            } else if (val === 'TRANSPORT') {
                where.ledgerEntries = {
                    some: { type: LedgerTransactionType.CREDIT, isDeleted: false, description: { contains: 'TRANSPORT', mode: 'insensitive' } }
                };
            }
        }

        const [students, total] = await Promise.all([
            prisma.student.findMany({
                where,
                skip,
                take,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    applicationId: true,
                    name: true,
                    gender: true,
                    phone: true,
                    email: true,
                    degreeType: true,
                    admissionDetails: {
                        select: {
                            seatAllottedAt: true,
                            accommodationType: true,
                            allottedCourse: {
                                select: { name: true, degree: true }
                            },
                            transportRoute: {
                                select: { cost: true }
                            }
                        }
                    },
                    payments: {
                        where: {
                            component: PaymentComponent.APPLICATION_FEE,
                            status: PaymentStatus.SUCCESS
                        },
                        select: { id: true }
                    },
                    feeDemands: {
                        where: { isDeleted: false },
                        select: {
                            netAmount: true,
                            amount: true,
                            feeHead: { select: { name: true, component: true } }
                        }
                    },
                    ledgerEntries: {
                        where: { type: LedgerTransactionType.CREDIT, isDeleted: false },
                        select: { amount: true, description: true }
                    }
                }
            }),
            prisma.student.count({ where })
        ]);

        const applications = students.map((student: any) => {
            const demands = student.feeDemands as { netAmount: number | null; amount: number; feeHead: { name: string; component: PaymentComponent | null } | null }[];
            const credits = student.ledgerEntries as { amount: number; description: string | null }[];

            const getTotalByHead = (keyword: string) =>
                demands
                    .filter((d) => d.feeHead?.name?.toUpperCase().includes(keyword.toUpperCase()))
                    .reduce((sum, d) => sum + (d.netAmount ?? d.amount ?? 0), 0);

            const getTotalByComponent = (components: PaymentComponent[]) =>
                demands
                    .filter((d) => d.feeHead?.component && components.includes(d.feeHead.component))
                    .reduce((sum, d) => sum + (d.netAmount ?? d.amount ?? 0), 0);

            // Extract fee type keyword from description:
            // Format 1: "Admission Payment (UPI) - TUITION"    → after " - "
            // Format 2: "Payment Received via CASH (BOOK_BANK)" → inside last "()"
            const getFeeKeyword = (desc: string | null): string => {
                if (!desc) return '';
                const upper = desc.toUpperCase();
                const dashMatch = upper.match(/- ([A-Z_]+)\s*$/);
                if (dashMatch) return dashMatch[1].trim();
                const parenMatch = upper.match(/\(([A-Z_]+)\)\s*$/);
                if (parenMatch) return parenMatch[1].trim();
                return '';
            };

            const getPaidByDesc = (keyword: string) =>
                credits
                    .filter((c) => getFeeKeyword(c.description) === keyword.toUpperCase())
                    .reduce((sum, c) => sum + (c.amount ?? 0), 0);

            // Description-based hostel paid (covers HOSTEL_ACCOMMODATION, HOSTEL_MESS, HOSTEL_LAUNDRY, HOSTEL_REGISTRATION).
            // Tolerate the legacy "ACCOMODATION" misspelling in older ledger entries.
            const HOSTEL_KEYWORDS = new Set([
                'HOSTEL_ACCOMMODATION', 'HOSTEL_ACCOMODATION',
                'HOSTEL_MESS', 'HOSTEL_LAUNDRY', 'HOSTEL_REGISTRATION'
            ]);
            const hostelPaid = credits
                .filter((c) => HOSTEL_KEYWORDS.has(getFeeKeyword(c.description)))
                .reduce((sum, c) => sum + (c.amount ?? 0), 0);

            // Per-student hostel total = sum of frozen StudentFeeDemand rows tagged with hostel components.
            // Drives off the snapshot created at assign-hostel time (handles SEMWISE/YEARWISE correctly).
            const hostelComponents: PaymentComponent[] = [
                PaymentComponent.HOSTEL_ACCOMMODATION,
                PaymentComponent.HOSTEL_MESS,
                PaymentComponent.HOSTEL_LAUNDRY,
                PaymentComponent.HOSTEL_REGISTRATION,
            ];
            const hostelTotal = getTotalByComponent(hostelComponents);
            const hostelOpted = student.admissionDetails?.accommodationType === AccommodationType.HOSTEL;

            const transportPaid = credits
                .filter((c) => getFeeKeyword(c.description) === 'TRANSPORT')
                .reduce((sum, c) => sum + (c.amount ?? 0), 0);

            const transportTotal = student.admissionDetails?.transportRoute?.cost ?? 0;

            return {
                studentId: student.id,
                applicationId: student.applicationId,
                name: student.name,
                gender: student.gender,
                phone: student.phone,
                email: student.email,
                branch: student.admissionDetails?.allottedCourse?.name ?? null,
                degree: student.admissionDetails?.allottedCourse?.degree ?? student.degreeType ?? null,
                dateOfAllotment: student.admissionDetails?.seatAllottedAt ?? null,
                applicationFee: {
                    paid: student.payments.length > 0,
                    amount: 500
                },
                tuitionFee: {
                    paid: getPaidByDesc('TUITION'),
                    total: getTotalByHead('TUITION')
                },
                admissionFee: {
                    paid: getPaidByDesc('ADMISSION'),
                    total: getTotalByHead('ADMISSION')
                },
                bookBankFee: {
                    paid: getPaidByDesc('BOOK_BANK'),
                    total: getTotalByHead('BOOK BANK')
                },
                hostelFee: {
                    opted: hostelOpted,
                    paid: hostelPaid,
                    total: hostelTotal,
                    breakdown: {
                        accommodation: getTotalByComponent([PaymentComponent.HOSTEL_ACCOMMODATION]),
                        mess:          getTotalByComponent([PaymentComponent.HOSTEL_MESS]),
                        laundry:       getTotalByComponent([PaymentComponent.HOSTEL_LAUNDRY]),
                        registration:  getTotalByComponent([PaymentComponent.HOSTEL_REGISTRATION]),
                    }
                },
                transport: {
                    opted: student.admissionDetails?.accommodationType === AccommodationType.TRANSPORT,
                    paid: transportPaid,
                    total: transportTotal
                }
            };
        });

        return {
            applications,
            pagination: {
                total,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil(total / Number(limit))
            }
        };
    },

    // =============================================
    // Waiting List Management
    // =============================================

    /**
     * Add a student to the waiting list for one or more courses.
     * Validates: student exists, courses exist, no duplicate entries.
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

    /**
     * Manual entry admission — admin-driven backfill / lateral / transfer admission.
     *
     * Bypasses the standard application + entrance exam + seat-allotment flow.
     * Creates User + Student + StudentAdmission (status=ADMISSION_CONFIRMED) +
     * StudentEnrollment in a single transaction, then layers on optional
     * accommodation, prior payment, and scholarship intent.
     *
     * Payload shape is defined by `manualEntryAdmissionSchema` in adminValidators.ts.
     */
    async manualEntryAdmission(payload: any, adminId: string) {
        logger.info(`[manualEntryAdmission] Request by admin=${adminId} for ${payload?.student?.email || payload?.student?.phone} entry=${payload?.entry?.type}/${payload?.entry?.yearOfStudy}`);
        logger.debug(`[manualEntryAdmission] Full Payload: ${JSON.stringify(payload)}`);

        const { student: studentData, course, entry, enrollment, scholarship, accommodation, priorPayment } = payload;

        // ── Stage 1: Validation ──────────────────────────────────────────
        const [academicYear, validCourse, validSection, existingStudent] = await Promise.all([
            prisma.academicYear.findUnique({ where: { id: entry.academicYearId } }),
            prisma.course.findUnique({ where: { id: course.allottedCourseId } }),
            prisma.section.findUnique({ where: { id: enrollment.sectionId } }),
            prisma.student.findFirst({
                where: {
                    OR: [
                        ...(studentData.email ? [{ email: studentData.email }] : []),
                        { aadharNumber: studentData.aadharNumber },
                    ],
                },
            }),
        ]);

        if (!academicYear || academicYear.isDeleted) {
            logger.warn(`[manualEntryAdmission] Invalid academic year: ${entry.academicYearId}`);
            throw new AppError('Invalid Academic Year ID', 400);
        }
        // Locked / closed years are off-limits even for back-dated admissions —
        // the books for that year have been finalized.
        await assertAcademicYearWritable(entry.academicYearId);
        if (entry.isBackdated && new Date(academicYear.startDate) >= new Date()) {
            throw new AppError('Backdated entry requires an academic year whose startDate is in the past', 400);
        }
        if (!validCourse || validCourse.isDeleted) {
            throw new AppError('Invalid Course ID', 400);
        }
        if (!validSection || validSection.isDeleted) {
            throw new AppError('Invalid Section ID', 400);
        }
        if (entry.type === AdmissionEntryType.LATERAL && entry.yearOfStudy < 2) {
            throw new AppError('LATERAL entry requires yearOfStudy >= 2', 400);
        }
        if (entry.type === AdmissionEntryType.LATERAL && scholarship && ![0, 15, 25, 50].includes(scholarship.percentage)) {
            throw new AppError('Lateral entry scholarship must be 0, 15, 25, or 50', 400);
        }

        // Reject duplicate rollNumber within the entry academic year. Schema has no
        // `@unique` on rollNumber so this check is application-level. The bulk validator
        // also catches within-batch dupes; this catches DB collisions for both single
        // and bulk paths.
        const dupRoll = await prisma.studentEnrollment.findFirst({
            where: {
                rollNumber: enrollment.rollNumber,
                academicYearId: entry.academicYearId,
                status: { not: 'DROPPED' },
            },
            select: { id: true, studentId: true },
        });
        if (dupRoll) {
            throw new AppError(
                `Roll number "${enrollment.rollNumber}" already assigned to another active enrollment in this academic year`,
                409
            );
        }

        // Duplicate check — match registerStudent semantics: email OR aadhar last4 + dob
        if (existingStudent) {
            throw new AppError('Student already exists with this email or Aadhar', 409);
        }
        if (studentData.aadharNumber && studentData.dob) {
            const dobDate = studentData.dob instanceof Date ? studentData.dob : new Date(studentData.dob);
            const last4 = studentData.aadharNumber.toString().trim().replace(/\s/g, '').slice(-4);
            const maskedPattern = `XXXX XXXX ${last4}`;
            const dobStart = new Date(dobDate.getFullYear(), dobDate.getMonth(), dobDate.getDate());
            const dobEnd = new Date(dobDate.getFullYear(), dobDate.getMonth(), dobDate.getDate(), 23, 59, 59, 999);
            const dupByAadhar = await prisma.student.findFirst({
                where: {
                    aadharNumber: maskedPattern,
                    dob: { gte: dobStart, lte: dobEnd },
                },
            });
            if (dupByAadhar) {
                throw new AppError('Student already exists with this Aadhar + DOB', 409);
            }
        }

        // ── Stage 2: Defaults ────────────────────────────────────────────
        const currentSemester = entry.currentSemester ?? (entry.yearOfStudy * 2 - 1);
        const dobDate = studentData.dob instanceof Date ? studentData.dob : new Date(studentData.dob);

        // Mask the Aadhaar before storage (matches registerStudent convention)
        const last4 = studentData.aadharNumber.toString().trim().replace(/\s/g, '').slice(-4);
        const storedAadhar = `XXXX XXXX ${last4}`;

        // ── Stage 3: Atomic transaction (User + Student + Admission + Enrollment + ApplicationFee) ──
        const APPLICATION_FEE_AMOUNT = await getApplicationFeeAmount();
        const appFeeHeadMap = await resolveFeeHeadsByComponent([PaymentComponent.APPLICATION_FEE]);
        const appFeeHead = appFeeHeadMap.get(PaymentComponent.APPLICATION_FEE);

        const isAppFeeWaived = entry.type === AdmissionEntryType.LATERAL
            && studentData.quotaType === QuotaType.MANAGEMENT;

        const txResult = await prisma.$transaction(async (tx) => {
            // 1. ApplicationId — MAN prefix marks manual-entry admissions
            const applicationId = `MAN${Date.now()}${Math.floor(Math.random() * 100)}`;

            // 2. Hash default password
            const hashedPassword = await bcrypt.hash('Welcome@123', 10);

            // 3. Create User
            const user = await tx.user.create({
                data: {
                    name: studentData.name,
                    email: studentData.email,
                    phone: studentData.phone,
                    password: hashedPassword,
                    role: Role.STUDENT,
                    isDeleted: false,
                    createdBy: adminId,
                    updatedBy: adminId,
                },
            });

            // 4. Create Student
            const newStudent = await tx.student.create({
                data: {
                    applicationId,
                    name: studentData.name,
                    fatherName: studentData.fatherName,
                    motherName: studentData.motherName,
                    gender: studentData.gender,
                    dob: dobDate,
                    phone: studentData.phone,
                    email: studentData.email,
                    aadharNumber: storedAadhar,
                    category: studentData.category,
                    country: studentData.country,
                    address: studentData.address,
                    address2: studentData.address2,
                    city: studentData.city,
                    state: studentData.state,
                    pincode: studentData.pincode,
                    profilePhotoUrl: studentData.profilePhotoUrl,
                    quotaType: studentData.quotaType,
                    applicationMode: ApplicationMode.OFFLINE,
                    isOffline: true,
                    isKycVerified: true,
                    userId: user.id,
                    createdBy: adminId,
                    updatedBy: adminId,
                } as any,
            });

            // 5. Create StudentAdmission — status ADMISSION_CONFIRMED, skip exam flow
            // feeCohortAcademicYearId always equals entryAcademicYearId — the student's
            // own batch year drives their fee schedule, with FeeStructure.entryType
            // differentiating REGULAR vs LATERAL fees within that year.
            const feeCohortAcademicYearId = entry.academicYearId;

            const newAdmission = await tx.studentAdmission.create({
                data: {
                    studentId: newStudent.id,
                    status: AdmissionStatus.ADMISSION_CONFIRMED,
                    allottedCourseId: course.allottedCourseId,
                    academicYearId: entry.academicYearId,
                    entryType: entry.type,
                    entryYearOfStudy: entry.yearOfStudy,
                    entryAcademicYearId: entry.academicYearId,
                    feeCohortAcademicYearId,
                    instituteCode: entry.instituteCode ?? 'VVIG',
                    entryReason: entry.reason,
                    isBackdated: entry.isBackdated,
                    paidFee: 0,
                    totalFee: 0,
                    feeStatus: FeeStatus.PENDING,
                    accommodationType: AccommodationType.NONE,
                } as any,
            });

            // 6. Create StudentExam (matches registerStudent convention; harmless empty row)
            await tx.studentExam.create({
                data: { studentId: newStudent.id },
            });

            // 7. Create StudentEnrollment
            const newEnrollment = await tx.studentEnrollment.create({
                data: {
                    studentId: newStudent.id,
                    sectionId: enrollment.sectionId,
                    rollNumber: enrollment.rollNumber,
                    currentSemester,
                    yearOfStudy: entry.yearOfStudy,
                    academicYearId: entry.academicYearId,
                    status: 'ACTIVE',
                    createdBy: adminId,
                    updatedBy: adminId,
                } as any,
            });

            // 8. Application fee handling
            if (appFeeHead) {
                if (isAppFeeWaived) {
                    // Lateral + Management → fully-waived APPLICATION_FEE demand
                    const waivedDemand = await tx.studentFeeDemand.create({
                        data: {
                            studentId: newStudent.id,
                            feeHeadId: appFeeHead.id,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            amount: APPLICATION_FEE_AMOUNT,
                            discountAmount: APPLICATION_FEE_AMOUNT,
                            netAmount: 0,
                            status: FeeStatus.FULL,
                            dueDate: new Date(),
                            remarks: 'Application fee waived: lateral entry, management quota',
                            createdBy: adminId,
                            updatedBy: adminId,
                        } as any,
                    });
                    await tx.studentLedger.create({
                        data: {
                            studentId: newStudent.id,
                            type: LedgerTransactionType.CREDIT,
                            amount: APPLICATION_FEE_AMOUNT,
                            description: 'Application fee waiver: lateral + management quota',
                            referenceId: waivedDemand.id,
                            referenceType: 'WAIVER',
                            feeHeadId: appFeeHead.id,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            createdBy: adminId,
                        } as any,
                    });
                } else {
                    // Normal PENDING APPLICATION_FEE demand
                    await tx.studentFeeDemand.create({
                        data: {
                            studentId: newStudent.id,
                            feeHeadId: appFeeHead.id,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            amount: APPLICATION_FEE_AMOUNT,
                            netAmount: APPLICATION_FEE_AMOUNT,
                            status: FeeStatus.PENDING,
                            dueDate: new Date(),
                            remarks: 'Application fee — manual entry admission',
                            createdBy: adminId,
                            updatedBy: adminId,
                        } as any,
                    });
                }
            } else {
                logger.warn(`[manualEntryAdmission] No FeeHead tagged with PaymentComponent.APPLICATION_FEE — skipping application fee demand for student=${newStudent.id}`);
            }

            return { user, student: newStudent, admission: newAdmission, enrollment: newEnrollment };
        });

        const { student, admission, enrollment: createdEnrollment } = txResult;
        logger.info(`[manualEntryAdmission] Core records created. studentId=${student.id} applicationId=${student.applicationId}`);

        // ── Stage 4: Side effects (outside main transaction — they own their own TXs) ──

        // 9. Tuition / yearly fee demand seeding.
        // For lateral / back-dated admissions, the entry academicYear must already have
        // FeeStructure rows for the chosen course. If absent (e.g. admin forgot to clone
        // from current year), we proceed with the admission but flag in the response so
        // admin can run POST /finance/fees/fee-structure/clone-academic-year and then
        // call generateFeeDemands manually.
        let totalFeeDemandsCreated = 0;
        let feeStructureMissing = false;
        try {
            const fsCount = await prisma.feeStructure.count({
                where: {
                    courseId: course.allottedCourseId,
                    academicYearId: entry.academicYearId,
                    isDeleted: false,
                },
            });
            if (fsCount === 0) {
                feeStructureMissing = true;
                logger.warn(
                    `[manualEntryAdmission] No FeeStructure rows for course=${course.allottedCourseId} ` +
                    `academicYearId=${entry.academicYearId}. Admission created but tuition demands NOT seeded. ` +
                    `Clone fee structures from a prior year via POST /finance/fees/fee-structure/clone-academic-year, ` +
                    `then run generateFeeDemands for student=${student.id}.`
                );
            } else {
                const seeded = await FeeService.generateFeeDemands(
                    student.id,
                    course.allottedCourseId,
                    entry.academicYearId,
                    adminId,
                    false
                    // allowLegacyFallback defaults to true → preserves legacy behavior for manual entries
                );
                totalFeeDemandsCreated = seeded?.generated ?? 0;
                logger.info(`[manualEntryAdmission] generateFeeDemands seeded ${totalFeeDemandsCreated} demand(s) for student=${student.id} (fallback=${seeded?.fallbackUsed})`);
            }
        } catch (err) {
            logger.error(`[manualEntryAdmission] generateFeeDemands failed for student=${student.id}: ${err}`);
        }

        // 10. Optional accommodation
        let hostelAllocated = false;
        let transportAllocated = false;
        if (accommodation && accommodation.type === AccommodationType.HOSTEL && accommodation.hostelId && accommodation.hostelType && accommodation.hostelPaymentMode) {
            try {
                await AdminStudentService.assignHostel(
                    student.id,
                    accommodation.hostelId,
                    accommodation.hostelPaymentMode as 'YEARWISE' | 'SEMWISE',
                    accommodation.hostelType as HostelType,
                    adminId
                );
                hostelAllocated = true;
                logger.info(`[manualEntryAdmission] Hostel assigned student=${student.id} hostelId=${accommodation.hostelId}`);
            } catch (err) {
                logger.error(`[manualEntryAdmission] assignHostel failed for student=${student.id}: ${err}`);
            }
        } else if (accommodation && accommodation.type === AccommodationType.TRANSPORT && accommodation.transportRouteId) {
            try {
                await AdminStudentService.assignTransport(student.id, accommodation.transportRouteId, adminId);
                transportAllocated = true;
                logger.info(`[manualEntryAdmission] Transport assigned student=${student.id} routeId=${accommodation.transportRouteId}`);
            } catch (err) {
                logger.error(`[manualEntryAdmission] assignTransport failed for student=${student.id}: ${err}`);
            }
        }

        // 11. Optional priorPayment — record carried-over payment
        let priorPaymentRecorded = false;
        if (priorPayment && priorPayment.amount > 0) {
            try {
                const providerTxId = `MAN_${Date.now()}_${student.id.substring(0, 8)}`;
                await prisma.$transaction(async (tx) => {
                    const payment = await tx.payment.create({
                        data: {
                            studentId: student.id,
                            amount: priorPayment.amount,
                            method: priorPayment.method,
                            mode: PaymentMode.OFFLINE,
                            status: PaymentStatus.SUCCESS,
                            component: priorPayment.component,
                            providerTxId,
                            idempotencyKey: `${providerTxId}_${priorPayment.component}`,
                            referenceNumber: priorPayment.referenceNumber || null,
                            feeHeadId: priorPayment.feeHeadId,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            collectedBy: adminId,
                            createdBy: adminId,
                            updatedBy: adminId,
                            metadata: { source: 'manual-entry', adminId },
                        } as any,
                    });

                    await tx.studentLedger.create({
                        data: {
                            studentId: student.id,
                            type: LedgerTransactionType.CREDIT,
                            amount: priorPayment.amount,
                            description: `Prior payment carried over (${priorPayment.component}) — manual entry`,
                            referenceId: payment.id,
                            referenceType: 'PAYMENT',
                            feeHeadId: priorPayment.feeHeadId,
                            academicYearId: entry.academicYearId,
                            yearOfStudy: entry.yearOfStudy,
                            createdBy: adminId,
                        } as any,
                    });

                    await tx.studentAdmission.update({
                        where: { studentId: student.id },
                        data: { paidFee: { increment: priorPayment.amount } },
                    });
                });
                priorPaymentRecorded = true;
                logger.info(`[manualEntryAdmission] Prior payment recorded student=${student.id} amount=${priorPayment.amount} component=${priorPayment.component}`);
            } catch (err) {
                logger.error(`[manualEntryAdmission] priorPayment recording failed for student=${student.id}: ${err}`);
            }
        }

        // 12. Optional scholarship — store intent only (Phase 1)
        let scholarshipRecorded = false;
        if (scholarship && typeof scholarship.percentage === 'number') {
            try {
                await prisma.studentScholarship.create({
                    data: {
                        studentId: student.id,
                        type: entry.type === AdmissionEntryType.LATERAL ? 'LATERAL' : 'MANUAL_ENTRY',
                        scholarshipPercentage: scholarship.percentage,
                        remarks: scholarship.ruleId ? `Manual entry — ruleId=${scholarship.ruleId}` : 'Manual entry scholarship intent',
                        // Tag with the cohort's entry year — manual entry has explicit year context.
                        academicYearId: entry.academicYearId,
                        createdBy: adminId,
                        updatedBy: adminId,
                    } as any,
                });
                scholarshipRecorded = true;
                logger.info(`[manualEntryAdmission] Scholarship intent stored student=${student.id} pct=${scholarship.percentage}`);
            } catch (err) {
                logger.error(`[manualEntryAdmission] scholarship intent storage failed for student=${student.id}: ${err}`);
            }
        }

        // ── Stage 5: Audit ─────────────────────────────────────────────
        logger.info(`[manualEntryAdmission] DONE student=${student.id} app=${student.applicationId} admission=${admission.id} entry=${entry.type}/${entry.yearOfStudy} appFeeWaived=${isAppFeeWaived} hostel=${hostelAllocated} transport=${transportAllocated} priorPayment=${priorPaymentRecorded} scholarship=${scholarshipRecorded} demands=${totalFeeDemandsCreated}`);

        return {
            success: true,
            studentId: student.id,
            applicationId: student.applicationId,
            admissionId: admission.id,
            enrollmentId: createdEnrollment.id,
            entryType: entry.type,
            entryYearOfStudy: entry.yearOfStudy,
            applicationFeeWaived: isAppFeeWaived,
            hostelAllocated,
            transportAllocated,
            priorPaymentRecorded,
            scholarshipRecorded,
            totalFeeDemandsCreated,
            // True when no FeeStructure rows existed for this course+academicYear at admission time.
            // Admission was created but tuition demands were skipped — admin must clone fee
            // structures and re-trigger generateFeeDemands.
            feeStructureMissing,
            warning: feeStructureMissing
                ? `No FeeStructure rows for course ${course.allottedCourseId} in academic year ${entry.academicYearId}. ` +
                  `Tuition demands were not seeded. Clone fee structures via ` +
                  `POST /finance/fees/fee-structure/clone-academic-year, then re-run generateFeeDemands.`
                : undefined,
        };
    },

    /**
     * Assigns rollNumber + section to a registered student. Used after counseling /
     * seat allotment to create the StudentEnrollment row that backs roll-number-based
     * login and fee billing. Works for both fresh and lateral students — the entry
     * data was already captured during /student/register.
     */
    async assignEnrollment(
        studentId: string,
        rollNumber: string,
        sectionId: string,
        adminId: string,
        opts?: { currentSemester?: number; yearOfStudy?: number; seedFeeDemands?: boolean }
    ) {
        logger.info(`[assignEnrollment] studentId=${studentId} roll=${rollNumber} sectionId=${sectionId} admin=${adminId}`);

        // 1. Load student + admission to get entry data and active year
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: true }
        });
        if (!student) {
            throw new AppError('Student not found', 404);
        }
        if (!student.admissionDetails) {
            throw new AppError('Student admission record not found', 404);
        }

        // 2. Resolve active academic year (the year the enrollment will be tied to)
        const activeYear = await prisma.academicYear.findFirst({
            where: { isActive: true, isDeleted: false },
            orderBy: { startDate: 'desc' },
            select: { id: true, code: true },
        });
        if (!activeYear) {
            throw new AppError('No active academic year configured', 400);
        }

        // 3. Reject if student already has an enrollment for the active year
        const existing = await prisma.studentEnrollment.findFirst({
            where: { studentId, academicYearId: activeYear.id }
        });
        if (existing) {
            throw new AppError(
                `Student already has an enrollment for ${activeYear.code} (rollNumber=${existing.rollNumber})`,
                409
            );
        }

        // 4. Reject if rollNumber is already used in the active year
        const dupRoll = await prisma.studentEnrollment.findFirst({
            where: {
                rollNumber: rollNumber.trim(),
                academicYearId: activeYear.id,
                status: { not: 'DROPPED' },
            },
            select: { id: true, studentId: true },
        });
        if (dupRoll) {
            throw new AppError(
                `Roll number "${rollNumber}" already assigned to another active enrollment in ${activeYear.code}`,
                409
            );
        }

        // 5. Validate section exists
        const section = await prisma.section.findUnique({ where: { id: sectionId } });
        if (!section) {
            throw new AppError('Section not found', 404);
        }

        // 6. Defaults from entryYearOfStudy when caller doesn't specify
        const entryYos = student.admissionDetails.entryYearOfStudy ?? 1;
        const yearOfStudy     = opts?.yearOfStudy ?? entryYos;
        const currentSemester = opts?.currentSemester ?? (yearOfStudy * 2 - 1);

        // 7. Create the enrollment in a transaction; also bump admission status to
        //    SEAT_ALLOTTED if it's still REGISTERED (don't downgrade further-along statuses).
        const result = await prisma.$transaction(async (tx) => {
            const enrollment = await tx.studentEnrollment.create({
                data: {
                    studentId,
                    sectionId,
                    rollNumber: rollNumber.trim(),
                    academicYearId: activeYear.id,
                    currentSemester,
                    yearOfStudy,
                    status: 'ACTIVE',
                    createdBy: adminId,
                    updatedBy: adminId,
                }
            });

            if (student.admissionDetails!.status === AdmissionStatus.REGISTERED) {
                await tx.studentAdmission.update({
                    where: { studentId },
                    data: {
                        status: AdmissionStatus.SEAT_ALLOTTED,
                        seatAllotedBy: adminId,
                        seatAllottedAt: new Date(),
                    }
                });
            }

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'STUDENT_ENROLLMENT_ASSIGNED',
                    entity: 'StudentEnrollment',
                    entityId: enrollment.id,
                    details: { studentId, rollNumber: enrollment.rollNumber, sectionId, academicYearCode: activeYear.code },
                }
            });

            return enrollment;
        });

        logger.info(`[assignEnrollment] success enrollmentId=${result.id} studentId=${studentId} roll=${rollNumber}`);

        // 8. Optionally seed fee demands for the active year
        let feeDemandsSeeded = 0;
        const seedFeeDemands = opts?.seedFeeDemands ?? true;
        if (seedFeeDemands && student.admissionDetails.allottedCourseId) {
            try {
                const { FeeService } = require('../finance/fee.service');
                const result = await FeeService.generateFeeDemands(
                    studentId,
                    student.admissionDetails.allottedCourseId,
                    activeYear.id,
                    adminId,
                    false
                );
                feeDemandsSeeded = result?.generated ?? 0;
                logger.info(`[assignEnrollment] seeded ${feeDemandsSeeded} fee demands for studentId=${studentId} (fallback=${result?.fallbackUsed})`);
            } catch (err: any) {
                logger.error(`[assignEnrollment] generateFeeDemands failed for studentId=${studentId}: ${err.message}`);
            }
        }

        return {
            enrollment: result,
            admissionStatus: AdmissionStatus.SEAT_ALLOTTED,
            feeDemandsSeeded,
        };
    },
};

