import prisma from '../../config/prisma';
import { AdmissionStatus, CancellationStatus, RequestStatus, StudentDocumentStatus, AccommodationType, FeeStatus, Prisma, HostelType, PaymentMethod, PaymentStatus, PaymentMode, PaymentComponent, LedgerTransactionType, HostelPaymentMode } from '@prisma/client';
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
import { FeeService } from '../finance/fee.service';
import { convertToPresignedUrl } from '../../utils/s3Utils';
import { maskAadhaar } from '../../utils/mask';
import { generateApplicationPDF } from '../../utils/applicationPdfGenerator';
import { getEnv } from '../../config/envValidator';
import { sendAdmissionFeeReceipt, sendPaymentReceipt, sendScholarshipUpdateEmail } from '../../utils/emailService';
// @ts-ignore
import { StandardCheckoutClient, Env, StandardCheckoutPayRequest } from 'pg-sdk-node';
import { InvoiceService } from '../finance/invoice.service';
import { getPhonePeClient, initiatePhonePePayment, generateAndSaveAllotmentOrder } from '../finance/payment.service';

// --- CONFIGURATION CONSTANTS ---
const PHONEPE_MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID || '';
const PHONEPE_SALT_KEY = process.env.PHONEPE_SALT_KEY || '';
const PHONEPE_SALT_INDEX = parseInt(process.env.PHONEPE_SALT_INDEX || '1', 10);
const PHONEPE_ENV = process.env.PHONEPE_ENV === 'PROD' ? Env.PRODUCTION : Env.SANDBOX;
const FRONTEND_URL_ADMISSION = process.env.FRONTEND_URL_ADMISSION || 'http://localhost:5173';

export const AdminStudentService = {
    async getAllApplications(query: any) {
        const { page = 1, limit = 10, search, status, quotaType, degreeType, applicationId, isScholarshipEligible, createdBy, qualificationVerifiedBy, gender, pref1, pref2, pref3, applicationFeePaid, examDate, qualificationVerified, certificateStatus, qualificationLevel, qualificationBoard, marks10thMin, marks10thMax, marks12thMin, marks12thMax, certificatesApproved, seatStatus, scholarship, scholarshipPercentage, program, branch, facilities, discountApplied, branchChange, seatCancellation, cancellationReason, allotmentOrder, dateRange, startDate, endDate } = query;
        const skip = (Number(page) - 1) * Number(limit);

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

        if (status) {
            where.admissionDetails = {
                status: status
            };
        }

        if (quotaType) {
            where.quotaType = quotaType;
        }

        if (degreeType) {
            where.degreeType = degreeType;
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

        if (createdBy) {
            where.createdBy = String(createdBy);
        }

        if (qualificationVerifiedBy) {
            where.academicQualifications = {
                some: { verifiedBy: String(qualificationVerifiedBy) }
            };
        }

        if (gender) {
            where.gender = { equals: String(gender), mode: 'insensitive' };
        }

        if (pref1) {
            where.pref1 = String(pref1);
        }

        if (pref2) {
            where.pref2 = String(pref2);
        }

        if (pref3) {
            where.pref3 = String(pref3);
        }

        if (examDate) {
            const start = new Date(String(examDate));
            start.setHours(0, 0, 0, 0);
            const end = new Date(String(examDate));
            end.setHours(23, 59, 59, 999);
            where.examDetails = {
                testDate: { gte: start, lte: end }
            };
        }

        if (qualificationVerified) {
            if (String(qualificationVerified).toUpperCase() === 'VERIFIED') {
                where.academicQualifications = {
                    ...where.academicQualifications,
                    every: { verificationStatus: 'APPROVED' }
                };
            } else if (String(qualificationVerified).toUpperCase() === 'UNVERIFIED') {
                where.academicQualifications = {
                    ...where.academicQualifications,
                    none: { verificationStatus: 'APPROVED' }
                };
            }
        }

        if (qualificationLevel) {
            where.academicQualifications = {
                some: { ...(where.academicQualifications?.some || {}), level: String(qualificationLevel) }
            };
        }

        if (qualificationBoard) {
            where.academicQualifications = {
                some: { ...(where.academicQualifications?.some || {}), board: { contains: String(qualificationBoard), mode: 'insensitive' } }
            };
        }

        if (marks10thMin || marks10thMax) {
            const range: any = {};
            if (marks10thMin) range.gte = Number(marks10thMin);
            if (marks10thMax) range.lte = Number(marks10thMax);
            where.academicQualifications = {
                some: { level: '10th', percentage: range }
            };
        }

        if (marks12thMin || marks12thMax) {
            const range: any = {};
            if (marks12thMin) range.gte = Number(marks12thMin);
            if (marks12thMax) range.lte = Number(marks12thMax);
            where.academicQualifications = {
                some: { level: '12th', percentage: range }
            };
        }

        if (certificateStatus) {
            where.documents = {
                every: { status: String(certificateStatus).toUpperCase() }
            };
        }

        if (certificatesApproved) {
            const val = String(certificatesApproved).toUpperCase();
            if (val === 'YES') {
                where.documents = { some: { status: 'APPROVED' } };
            } else if (val === 'NO') {
                where.documents = { none: { status: 'APPROVED' } };
            } else if (val === 'PENDING') {
                where.documents = { some: { status: 'PENDING' } };
            }
        }

        if (seatStatus) {
            const val = String(seatStatus).toUpperCase();
            if (val === 'ALLOTTED') {
                where.admissionDetails = { ...where.admissionDetails, allottedCourseId: { not: null } };
            } else if (val === 'PENDING') {
                where.admissionDetails = { ...where.admissionDetails, allottedCourseId: null };
            }
        }

        if (scholarship) {
            const val = String(scholarship).toUpperCase();
            where.studentScholarship = {
                isEligible: val === 'YES' ? 'YES' : 'NO'
            };
        }

        if (scholarshipPercentage) {
            where.studentScholarship = {
                ...where.studentScholarship,
                scholarshipPercentage: Number(scholarshipPercentage)
            };
        }

        if (program) {
            where.admissionDetails = {
                ...where.admissionDetails,
                allottedCourse: { degree: String(program) }
            };
        }

        if (branch) {
            where.admissionDetails = {
                ...where.admissionDetails,
                allottedCourseId: String(branch)
            };
        }

        if (facilities) {
            where.admissionDetails = {
                ...where.admissionDetails,
                accommodationType: String(facilities).toUpperCase()
            };
        }

        if (discountApplied) {
            const val = String(discountApplied).toUpperCase();
            if (val === 'YES') {
                where.discountRequests = { some: {} };
            } else if (val === 'NO') {
                where.discountRequests = { none: {} };
            }
        }

        if (branchChange) {
            const val = String(branchChange).toUpperCase();
            if (val === 'YES') {
                where.courseChangeLogs = { some: {} };
            } else if (val === 'NO') {
                where.courseChangeLogs = { none: {} };
            }
        }

        if (seatCancellation) {
            const val = String(seatCancellation).toUpperCase();
            if (val === 'YES') {
                where.cancellationRequests = { some: {} };
            } else if (val === 'NO') {
                where.cancellationRequests = { none: {} };
            }
        }

        if (cancellationReason) {
            where.cancellationRequests = {
                some: { conditionType: String(cancellationReason) }
            };
        }

        if (allotmentOrder) {
            const val = String(allotmentOrder).toUpperCase();
            if (val === 'YES') {
                where.documents = { some: { documentKey: 'ALLOTMENT_ORDER' } };
            } else if (val === 'NO') {
                where.documents = { none: { documentKey: 'ALLOTMENT_ORDER' } };
            }
        }

        if (applicationFeePaid === 'UNPAID') {
            where.payments = {
                none: {
                    component: PaymentComponent.APPLICATION_FEE,
                    status: PaymentStatus.SUCCESS
                }
            };
        } else if (applicationFeePaid === 'PAID') {
            where.payments = {
                some: {
                    component: PaymentComponent.APPLICATION_FEE,
                    status: PaymentStatus.SUCCESS
                }
            };
        }

        // createdAt date range filter
        if (dateRange) {
            const now = new Date();
            const startOfDayFn = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
            const endOfDayFn = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

            let gte: Date | undefined;
            let lte: Date | undefined;

            const val = String(dateRange).toLowerCase();

            if (val === 'today') {
                gte = startOfDayFn(now);
                lte = endOfDayFn(now);
            } else if (val === '7d') {
                const d = new Date(now);
                d.setDate(now.getDate() - 7);
                gte = startOfDayFn(d);
                lte = endOfDayFn(now);
            } else if (val === '15d') {
                const d = new Date(now);
                d.setDate(now.getDate() - 15);
                gte = startOfDayFn(d);
                lte = endOfDayFn(now);
            } else if (val === '30d') {
                const d = new Date(now);
                d.setDate(now.getDate() - 30);
                gte = startOfDayFn(d);
                lte = endOfDayFn(now);
            } else if (val === 'custom' && startDate && endDate) {
                gte = startOfDayFn(new Date(String(startDate)));
                lte = endOfDayFn(new Date(String(endDate)));
            }

            if (gte && lte) {
                where.createdAt = { gte, lte };
            }
        }

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
                    eligibleScholarshipRule: true,
                    scholarshipAllocation: { include: { rule: true } },
                    pref1Course: true,
                    pref2Course: true,
                    pref3Course: true,
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
                    hostelAllocation: true,
                    transportAllocation: true,
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

            return {
                ...student,
                aadharNumber: maskAadhaar(student.aadharNumber),
                profilePhotoUrl,
                documents: documentsWithPresignedUrls,
                // Removed flattened fields to match requested JSON structure
                // allottedCourseName, pref1CourseName etc. are removed
                // pendingDocs, s3FolderKey etc. are removed
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
                    eligibleScholarshipRule: true,
                    scholarshipAllocation: { include: { rule: true } },
                    pref1Course: true,
                    pref2Course: true,
                    pref3Course: true,
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
                    hostelAllocation: true,
                    transportAllocation: true,
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

            return {
                ...student,
                aadharNumber: maskAadhaar(student.aadharNumber),
                profilePhotoUrl,
                documents: documentsWithPresignedUrls,
                pref1CourseName: student.pref1Course?.name || null,
                pref2CourseName: student.pref2Course?.name || null,
                pref3CourseName: student.pref3Course?.name || null,
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

                const student = await registerStudent(mappedData, null, null, currentUserId || null);
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

        return await prisma.cancellationRequest.create({
            data: {
                studentId,
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

                if (request.student.admissionDetails?.allottedCourseId) {
                    await tx.course.update({
                        where: { id: request.student.admissionDetails.allottedCourseId },
                        data: { filledSeats: { decrement: 1 } }
                    });
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
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    status: AdmissionStatus.SEAT_ALLOTTED,
                    allottedCourseId: allottedCourseId
                }
            });

            await tx.course.update({
                where: { id: allottedCourseId },
                data: { filledSeats: { increment: 1 } }
            });

            await tx.seatAllocation.create({
                data: {
                    studentId,
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
        
        try {
            // Need to dynamic import or regular import. Using regular import at top of file is better.
            // For now, assuming import is added.
            const { ScholarshipService } = require('./scholarship.service'); 
            
            // Manual Scholarship Allocation
            // Admission team sets eligibleScholarshipRuleId during verification
            const ruleId = student.eligibleScholarshipRuleId;
            
            if (ruleId) {
                await ScholarshipService.allocateManualRule(studentId, ruleId);
            } else {
                logger.info(`No eligible scholarship rule set for student ${studentId}. Skipping allocation.`);
            }
        } catch (err) {
            logger.error(`Failed to allocate scholarship for ${studentId}: ${err}`);
        }

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
    async requestBranchChange(studentId: string, newCourseId: string, reason: string) {
        if (!studentId || !newCourseId || !reason) {
            throw new AppError('studentId, newCourseId and reason are required', 400);
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


    async approveCourseChange(requestId: string, approved: boolean, adminRole: string | undefined, adminId: string | undefined) {
        if (adminRole !== Role.SUPER_ADMIN) {
            throw new AppError(MESSAGES.ERROR.ONLY_SUPER_ADMIN_APPROVE_COURSE, 403);
        }

        if (!requestId) throw new AppError(MESSAGES.ERROR.REQUEST_ID_REQUIRED, 400);

        const request = await prisma.courseChangeRequest.findUnique({ where: { id: requestId } });
        if (!request) throw new AppError(MESSAGES.ERROR.REQUEST_NOT_FOUND, 404);

        const status = approved ? RequestStatus.APPROVED : RequestStatus.REJECTED;

        await prisma.$transaction(async (tx) => {
            await tx.courseChangeRequest.update({
                where: { id: requestId },
                data: {
                    status,
                    actionedBy: adminId,
                    actionedAt: new Date()
                }
            });

            if (approved) {
                // 1. Update Admission & Seats
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

                await tx.course.update({
                    where: { id: request.fromCourse },
                    data: { filledSeats: { decrement: 1 } }
                });
                await tx.course.update({
                    where: { id: request.toCourse },
                    data: { filledSeats: { increment: 1 } }
                });

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

                        await tx.studentFeeDemand.update({
                            where: { id: existingDemand.id },
                            data: {
                                amount: newFee,
                                scholarshipAmount: isTuition ? newScholarshipAmt : undefined,
                                discountAmount: isTuition ? newDiscountTotal : undefined,
                                netAmount: newNetAmount,
                                status: pending <= 0 ? FeeStatus.FULL : (currentPaid > 0 ? FeeStatus.PARTIAL : FeeStatus.PENDING),
                                remarks: (existingDemand.remarks || '') + ` | Course Change: Fee updated from ${oldFee} to ${newFee}`
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
                                await tx.studentLedger.update({
                                    where: { id: existingDemandLedger.id },
                                    data: {
                                        amount: newFee,
                                        description: `${existingDemandLedger.description} (Updated: ${oldFee} → ${newFee})`,
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
                                        createdBy: adminId
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
                                amount: struct.amount,
                                netAmount: struct.amount,
                                academicYearId,
                                dueDate: new Date(),
                                status: FeeStatus.PENDING,
                                remarks: `Added during course change to new course structure`
                            }
                        });
                    }
                }

                // 3. COURSE CHANGE PROCESSING FEE (10,000 DEDUCTION FROM PAID)
                // This is an internal deduction from the student's already-paid amount,
                // NOT a new fee demand. We only record a DEBIT ledger entry on the source head
                // and adjust the tuition demand's paid tracking accordingly.
                const DEDUCTION_AMOUNT = 10000;
                const actualDeduction = Math.min(totalPaidAcrossAll, DEDUCTION_AMOUNT);

                if (actualDeduction > 0) {
                    const sourceHeadId = tuitionHeadId || studentDemands[0]?.feeHeadId;

                    if (sourceHeadId) {
                        // Debit from student's paid amount (e.g., Tuition)
                        await tx.studentLedger.create({
                            data: {
                                studentId: request.studentId,
                                feeHeadId: sourceHeadId,
                                type: LedgerTransactionType.DEBIT,
                                amount: actualDeduction,
                                description: `Course change processing fee deducted from paid amount`,
                                referenceType: 'COURSE_CHANGE',
                                referenceId: request.id,
                                createdBy: adminId
                            }
                        });

                        // Update the source demand to reflect reduced effective payment
                        const sourceDemand = studentDemands.find(d => d.feeHeadId === sourceHeadId);
                        if (sourceDemand) {
                            const paidOnSource = sourceDemand.payments.reduce((sum, p) => sum + p.amount, 0);
                            const effectivePaid = paidOnSource - actualDeduction;
                            const netAmount = sourceDemand.netAmount ?? (sourceDemand.amount - (sourceDemand.discountAmount || 0));
                            const pending = netAmount - effectivePaid;

                            await tx.studentFeeDemand.update({
                                where: { id: sourceDemand.id },
                                data: {
                                    status: pending <= 0 ? FeeStatus.FULL : (effectivePaid > 0 ? FeeStatus.PARTIAL : FeeStatus.PENDING),
                                    remarks: (sourceDemand.remarks || '') + ` | Course change fee: ${actualDeduction} deducted from paid`
                                }
                            });
                        }
                    }
                }

                logger.info(`[approveCourseChange] Full reconciliation for Student ${student.id} to Course ${request.toCourse}. Deduction: ${actualDeduction} from paid: ${totalPaidAcrossAll}`);
            }
        });
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
        // Initialize adjustment delta
        let feeAdjustment = 0;

        await prisma.$transaction(async (tx) => {
            // Release previous allocation and calculate subtraction from Total Fee
            if (admission.accommodationType === AccommodationType.HOSTEL && admission.hostelId) {
                if (accommodationType !== AccommodationType.HOSTEL || hostelId !== admission.hostelId) {
                    await tx.hostel.update({
                        where: { id: admission.hostelId },
                        data: { filled: { decrement: 1 }, updatedBy: adminId }
                    });
                    
                    // Subtract old hostel cost
                    const oldHostel = await tx.hostel.findUnique({ where: { id: admission.hostelId } });
                    if (oldHostel) feeAdjustment -= (oldHostel.cost || 0);
                }
            } else if (admission.accommodationType === AccommodationType.TRANSPORT && admission.transportRouteId) {
                if (accommodationType !== AccommodationType.TRANSPORT || transportRouteId !== admission.transportRouteId) {
                    await tx.transportRoute.update({
                        where: { id: admission.transportRouteId },
                        data: { filled: { decrement: 1 }, updatedBy: adminId }
                    });
                    
                    // Subtract old transport cost
                    const oldRoute = await tx.transportRoute.findUnique({ where: { id: admission.transportRouteId } });
                    if (oldRoute) feeAdjustment -= (oldRoute.cost || 0);
                }
            }

            // Assign new allocation and calculate addition to Total Fee
            if (accommodationType === AccommodationType.HOSTEL) {
                if (!hostelId) throw new AppError(MESSAGES.ERROR.HOSTEL_ID_REQUIRED, 400);

                if (hostelId !== admission.hostelId) {
                    const hostel = await tx.hostel.findUnique({ where: { id: hostelId } });
                    if (!hostel) throw new AppError(MESSAGES.ERROR.HOSTEL_NOT_FOUND, 404);

                    if ((hostel.filled ?? 0) >= hostel.capacity) throw new AppError(MESSAGES.ERROR.HOSTEL_FULL, 400);

                    await tx.hostel.update({
                        where: { id: hostelId },
                        data: { filled: { increment: 1 }, updatedBy: adminId }
                    });
                    
                    // Add new hostel cost
                    feeAdjustment += (hostel.cost || 0);
                } else {
                     // Same hostel, no fee change unless we assume cost changed (unlikely for admission update flow)
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
                    
                    // Add new transport cost
                    feeAdjustment += (route.cost || 0);
                } else {
                    // Same route
                }
            }
            
            // Handle Hostel Payment Mode Adjustment
            if (admission.accommodationType === AccommodationType.HOSTEL && admission.hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                feeAdjustment -= 6000;
            }
            if (accommodationType === AccommodationType.HOSTEL && hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                feeAdjustment += 6000;
            }

            const currentPaid = (admission.paidFee ?? 0) + Number(paidAmount || 0);
            
            // Calculate final fee status
            // Note: We use increment for totalFee, but to check status we need the PREDICTED new total.
            // Current DB total might be X. New total = X + feeAdjustment.
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
                pref1Course: true,
                eligibleScholarshipRule: true
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

        return await prisma.student.update({
            where: { id: studentId },
            data: { eligibleScholarshipRuleId: ruleId }
        });
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
                eligibleScholarshipRule: true,
                scholarshipAllocation: { include: { rule: true } },
                studentScholarship: true,
                pref1Course: true,
                pref2Course: true,
                pref3Course: true,
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
                discountRequests: true,
                ledgerEntries: true,
                enrollments: {
                     include: {
                         academicYear: true,
                         section: { include: { batch: true } }
                     }
                },
                hostelAllocation: { include: { bed: { include: { room: { include: { block: { include: { hostel: true } } } } } } } },
                transportAllocation: { include: { route: true, stop: true } },
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

        return {
            ...student,
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

        const student = await prisma.student.findUnique({
            where: { applicationId },
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
                eligibleScholarshipRule: true,
                scholarshipAllocation: { include: { rule: true } },
                studentScholarship: true,
                pref1Course: true,
                pref2Course: true,
                pref3Course: true,
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
                discountRequests: true,
                ledgerEntries: true,
                enrollments: {
                     include: {
                         academicYear: true,
                         section: { include: { batch: true } }
                     }
                },
                hostelAllocation: { include: { bed: { include: { room: { include: { block: { include: { hostel: true } } } } } } } },
                transportAllocation: { include: { route: true, stop: true } },
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

        return {
            ...student,
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
             if (updateProps.score) updateProps.score = Number(updateProps.score);
             if (updateProps.scholarshipPercentage) updateProps.scholarshipPercentage = Number(updateProps.scholarshipPercentage);

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
             }

             return updated;
         }

         // CREATE New
         const newScholarship = await prisma.studentScholarship.create({
             data: {
                 studentId,
                 type,
                 degreeType,
                 score: score ? Number(score) : undefined,
                 remarks,
                 scholarshipPercentage: scholarshipPercentage ? Number(scholarshipPercentage) : undefined,
                 qualificationId,
                 isEligible,
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

        // Filter for Tuition/College fees by checking the resolved Fee Head name
        const tuitionDemands = demands.filter((d: any) => {
            const head = d.feeHead || d.feeStructure?.feeHead;
            if (!head) return false;
            
            const name = head.name.toLowerCase();
            return ['tuition', 'college', 'academic'].some(key => name.includes(key));
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
                    type: 'CREDIT'
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

            // Release old seats if any
            if (oldAdmission) {
                if (oldAdmission.hostelId && (oldAdmission.hostelId !== allocation.hostelId || allocation.type !== AccommodationType.HOSTEL)) {
                     logger.debug(`[executeAdmissionUpdates] Releasing old hostel seat: ${oldAdmission.hostelId}`);
                     await tx.hostel.update({ where: { id: oldAdmission.hostelId }, data: { filled: { decrement: 1 } } });
                }
                if (oldAdmission.transportRouteId && (oldAdmission.transportRouteId !== allocation.transportRouteId || allocation.type !== AccommodationType.TRANSPORT)) {
                     logger.debug(`[executeAdmissionUpdates] Releasing old transport seat: ${oldAdmission.transportRouteId}`);
                     await tx.transportRoute.update({ where: { id: oldAdmission.transportRouteId }, data: { filled: { decrement: 1 } } });
                }
                // Course Seat (Decrement old if different)
                if (oldAdmission.allottedCourseId && oldAdmission.allottedCourseId !== course.allottedCourseId) {
                     logger.debug(`[executeAdmissionUpdates] Releasing old course seat: ${oldAdmission.allottedCourseId}`);
                     await tx.course.update({ where: { id: oldAdmission.allottedCourseId }, data: { filledSeats: { decrement: 1 } } });
                }
            }

            // Assign New Accommodation
            if (allocation.type === AccommodationType.HOSTEL) {
                logger.debug(`[executeAdmissionUpdates] Assigning new hostel seat: ${allocation.hostelId}`);
                await tx.hostel.update({ where: { id: allocation.hostelId }, data: { filled: { increment: 1 } } });
            } else if (allocation.type === AccommodationType.TRANSPORT) {
                logger.debug(`[executeAdmissionUpdates] Assigning new transport seat: ${allocation.transportRouteId}`);
                await tx.transportRoute.update({ where: { id: allocation.transportRouteId }, data: { filled: { increment: 1 } } });
            }

            // --- 2. Course Allocation ---
            if (!oldAdmission?.allottedCourseId || oldAdmission.allottedCourseId !== course.allottedCourseId) {
                logger.debug(`[executeAdmissionUpdates] Assigning new course seat: ${course.allottedCourseId}`);
                // Atomic check-and-increment using raw SQL to prevent TOCTOU overbooking:
                // UPDATE only fires when filledSeats < totalSeats — no separate read needed
                const result = await tx.$executeRaw`
                    UPDATE "Course"
                    SET "filledSeats" = "filledSeats" + 1
                    WHERE id = ${course.allottedCourseId} AND "filledSeats" < "totalSeats"
                `;
                if (result === 0) {
                    const courseRecord = await tx.course.findUnique({ where: { id: course.allottedCourseId } });
                    if (!courseRecord) throw new AppError("Invalid Course ID", 400);
                    logger.warn(`[executeAdmissionUpdates] Course ${course.allottedCourseId} is fully booked (${courseRecord.filledSeats}/${courseRecord.totalSeats})`);
                    throw new AppError("Course is fully booked. No seats available.", 400);
                }
            }

            // --- Calculate Accommodation Cost Delta ---
            let accCostDelta = 0;
            
            // 1. Subtract Old Cost
            if (oldAdmission) {
                 if (oldAdmission.accommodationType === AccommodationType.HOSTEL && oldAdmission.hostelId) {
                     const h = await tx.hostel.findUnique({ where: { id: oldAdmission.hostelId } });
                     if (h) accCostDelta -= (h.cost || 0);
                 } else if (oldAdmission.accommodationType === AccommodationType.TRANSPORT && oldAdmission.transportRouteId) {
                     const r = await tx.transportRoute.findUnique({ where: { id: oldAdmission.transportRouteId } });
                     if (r) accCostDelta -= (r.cost || 0);
                 }
                 
                 // Subtract semwise extra if applicable
                 if (oldAdmission.accommodationType === AccommodationType.HOSTEL && oldAdmission.hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                     accCostDelta -= 6000;
                 }
            }

            // 2. Add New Cost
            if (allocation.type === AccommodationType.HOSTEL && allocation.hostelId) {
                 // Already verified existence in flow usually, but safe access
                 const h = await tx.hostel.findUnique({ where: { id: allocation.hostelId } });
                 if (h) accCostDelta += (h.cost || 0);
             } else if (allocation.type === AccommodationType.TRANSPORT && allocation.transportRouteId) {
                 const r = await tx.transportRoute.findUnique({ where: { id: allocation.transportRouteId } });
                 if (r) accCostDelta += (r.cost || 0);
             }
            
             // Add semwise extra if applicable
            if (allocation.type === AccommodationType.HOSTEL && allocation.hostelPaymentMode === HostelPaymentMode.SEMWISE) {
                 accCostDelta += 6000;
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

                 return itx.payment.create({
                     data: {
                         studentId,
                         amount: payment.amount,
                         method: payment.method,
                         mode: PaymentMode.ONLINE,
                         status: PaymentStatus.PENDING,
                         component: targetComponent,
                         providerTxId: merchantTransactionId,
                         feeHeadId: payment.feeHeadId,
                         feeDemandId: feeDemandId || undefined,
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
        const courses = await prisma.course.findMany({ where: { id: { in: courseIds } }, select: { id: true, name: true } });
        const courseMap = Object.fromEntries(courses.map(c => [c.id, c.name]));

        const data = requests.map((r: any) => ({
            ...r,
            fromCourseName: courseMap[r.fromCourse] || null,
            toCourseName: courseMap[r.toCourse] || null
        }));

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
        const hostelId = admission?.hostelId;
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

            // 2e. Decrement course filledSeats
            if (allottedCourseId) {
                await tx.course.update({
                    where: { id: allottedCourseId },
                    data: { filledSeats: { decrement: 1 } }
                });
                logger.info(`[reverseAdmissionPayment] Decremented filledSeats for course=${allottedCourseId}`);
            }

            // 2f. Release hostel / transport seat
            if (accommodationType === AccommodationType.HOSTEL && hostelId) {
                await tx.hostel.update({
                    where: { id: hostelId },
                    data: { filled: { decrement: 1 } }
                });
            } else if (accommodationType === AccommodationType.TRANSPORT && transportRouteId) {
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
                    admissionDetails: {
                        select: {
                            seatAllottedAt: true,
                            accommodationType: true,
                            allottedCourse: {
                                select: { name: true, degree: true }
                            },
                            hostel: {
                                select: { cost: true }
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
                            feeHead: { select: { name: true } }
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
            const demands = student.feeDemands as { netAmount: number | null; amount: number; feeHead: { name: string } | null }[];
            const credits = student.ledgerEntries as { amount: number; description: string | null }[];

            const getTotalByHead = (keyword: string) =>
                demands
                    .filter((d) => d.feeHead?.name?.toUpperCase().includes(keyword.toUpperCase()))
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

            // Description-based: HOSTEL_ACCOMODATION, HOSTEL_MESS, TRANSPORT
            const hostelPaid = credits
                .filter((c) => {
                    const kw = getFeeKeyword(c.description);
                    return kw === 'HOSTEL_ACCOMODATION' || kw === 'HOSTEL_MESS';
                })
                .reduce((sum, c) => sum + (c.amount ?? 0), 0);

            const hostelTotal = student.admissionDetails?.hostel?.cost ?? 0;

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
                degree: student.admissionDetails?.allottedCourse?.degree ?? null,
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
                    paid: getPaidByDesc('BOOK_BANK'),       // ledger description suffix: "BOOK_BANK"
                    total: getTotalByHead('BOOK BANK')      // feeHead.name: "Book Bank"
                },
                hostelFee: {
                    paid: hostelPaid,
                    total: hostelTotal
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
    }
};

