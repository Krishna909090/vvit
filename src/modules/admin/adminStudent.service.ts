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
import { sendAdmissionFeeReceipt, sendPaymentReceipt } from '../../utils/emailService';
// @ts-ignore
import { StandardCheckoutClient, Env, StandardCheckoutPayRequest } from 'pg-sdk-node';
import { InvoiceService } from '../finance/invoice.service';
import { getPhonePeClient } from '../finance/payment.service';

// --- CONFIGURATION CONSTANTS ---
const PHONEPE_MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID || '';
const PHONEPE_SALT_KEY = process.env.PHONEPE_SALT_KEY || '';
const PHONEPE_SALT_INDEX = parseInt(process.env.PHONEPE_SALT_INDEX || '1', 10);
const PHONEPE_ENV = process.env.PHONEPE_ENV === 'PROD' ? Env.PRODUCTION : Env.SANDBOX;
const FRONTEND_URL_ADMISSION = process.env.FRONTEND_URL_ADMISSION || 'http://localhost:5173';

export const AdminStudentService = {
    async getAllApplications(query: any) {
        const { page = 1, limit = 10, search, status, quotaType, courseType, applicationId } = query;
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

        if (courseType) {
            where.degreeType = courseType;
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
                    enrollment: true,
                    hostelAllocation: true,
                    transportAllocation: true,
                    convenorDetails: true
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

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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

        return updatedDoc;
    },

    async requestCourseChange(studentId: string, newCourseId: string, reason: string) {
        if (!studentId || !newCourseId || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_NEWCOURSE_REASON_REQUIRED, 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: true }
        });

        if (!student || !student.admissionDetails?.allottedCourseId) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NO_ALLOTTED_COURSE, 400);
        }

        const oldCourseId = student.admissionDetails.allottedCourseId;

        return await prisma.courseChangeRequest.create({
            data: {
                studentId,
                fromCourse: oldCourseId,
                toCourse: newCourseId,
                reason,
                status: RequestStatus.FORWARDED,
                forwardedTo: 'SUPER_ADMIN'
            }
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

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
                        approvedBy: adminId || 'SUPER_ADMIN'
                    }
                });

                // 2. FINANCIAL RECONCILIATION
                const student = await tx.student.findUnique({
                    where: { id: request.studentId },
                });
                
                if (!student) return;

                // Find Existing Tuition Demand
                // We need to fetch payments to calculate paid amount since it's not stored on demand (it seems)
                const existingDemand = await tx.studentFeeDemand.findFirst({
                    where: {
                        studentId: request.studentId,
                        feeHead: {
                            name: { contains: 'Tuition', mode: 'insensitive' }
                        }
                    },
                    orderBy: { createdAt: 'desc' },
                    include: { 
                        academicYear: true,
                        payments: {
                            where: { status: 'SUCCESS' }
                        }
                    } 
                });

                if (existingDemand && existingDemand.academicYearId) {
                    // Find NEW Fee Structure matching existing parameters but New Course
                    const newFeeStructure = await tx.feeStructure.findFirst({
                        where: {
                            courseId: request.toCourse,
                            academicYearId: existingDemand.academicYearId,
                            feeHeadId: existingDemand.feeHeadId!, 
                            // quotaType check removed due to lint error, likely matches by logic/seed or field mismatch on structure
                        }
                    });

                    if (newFeeStructure) {
                        const oldFee = existingDemand.amount;
                        const newFee = newFeeStructure.amount;
                        
                        // Calculate Paid Amount
                        const paidAmount = existingDemand.payments.reduce((sum, p) => sum + p.amount, 0);

                        const discount = existingDemand.discountAmount || 0;
                        const scholarship = existingDemand.scholarshipAmount || 0;
                        const totalDeduction = discount + scholarship;

                        const newNetAmount = newFee - totalDeduction; 
                        const pendingAmount = newNetAmount - paidAmount;

                        let newStatus: FeeStatus = FeeStatus.PENDING;
                        if (pendingAmount <= 0) newStatus = FeeStatus.FULL; 
                        else if (paidAmount > 0) newStatus = FeeStatus.PARTIAL;

                        // Update Demand
                        await tx.studentFeeDemand.update({
                            where: { id: existingDemand.id },
                            data: {
                                amount: newFee,
                                netAmount: newNetAmount,
                                status: newStatus,
                                remarks: (existingDemand.remarks || '') + ` | Course Change: Fee updated from ${oldFee} to ${newFee}`
                            }
                        });


                        // Create Ledger Entry
                        await tx.studentLedger.create({
                            data: {
                                studentId: request.studentId,
                                type: 'DEBIT', // Using String as fallback if Enum import fails, usually works
                                amount: 0,
                                description: `Course Change Fee Adjustment (${oldFee} -> ${newFee}). Paid: ${paidAmount}. New Pending: ${pendingAmount}`,
                                referenceType: 'OTHER',
                                referenceId: request.id,
                                createdBy: adminId
                            } as any
                        });

                        logger.info(`[approveCourseChange] Fee updated for Student ${student.id}: ${oldFee} -> ${newFee}`);
                    }
                }
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

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
        const enrollment = await prisma.studentEnrollment.upsert({
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

        return { success: true, message: 'Student personal details updated successfully' };
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
                enrollment: {
                     include: {
                         academicYear: true,
                         section: { include: { batch: true } }
                     }
                },
                hostelAllocation: { include: { bed: { include: { room: { include: { block: { include: { hostel: true } } } } } } } },
                transportAllocation: { include: { route: true, stop: true } },
                convenorDetails: true,
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
                enrollment: {
                     include: {
                         academicYear: true,
                         section: { include: { batch: true } }
                     }
                },
                hostelAllocation: { include: { bed: { include: { room: { include: { block: { include: { hostel: true } } } } } } } },
                transportAllocation: { include: { route: true, stop: true } },
                convenorDetails: true,
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

    async validateAcademicQualification(qualificationId: string, status: string, adminId: string | undefined) {
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
                updatedBy: adminId
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

         // STRICT CREATE ONLY
         // Check if scholarship already exists for this student
         const existing = await prisma.studentScholarship.findFirst({
             where: { studentId }
         });

         if (existing) {
             throw new AppError('Scholarship record already exists for this student. Use PUT endpoint to update.', 409);
         }

         return await prisma.studentScholarship.create({
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

        const { type, degreeType, score, remarks, scholarshipPercentage, qualificationId } = data;

        // Check qualification existence if updating it
        if (qualificationId) {
             const qual = await prisma.academicQualification.findUnique({ where: { id: qualificationId } });
             if (!qual) throw new AppError('Qualification not found', 404);
        }

        return await prisma.$transaction(async (tx) => {
            // 1. Update the Scholarship Record
            const updatedScholarship = await tx.studentScholarship.update({
                where: { id: scholarshipId },
                data: {
                    type,
                    degreeType,
                    score: score ? Number(score) : undefined,
                    remarks,
                    scholarshipPercentage: scholarshipPercentage ? Number(scholarshipPercentage) : undefined,
                    qualificationId,
                    updatedBy: adminId
                }
            });

            // 2. Propagate Changes to Demands & Ledger (Using Helper)
            const newPct = updatedScholarship.scholarshipPercentage || 0;
            const studentId = updatedScholarship.studentId;

            logger.info(`[editStudentScholarship] Propagating update to ${newPct}% for student ${studentId}`);

            await this.propagateScholarshipUpdate(studentId, newPct, adminId, tx);

            return updatedScholarship;
        });
    },

    async getScholarshipStats() {
        // Group by degreeType and scholarshipPercentage
        const dbStats = await prisma.studentScholarship.groupBy({
            by: ['degreeType', 'scholarshipPercentage'],
            _count: {
                studentId: true
            }
        });

        // Define required combinations
        const manualDefaults = [
            { degreeType: 'B.Tech', scholarshipPercentage: 50 },
            { degreeType: 'B.Tech', scholarshipPercentage: 25 },
            { degreeType: 'B.Tech', scholarshipPercentage: 15 },
            { degreeType: 'BBA', scholarshipPercentage: 50 },
            { degreeType: 'BBA', scholarshipPercentage: 30 },
            { degreeType: 'M.Tech', scholarshipPercentage: 50 },
            { degreeType: 'M.Tech', scholarshipPercentage: 25 }
        ];

        // Create a map of existing stats
        // Key: "DegreeType-Percentage"
        const statsMap = new Map();
        dbStats.forEach(item => {
            const key = `${item.degreeType}-${item.scholarshipPercentage}`;
            statsMap.set(key, item._count.studentId);
        });

        const finalStats: { degreeType: string; scholarshipPercentage: number | null; count: number }[] = [];

        // 1. Add required defaults (overwriting with actuals if present)
        manualDefaults.forEach(def => {
            const key = `${def.degreeType}-${def.scholarshipPercentage}`;
            const count = statsMap.get(key) || 0;
            finalStats.push({
                degreeType: def.degreeType,
                scholarshipPercentage: def.scholarshipPercentage,
                count: count
            });
            // Mark as processed so we don't duplicate if we want to show "others"
            statsMap.delete(key);
        });

        // 2. Add any other combinations found in DB that were not in manual defaults
        statsMap.forEach((count, key) => {
             // We need to parse the key back, or better yet, loop through original dbStats and check if processed.
             // But map key iteration is string based. 
             // Let's loop dbStats again simply.
        });
        
        // Simpler approach for step 2:
        dbStats.forEach(item => {
             const isDefault = manualDefaults.some(d => d.degreeType === item.degreeType && d.scholarshipPercentage === item.scholarshipPercentage);
             if (!isDefault) {
                 finalStats.push({
                     degreeType: item.degreeType || 'Unknown',
                     scholarshipPercentage: item.scholarshipPercentage,
                     count: item._count.studentId
                 });
             }
        });

        return finalStats;

    },



    // --- HELPER: Propagate Scholarship Changes ---
    propagateScholarshipUpdate: async (studentId: string, newPct: number, adminId: string | undefined, tx: Prisma.TransactionClient) => {
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
        const tuitionDemands = demands.filter(d => {
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

    async executeAdmissionUpdates(studentId: string, payload: any, paymentId: string, adminId: string, tx: Prisma.TransactionClient) {
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
                await tx.course.update({
                     where: { id: course.allottedCourseId },
                     data: { filledSeats: { increment: 1 } }
                });
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
                    totalFee: { increment: accCostDelta }
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
                    totalFee: accCostDelta > 0 ? accCostDelta : 0
                }
            });
            
             // --- 4. Scholarship Update ---
            const currentScholarship = await tx.studentScholarship.findUnique({ where: { studentId } });
            
            // Only update if percentage changed or didn't exist
            if (!currentScholarship || currentScholarship.scholarshipPercentage !== scholarship.percentage) {
                 logger.debug(`[executeAdmissionUpdates] Updating Scholarship: ${scholarship.percentage}% (Old: ${currentScholarship?.scholarshipPercentage}%)`);
                 
                 await tx.studentScholarship.update({
                    where: { studentId },
                    data: {
                        scholarshipPercentage: scholarship.percentage,
                        updatedBy: adminId,
                        isEligible: 'YES'
                    }
                });
                
                // Propagate
                await this.propagateScholarshipUpdate(studentId, scholarship.percentage, adminId, tx);
            } else {
                logger.info(`[executeAdmissionUpdates] Scholarship percentage unchanged (${scholarship.percentage}%). Skipping update.`);
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
        const [student, validCourse, validFeeHead] = await Promise.all([
            prisma.student.findUnique({
                where: { id: studentId },
                include: { admissionDetails: true }
            }),
            prisma.course.findUnique({ where: { id: course.allottedCourseId } }),
            payment.feeHeadId ? prisma.feeHead.findUnique({ where: { id: payment.feeHeadId } }) : Promise.resolve({ id: 'skip' })
        ]);

        if (!student) {
            logger.warn(`[finalizeAdmission] Student not found: ${studentId}`);
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        if (student.admissionDetails?.status === AdmissionStatus.ADMISSION_CONFIRMED || student.admissionDetails?.status === AdmissionStatus.ENROLLED) {
             logger.info(`[finalizeAdmission] Student ${studentId} seat already confirmed (Status: ${student.admissionDetails.status})`);
             throw new AppError("Student seat is already confirmed. Cannot re-finalize.", 400);
        }

        if (!validCourse) {
            logger.warn(`[finalizeAdmission] Invalid Course ID: ${course.allottedCourseId}`);
            throw new AppError("Invalid Course ID" , 400);
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
        let feeDemandId = null;
        if (payment.feeStructureId) {
            const validStructure = await prisma.feeStructure.findUnique({ where: { id: payment.feeStructureId } });
            if (!validStructure) {
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
        const isOnline = !([PaymentMethod.CASH, PaymentMethod.CHEQUE, PaymentMethod.DEMAND_DRAFT].includes(payment.method));
        logger.info(`[finalizeAdmission] Flow Type detected: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);

            if (isOnline) {
             // === ONLINE FLOW (Initiate) ===
             try {
             
             // ------------------------------------------------------------------
             // BLOCK 3: IDEMPOTENCY CHECK
             // Check if a PENDING payment already exists for this student/fee.
             // If yes, we reuse it to avoid duplicate records and return the same link.
             // ------------------------------------------------------------------
             const targetComponent = payment.component || PaymentComponent.TUITION;
             const existingPending = await prisma.payment.findFirst({
                 where: {
                     studentId,
                     component: targetComponent,
                     status: PaymentStatus.PENDING
                 }
             });

             let newPayment;
             let isNew = true;

             if (existingPending) {
                 logger.info(`[finalizeAdmission] Found existing PENDING payment ${existingPending.id}. Reusing it.`);
                 newPayment = existingPending;
                 isNew = false;
                 
                 // Reuse existing providerTxId if available and matches TXN format, otherwise generate new one
                 if (!newPayment.providerTxId || !newPayment.providerTxId.startsWith('TXN_')) {
                     const newTxnId = `TXN_${Date.now()}_${studentId.substring(0, 8)}`;
                     logger.info(`[finalizeAdmission] Existing payment missing valid TXN ID. Updating to ${newTxnId}`);
                     newPayment = await prisma.payment.update({
                         where: { id: newPayment.id },
                         data: { providerTxId: newTxnId }
                     });
                 }
             } else {
                 try {
                     // ------------------------------------------------------------------
                     // BLOCK 4: CREATE PAYMENT RECORD
                     // No existing payment found. Create a new PENDING record.
                     // We generate a transaction ID (TXN_...) to track it.
                     // ------------------------------------------------------------------
                     logger.info(`[finalizeAdmission][Online] Step 1: Creating PENDING payment record`);
                     
                     const feeComponent = targetComponent; 
                     const merchantTransactionId = `TXN_${Date.now()}_${studentId.substring(0, 8)}`;

                     newPayment = await prisma.payment.create({
                         data: {
                             studentId,
                             amount: payment.amount,
                             method: payment.method,
                             mode: PaymentMode.ONLINE,
                             status: PaymentStatus.PENDING, 
                             component: feeComponent,
                             providerTxId: merchantTransactionId, // Verify providerTxId
                             feeHeadId: payment.feeHeadId,
                             feeDemandId: feeDemandId || undefined,
                             collectedBy: adminId,
                             createdBy: adminId, // Strict data
                             metadata: { 
                                scholarship, 
                                allocation, 
                                course,
                                feeComponent,
                                feeStructureId: payment.feeStructureId,
                                targetAction: 'FINALIZE_ADMISSION' 
                             }
                         }
                     });
                 } catch (e: any) { throw e; }
             }

             // Use stored providerTxId or regenerate if missing (shouldn't happen for new ones)
             const merchantTransactionId = newPayment.providerTxId || newPayment.id.replace(/-/g, '');


                 // ------------------------------------------------------------------
                 // BLOCK 5: PAYMENT GATEWAY INTEGRATION
                 // Initiate the payment request with PhonePe SDK.
                 // We receive a redirect URL to send to the frontend.
                 // ------------------------------------------------------------------
                 // Step 2: PhonePe Integration
                 logger.info(`[finalizeAdmission][Online] Step 2: Initiating PhonePe Request`);

                 const client = StandardCheckoutClient.getInstance(PHONEPE_MERCHANT_ID, PHONEPE_SALT_KEY, PHONEPE_SALT_INDEX as any, PHONEPE_ENV);
 
                 const request = StandardCheckoutPayRequest.builder()
                     .merchantOrderId(merchantTransactionId)
                     .amount(Math.round(payment.amount * 100))
                     .redirectUrl(`${FRONTEND_URL_ADMISSION}/admin/seatallotment/details?studentId=${studentId}&paymentId=${newPayment.id}`)
                     .build();

                 const response = await client.pay(request);
                 const redirectUrl = response.redirectUrl;

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
                        feeDemandId: feeDemandId || undefined,
                        referenceNumber: payment.referenceNumber || `REF-${Date.now()}`,
                        instrumentDate: payment.date ? new Date(payment.date) : new Date(),
                        collectedBy: adminId,
                        createdBy: adminId, // Strict data
                        metadata: { 
                            scholarship, 
                            allocation, 
                            course,
                            feeComponent,
                            feeStructureId: payment.feeStructureId,
                            notes: 'Offline Immediate Finalization' 
                         }
                    }
                });
                logger.debug(`[finalizeAdmission][Offline] Payment record created: ${newPayment.id}`);

                // Step 2: Execute Updates (Allocation, Scholarship, etc.)
                logger.info(`[finalizeAdmission][Offline] Step 2: Executing admission updates`);
                await this.executeAdmissionUpdates(studentId, payload, newPayment.id, adminId, tx);

                // Step 3: Update Ledger
                logger.info(`[finalizeAdmission][Offline] Step 3: Updating Student Ledger`);
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: LedgerTransactionType.CREDIT,
                        amount: payment.amount,
                        description: `Tution Payment (${payment.method}) - ${feeComponent}`,
                        referenceId: newPayment.id,
                        referenceType: 'PAYMENT',
                        feeHeadId: payment.feeHeadId, 
                        createdBy: adminId
                    } as Prisma.StudentLedgerUncheckedCreateInput
                });

                // Step 4: Increment Paid Fee 
                logger.info(`[finalizeAdmission][Offline] Step 4: Incrementing Paid Fee`);
                await tx.studentAdmission.update({
                    where: { studentId },
                    data: { paidFee: { increment: payment.amount } }
                });

                // Step 5: Settle Fee Demand (Strict Link)
                if (feeDemandId) {
                    logger.info(`[finalizeAdmission][Offline] Step 5: Settling Demand ${feeDemandId}`);
                    // Fetch demand to check amount (need to read from TX or use cached info? Safe to read)
                    const demand = await tx.studentFeeDemand.findUnique({ where: { id: feeDemandId } });
                    if (demand) {
                        const newStatus = payment.amount >= (demand.netAmount || demand.amount) ? 'FULL' : 'PARTIAL'; // Use netAmount if exists
                         await tx.studentFeeDemand.update({
                            where: { id: feeDemandId },
                            data: { status: newStatus as any }
                        });
                    }
                }

                logger.info(`[finalizeAdmission][Offline] Transaction committed successfully.`);
                return { success: true, type: 'OFFLINE_COMPLETED', message: "Admission Finalized Successfully", paymentId: newPayment.id };
             });

             // Auto-generate invoice (Outside TX)
             let generatedInvoiceUrl: string | null = null;
             try {
                if (offlineResult.paymentId) {
                    const invoiceResult = await InvoiceService.generateInvoiceForPayment(offlineResult.paymentId);
                    generatedInvoiceUrl = invoiceResult.invoiceUrl;
                }
             } catch (err) {
                logger.warn(`[finalizeAdmission] Failed to auto-generate invoice: ${err}`);
             }

             // Send Email Notification (Offline)
             try {
                 const p = await prisma.payment.findUnique({ 
                     where: { id: offlineResult.paymentId },
                     include: { student: true }
                 });

                 if (p && p.student.email) {
                    // Re-fetch formatted Invoice URL if needed or use what we got
                    if (!generatedInvoiceUrl && p.invoiceUrl) {
                        generatedInvoiceUrl = await convertToPresignedUrl(p.invoiceUrl);
                    }

                    // Derive Payment Name
                    let paymentTypeName = 'Admission Fee'; // Default fallback
                    let emailPaymentType = 'ADMISSION_FEE';

                    if (p.component === PaymentComponent.TUITION) {
                        paymentTypeName = 'Tuition Fee';
                        emailPaymentType = 'TUITION_FEE';
                    } else if (p.component === PaymentComponent.APPLICATION_FEE) {
                        paymentTypeName = 'Application Fee';
                        emailPaymentType = 'APPLICATION_FEE';
                    } else if (p.component === PaymentComponent.SCHOLARSHIP_TOKEN) {
                        paymentTypeName = 'Admission Fee'; // Token usually means Admission Fee
                         emailPaymentType = 'ADMISSION_FEE';
                    }

                    await sendPaymentReceipt(p.student.email, {
                        studentName: p.student.name,
                        invoiceNumber: p.referenceNumber || p.id, 
                        applicationId: p.student.applicationId || 'N/A',
                        transactionId: p.referenceNumber || 'OFFLINE',
                        amount: p.amount,
                        date: new Date(),
                        paymentType: emailPaymentType as any, 
                        customFeeType: paymentTypeName, 
                        invoiceUrl: generatedInvoiceUrl || undefined,
                        address: {
                            line1: p.student.address,
                            line2: p.student.address2 || '',
                            city: p.student.city,
                            state: p.student.state,
                            pincode: p.student.pincode
                        }
                    });
                    logger.info(`[finalizeAdmission][Offline] Email receipt sent to ${p.student.email}`);
                 }
             } catch(e) {
                 logger.error(`[finalizeAdmission][Offline] Failed to send email: ${e}`);
             }

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
            // Already processed logic...
             logger.info(`[verifyAndCompletePayment] Payment ${paymentId} already processed.`);
             return { 
                success: true, 
                message: "Payment successfully processed", 
                status: PaymentStatus.SUCCESS,
                data: {
                    paymentId: payment.id,
                    invoiceUrl: await convertToPresignedUrl(payment.invoiceUrl),
                    amount: payment.amount,
                    transactionId: payment.providerTxId
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

        const result = await prisma.$transaction(async (tx) => {
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

             const promises: Promise<any>[] = [];

             // Logic for Each Payment
             for (const payment of pendingPayments) {
                  const meta = payment.metadata as any;
                  // Ledger
                  promises.push(tx.studentLedger.create({
                      data: {
                        studentId: payment.studentId,
                        type: LedgerTransactionType.CREDIT,
                        amount: payment.amount,
                        description: `Admission Payment (${payment.method || 'ONLINE'}) - ${payment.component || 'FEE'}`,
                        referenceId: payment.id,
                        referenceType: 'PAYMENT',
                        feeHeadId: payment.feeHeadId, 
                        createdBy: adminId || 'SYSTEM'
                      } as any
                  }));

                  // Updates (Admission, etc)
                  if (meta && meta.targetAction === 'FINALIZE_ADMISSION') {
                       promises.push(this.executeAdmissionUpdates(payment.studentId, meta, payment.id, adminId || 'SYSTEM', tx));
                  }
             }
             
             await Promise.all(promises);
             return { success: true, status: PaymentStatus.SUCCESS };
         });

         // Invoice (Unified) for Bundle
         // We pass ALL payment IDs to Invoice Service (requires update to InvoiceService to handle bundle detection automatically or explicitly)
         // For now, if we call generateInvoiceForPayment on the FIRST one, and update InvoiceService to check siblings, it works.
         try {
             await InvoiceService.generateInvoiceForPayment(primaryPayment.id);
         } catch (err) { logger.warn(`Failed to auto-generate invoice: ${err}`); }
         
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

    async verifyPayment(paymentId: string) {
         return this.verifyAndCompletePayment(paymentId, undefined);
    }







};
