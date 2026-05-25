// Application listing / export / details / financial-report endpoints,
// split out of adminStudent.service.ts.

import prisma from '../../../config/prisma';
import { AccommodationType, PaymentStatus, PaymentComponent, LedgerTransactionType } from '@prisma/client';
import { registerStudent } from '../../student/student.service';
import logger from '../../../utils/logger';
import { AppError } from '../../../utils/AppError';
import { MESSAGES } from '../../../constants/messages';
import Papa from 'papaparse';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import axios from 'axios';
import { convertToPresignedUrl } from '../../../utils/s3Utils';
import { maskAadhaar } from '../../../utils/mask';
import { generateApplicationPDF } from '../../../utils/applicationPdfGenerator';
import {
    PREF_COURSE_WITH_CAPACITY,
    attachCourseCapacity,
    buildApplicationFilters,
} from './_shared';

export const ApplicationsService = {
    /**
     * Paginated student application list with deep eager-loading (admission, exam,
     * payments, allocations, pref courses with capacity). Used by the main admin
     * applications grid. Filters resolved by `buildApplicationFilters` (search,
     * status, quota, exam dates, marks, fee-paid, etc.).
     */
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

        // Latest waiting-list entry (ANY status) per student on this page, keyed by studentId —
        // one batched query rather than a per-row lookup. A student who came via the waiting
        // list stays flagged regardless of seat allotment.
        const pageStudentIds = students.map((s: any) => s.id);
        const waitingRows = pageStudentIds.length
            ? await prisma.waitingList.findMany({
                where: { studentId: { in: pageStudentIds } },
                orderBy: { createdAt: 'desc' },
                select: { id: true, studentId: true, category: true, waitingNumber: true, status: true, courseId: true, academicYearId: true },
            })
            : [];
        const waitingByStudent = new Map<string, any>();
        for (const w of waitingRows) if (!waitingByStudent.has(w.studentId)) waitingByStudent.set(w.studentId, w);

        const enhancedStudents = await Promise.all(students.map(async (student: any) => {
            // Convert document URLs to presigned URLs
            const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
                ...doc,
                url: await convertToPresignedUrl(doc.url)
            })));

            // Convert profile photo URL
            const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);

            const { transportAllocations: _ta, ...studentRest } = student;
            // Flag if the student ever came via the waiting list, regardless of seat allotment.
            const waitingEntry = waitingByStudent.get(student.id) ?? null;
            return {
                ...studentRest,
                isInWaitingList: !!waitingEntry,
                waitingListCategory: waitingEntry?.category ?? null,
                waitingList: waitingEntry,
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

    /**
     * Same filter set as getAllApplications but emits CSV (no pagination).
     * Resolves verifiedBy user IDs to names so the export shows admin names,
     * not UUIDs.
     */
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

    /**
     * Widened applications list used by the extended-search admin screen.
     * Adds preference-name search, allottedCourseId lookup, and exam-attended
     * filters on top of the standard buildApplicationFilters surface.
     */
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

    /**
     * Legacy bulk-create entrypoint: takes a CSV string and runs the public
     * `registerStudent` flow per row. Returns a list of per-row results
     * (success / failure with error message). New flows should use the
     * dedicated bulkImport module instead.
     */
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
    /**
     * Returns a student's uploaded documents + verification status, with
     * presigned S3 URLs so the admin UI can render previews.
     */
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

    /**
     * Streams every approved document for a student into a single zip buffer.
     * Used by the "download all" button on the document-verification screen.
     */
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

    /**
     * Renders the student's application form as a PDF (the same shape the
     * student sees on signup confirmation). Used by admins as proof-of-record.
     */
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
    /**
     * Financial-only view of applications: per-student totals + fee component
     * breakdown (application fee, tuition, admission, book bank, hostel total
     * vs paid, transport yes/no). Used by the finance dashboard.
     */
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
};
