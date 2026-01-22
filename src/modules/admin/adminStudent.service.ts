import prisma from '../../config/prisma';
import { AdmissionStatus, CancellationStatus, RequestStatus, StudentDocumentStatus, AccommodationType, FeeStatus, Prisma, HostelType, PaymentMethod, PaymentStatus, PaymentMode, PaymentComponent, LedgerTransactionType } from '@prisma/client';
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
import { generateApplicationPDF } from '../../utils/applicationPdfGenerator';
import { getEnv } from '../../config/envValidator';
// @ts-ignore
import { StandardCheckoutClient, Env, StandardCheckoutPayRequest } from 'pg-sdk-node';

export const AdminStudentService = {
    async getAllApplications(query: any) {
        const { page = 1, limit = 10, search, status, quotaType, courseType } = query;
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
                            allottedCourse: {
                                select: {
                                    name: true
                                }
                            }
                        }
                    },
                    examDetails: true,
                    documents: true,
                    academicQualifications: true,
                    eligibleScholarshipRule: true,
                    scholarshipAllocation: { include: { rule: true } },
                    pref1Course: { select: { name: true } },
                    pref2Course: { select: { name: true } },
                    pref3Course: { select: { name: true } },
                    feeDemands: true,
                    studentScholarship: true
                }
            }),
            prisma.student.count({ where })
        ]);

        // Fetch requirements to check pending docs
        const requirements = await prisma.documentRequirement.findMany({ where: { isRequired: true } });
        const reqMap: Record<string, string[]> = {};
        requirements.forEach((r: any) => {
            if (!reqMap[r.degreeType]) reqMap[r.degreeType] = [];
            reqMap[r.degreeType].push(r.documentKey);
        });

        const enhancedStudents = await Promise.all(students.map(async (student: any) => {
            const uploadedKeys = student.documents.map((d: any) => d.documentKey);
            const requiredKeys = reqMap[student.degreeType || ''] || [];
            const pendingDocs = requiredKeys.filter(key => !uploadedKeys.includes(key));

            // Convert document URLs to presigned URLs
            const documentsWithPresignedUrls = await Promise.all(student.documents.map(async (doc: any) => ({
                ...doc,
                url: await convertToPresignedUrl(doc.url)
            })));

            // Convert profile photo URL
            const profilePhotoUrl = await convertToPresignedUrl(student.profilePhotoUrl);

            return {
                ...student,
                profilePhotoUrl,
                documents: documentsWithPresignedUrls,
                allottedCourseName: student.admissionDetails?.allottedCourse?.name,
                pref1CourseName: student.pref1Course?.name,
                pref2CourseName: student.pref2Course?.name,
                pref3CourseName: student.pref3Course?.name,
                documentsUploaded: student.documents.length,
                pendingDocs,
                isAllDocsUploaded: pendingDocs.length === 0,
                s3FolderKey: (student as any).documentFolderPath || `students/${student.id}/documents/`,
                feeDemands: student.feeDemands || []
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
            }
        });
    },

    async updateAdmissionDetails(data: any, adminId: string | undefined) {
        const { studentId, accommodationType, hostelType, hostelId, transportRouteId, paidAmount } = data;

        if (!studentId || !accommodationType) throw new AppError(MESSAGES.ERROR.STUDENT_ACCOMMODATION_REQUIRED, 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: true }
        });
        if (!student || !student.admissionDetails) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        const admission = student.admissionDetails;
        let totalFee = 125000;

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            // Release previous allocation
            if (admission.accommodationType === AccommodationType.HOSTEL && admission.hostelId) {
                if (accommodationType !== AccommodationType.HOSTEL || hostelId !== admission.hostelId) {
                    await tx.hostel.update({
                        where: { id: admission.hostelId },
                        data: { filled: { decrement: 1 }, updatedBy: adminId }
                    });
                }
            } else if (admission.accommodationType === AccommodationType.TRANSPORT && admission.transportRouteId) {
                if (accommodationType !== AccommodationType.TRANSPORT || transportRouteId !== admission.transportRouteId) {
                    await tx.transportRoute.update({
                        where: { id: admission.transportRouteId },
                        data: { filled: { decrement: 1 }, updatedBy: adminId }
                    });
                }
            }

            // Assign new allocation
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
                    // Fee calculation now depends on Room, not just Hostel. 
                    // If room is assigned, we should fetch it. For now, assuming 0 if no room specific logic exists here yet.
                    // totalFee += hostel.cost; // REMOVED
                } else {
                     // const hostel = await tx.hostel.findUnique({ where: { id: hostelId } });
                     // if (hostel) totalFee += hostel.cost; // REMOVED
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
                    totalFee += route.cost;
                } else {
                    const route = await tx.transportRoute.findUnique({ where: { id: transportRouteId } });
                    if (route) totalFee += route.cost;
                }
            }

            const currentPaid = (admission.paidFee ?? 0) + Number(paidAmount || 0);
            let feeStatus: FeeStatus = FeeStatus.PENDING;
            if (currentPaid >= totalFee) feeStatus = FeeStatus.FULL;
            else if (currentPaid > 0) feeStatus = FeeStatus.PARTIAL;

            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    accommodationType,
                    hostelType: accommodationType === AccommodationType.HOSTEL ? hostelType : null,
                    hostelId: accommodationType === AccommodationType.HOSTEL ? hostelId : null,
                    transportRouteId: accommodationType === AccommodationType.TRANSPORT ? transportRouteId : null,
                    totalFee,
                    paidFee: currentPaid,
                    feeStatus,
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

        return await prisma.studentScholarship.update({
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


    // INTERNAL HELPER: Executes the actual DB updates (Shared by Offline & Online-Success)
    async executeAdmissionUpdates(studentId: string, payload: any, paymentId: string, adminId: string, tx: Prisma.TransactionClient) {
        logger.info(`[executeAdmissionUpdates] Starting updates for student=${studentId} payment=${paymentId}`);
        const { scholarship, allocation, course } = payload;
        
        try {
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
                    transportRouteId: allocation.type === AccommodationType.TRANSPORT ? allocation.transportRouteId : null,
                    // updatedBy: adminId
                },
                create: {
                    studentId,
                    status: AdmissionStatus.ADMISSION_CONFIRMED,
                    allottedCourseId: course.allottedCourseId,
                    accommodationType: allocation.type,
                    hostelId: allocation.type === AccommodationType.HOSTEL ? allocation.hostelId : null,
                    hostelType: allocation.type === AccommodationType.HOSTEL ? allocation.hostelType : null,
                    transportRouteId: allocation.type === AccommodationType.TRANSPORT ? allocation.transportRouteId : null,
                    // createdBy: adminId
                }
            });

            // --- 4. Scholarship Update ---
            logger.debug(`[executeAdmissionUpdates] Updating Scholarship: ${scholarship.percentage}%`);
            await tx.studentScholarship.update({
                where: { studentId },
                data: {
                    scholarshipPercentage: scholarship.percentage,
                    updatedBy: adminId,
                    isEligible: 'YES'
                }
            });

            logger.info(`[executeAdmissionUpdates] Successfully completed all updates for student=${studentId}`);
        } catch (error) {
            logger.error(`[executeAdmissionUpdates] Failed to execute updates: ${error}`);
            throw error; // Re-throw to rollback transaction
        }
    },

    async finalizeAdmission(payload: any, adminId: string) {
        logger.info(`[finalizeAdmission] Request received for student=${payload.studentId} method=${payload.payment.method}`);
        const { studentId, payment, scholarship, allocation, course } = payload;
        
        // 1. Validation Checks
        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: true }
        });
        if (!student) {
            logger.warn(`[finalizeAdmission] Student not found: ${studentId}`);
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        // Verify Course
        const validCourse = await prisma.course.findUnique({ where: { id: course.allottedCourseId } });
        if (!validCourse) {
            logger.warn(`[finalizeAdmission] Invalid Course ID: ${course.allottedCourseId}`);
            throw new AppError("Invalid Course ID" , 400);
        }

        // Verify Fee Head if provided
        if (payment.feeHeadId) {
             const validFeeHead = await prisma.feeHead.findUnique({ where: { id: payment.feeHeadId } });
             if (!validFeeHead) {
                 logger.warn(`[finalizeAdmission] Invalid Fee Head ID: ${payment.feeHeadId}`);
                 throw new AppError("Invalid Fee Head ID", 400);
             }
        }

        // 2. Identify Flow
        const isOnline = !([PaymentMethod.CASH, PaymentMethod.CHEQUE, PaymentMethod.DEMAND_DRAFT].includes(payment.method));
        logger.info(`[finalizeAdmission] Flow Type detected: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);

        if (isOnline) {
             // === ONLINE FLOW (Initiate) ===
             try {
                 // 1. Create Pending Payment with Metadata
                 logger.debug(`[finalizeAdmission][Online] Creating PENDING payment record`);
                 
                 const feeComponent = PaymentComponent.TUITION; 

                 const newPayment = await prisma.payment.create({
                     data: {
                         studentId,
                         amount: payment.amount,
                         method: payment.method,
                         mode: PaymentMode.ONLINE,
                         status: PaymentStatus.PENDING, 
                         component: feeComponent,
                         feeHeadId: payment.feeHeadId,
                         collectedBy: adminId,
                         metadata: { 
                            scholarship, 
                            allocation, 
                            course,
                            feeComponent,
                            targetAction: 'FINALIZE_ADMISSION' 
                         }
                     }
                 });

                 const merchantTransactionId = newPayment.id.replace(/-/g, '');
                 const frontendUrl = process.env.FRONTEND_URL_ADMISSION || 'http://localhost:5173';

                 // --- BYPASS LOGIC FOR DEV/TESTING ---
                 if (process.env.BYPASS_PAYMENT === 'true') {
                     logger.info(`[finalizeAdmission][Online] Bypassing Payment Gateway for transaction ${newPayment.id}`);
                     
                     const bypassRedirectUrl = `${frontendUrl}/admin/verify-payment?paymentId=${newPayment.id}`;
                     return { 
                         success: true, 
                         type: 'ONLINE_INITIATED', 
                         message: "Payment Link Generated (BYPASS)", 
                         paymentId: newPayment.id,
                         redirectUrl: bypassRedirectUrl
                     };
                 }
                 
                 // 2. PhonePe Integration
                 const merchantId = process.env.PHONEPE_MERCHANT_ID || '';
                 const saltKey = process.env.PHONEPE_SALT_KEY || '';
                 const env = process.env.PHONEPE_ENV === 'PROD' ? Env.PRODUCTION : Env.SANDBOX;
                 const callbackUrl = process.env.PHONEPE_CALLBACK_URL || '';
                 
                 // Instantiate StandardCheckoutClient
                 // Salt Index usually implies '1' or extraction from env if needed. 
                 const saltIndex = parseInt(process.env.PHONEPE_SALT_INDEX || '1', 10);

                 const client = StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex as any, env);

                 const request = StandardCheckoutPayRequest.builder()
                     .merchantOrderId(merchantTransactionId)
                     .amount(Math.round(payment.amount * 100))
                     .redirectUrl(`${frontendUrl}/admin/verify-payment?paymentId=${newPayment.id}`)
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
             if (!payment.referenceNumber && payment.method !== PaymentMethod.CASH) {
                 throw new AppError("Reference Number is required for Non-Cash payments", 400);
             }

             return await prisma.$transaction(async (tx) => {
                 logger.info(`[finalizeAdmission][Offline] Starting transaction for student=${studentId}`);
                 
                 const feeComponent = PaymentComponent.TUITION;
                 
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
                        referenceNumber: payment.referenceNumber || `REF-${Date.now()}`,
                        instrumentDate: payment.date ? new Date(payment.date) : new Date(),
                        collectedBy: adminId,
                        metadata: { 
                            scholarship, 
                            allocation, 
                            course,
                            feeComponent,
                            notes: 'Offline Immediate Finalization' 
                         }
                    }
                });
                logger.debug(`[finalizeAdmission][Offline] Payment record created: ${newPayment.id}`);

                // 2. Execute Updates
                await this.executeAdmissionUpdates(studentId, payload, newPayment.id, adminId, tx);

                // 3. Ledger
                await tx.studentLedger.create({
                    data: {
                        studentId,
                        type: LedgerTransactionType.CREDIT,
                        amount: payment.amount,
                        description: `Admission Payment (${payment.method}) - ${feeComponent}`,
                        referenceId: newPayment.id,
                        referenceType: 'PAYMENT',
                        feeHeadId: payment.feeHeadId, // Added feeHeadId
                        createdBy: adminId
                    }
                });

                logger.info(`[finalizeAdmission][Offline] Transaction committed successfully.`);
                return { success: true, type: 'OFFLINE_COMPLETED', message: "Admission Finalized Successfully", paymentId: newPayment.id };
             });
        }
    },

    // New Method for Callbacks
    async verifyAndCompletePayment(paymentId: string, adminId: string | undefined) {
        logger.info(`[verifyAndCompletePayment] Verifying paymentId=${paymentId}`);
        // 1. Fetch Payment
        const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
        if (!payment) {
            logger.error(`[verifyAndCompletePayment] Payment not found: ${paymentId}`);
            throw new AppError("Payment not found", 404);
        }

        if (payment.status === PaymentStatus.SUCCESS) {
            logger.info(`[verifyAndCompletePayment] Payment ${paymentId} already processed.`);
            return { success: true, message: "Payment already successfully processed", status: PaymentStatus.SUCCESS };
        }

        // BYPASS CHECK
        if (process.env.BYPASS_PAYMENT === 'true') {
             logger.info(`[verifyAndCompletePayment] BYPASS_PAYMENT is true. Simulating success for ${paymentId}`);
             return await this._completeAdmissionTransaction(payment, adminId);
        }

        try {
             // Real PhonePe Check
             const merchantId = process.env.PHONEPE_MERCHANT_ID || '';
             const saltKey = process.env.PHONEPE_SALT_KEY || '';
             const env = process.env.PHONEPE_ENV === 'PROD' ? Env.PRODUCTION : Env.SANDBOX;
             const saltIndex = parseInt(process.env.PHONEPE_SALT_INDEX || '1', 10);
             
             const client = StandardCheckoutClient.getInstance(merchantId, saltKey, saltIndex as any, env);
             const merchantTransactionId = payment.id.replace(/-/g, '');
             
             logger.debug(`[verifyAndCompletePayment] Checking status with PhonePe for TxId=${merchantTransactionId}`);
             const response = await client.getOrderStatus(merchantTransactionId); 
             
             logger.info(`[verifyAndCompletePayment] PhonePe Response State: ${response.state}`);
             
             if (response.state === 'COMPLETED' || response.state === 'PAYMENT_SUCCESS') {
                 // Success
                 // Use existing providerTxId (which is MerchantTxId) or try to extract from response if typed properly
                 // For now, keeping existing ID is safe as it tracks the request.
                 return await this._completeAdmissionTransaction(payment, adminId);
             } else if (response.state === 'PENDING') {
                 logger.info(`[verifyAndCompletePayment] Payment is still pending.`);
                 return { success: false, message: "Payment is still pending", status: PaymentStatus.PENDING };
             } else {
                 logger.warn(`[verifyAndCompletePayment] Payment failed with state: ${response.state}`);
                 await prisma.payment.update({
                         where: { id: paymentId },
                         data: { status: PaymentStatus.FAILED }
                  });
                  return { success: false, message: "Payment Failed", status: PaymentStatus.FAILED };
             }

        } catch (error) {
            logger.error(`[verifyAndCompletePayment] Error verifying payment: ${error}`);
            throw new AppError("Payment Verification Failed", 500);
        }
    },

    // Refactored Transaction Helper to reuse in Bypass and Real
    async _completeAdmissionTransaction(payment: any, adminId: string | undefined, providerTxId?: string) {
        return await prisma.$transaction(async (tx) => {
             // Update Payment Status
             const meta = payment.metadata as any;
             await tx.payment.update({
                 where: { id: payment.id },
                 data: { 
                     status: PaymentStatus.SUCCESS,
                     providerTxId: providerTxId || payment.providerTxId
                 }
             });

             if (meta && meta.targetAction === 'FINALIZE_ADMISSION') {
                 // Call the shared update logic
                 await this.executeAdmissionUpdates(payment.studentId, meta, payment.id, adminId || 'SYSTEM', tx);
             }

             // Ledger Entry
             await tx.studentLedger.create({
                data: {
                    studentId: payment.studentId,
                    type: LedgerTransactionType.CREDIT,
                    amount: payment.amount,
                    description: `Admission Payment (ONLINE) - ${meta?.feeComponent || 'TUITION'}`,
                    referenceId: payment.id,
                    referenceType: 'PAYMENT',
                    feeHeadId: payment.feeHeadId, 
                    createdBy: adminId || 'SYSTEM'
                }
            });

             logger.info(`[verifyAndCompletePayment] Payment finalized successfully.`);
             return { success: true, message: "Payment Verified and Admission Finalized", status: PaymentStatus.SUCCESS };
         });
    }
};
