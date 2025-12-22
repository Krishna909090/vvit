import prisma from '../../config/prisma';
import { AdmissionStatus, CancellationStatus, Role, RequestStatus, StudentDocumentStatus, AccommodationType, FeeStatus, Prisma, HostelType } from '@prisma/client';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';
import { MESSAGES } from '../../constants/messages';
import Papa from 'papaparse';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import axios from 'axios';
import { registerStudent } from '../student/student.service';

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
            where.courseType = courseType;
        }

        const [students, total] = await prisma.$transaction([
            prisma.student.findMany({
                where,
                skip,
                take: Number(limit),
                orderBy: { createdAt: 'desc' },
                include: {
                    admissionDetails: true,
                    examDetails: true,
                    documents: true,
                }
            }),
            prisma.student.count({ where })
        ]);

        // Fetch requirements to check pending docs
        const requirements = await prisma.documentRequirement.findMany({ where: { isRequired: true } });
        const reqMap: Record<string, string[]> = {};
        requirements.forEach((r: any) => {
            if (!reqMap[r.courseType]) reqMap[r.courseType] = [];
            reqMap[r.courseType].push(r.documentKey);
        });

        const enhancedStudents = students.map((student: any) => {
            const uploadedKeys = student.documents.map((d: any) => d.documentKey);
            const requiredKeys = reqMap[student.courseType || ''] || [];
            const pendingDocs = requiredKeys.filter(key => !uploadedKeys.includes(key));

            return {
                ...student,
                documentsUploaded: student.documents.length,
                pendingDocs,
                isAllDocsUploaded: pendingDocs.length === 0,
                s3FolderKey: (student as any).documentFolderPath || `students/${student.id}/documents/`
            };
        });

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
                    courseType: studentData.course_type || 'B.Tech',
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

                if (request.student.admissionDetails?.allottedSpecialization) {
                    await tx.specialization.update({
                        where: { code: request.student.admissionDetails.allottedSpecialization },
                        data: { filledSeats: { decrement: 1 } }
                    });
                }
            }
        });

        return { status };
    },

    async verifyAndAllotSeat(studentId: string, approved: boolean, allottedSpecialization: string, adminId: string | undefined) {
        if (!studentId) throw new AppError(MESSAGES.ERROR.STUDENT_ID_REQUIRED, 400);
        if (!approved) {
            return { success: false, message: MESSAGES.ERROR.DOCUMENTS_REJECTED };
        }

        if (!allottedSpecialization) throw new AppError(MESSAGES.ERROR.ALLOTTED_COURSE_REQUIRED, 400);

        const student = await prisma.student.findUnique({ where: { id: studentId } });
        if (!student) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NOT_FOUND, 404);
        }

        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.studentAdmission.update({
                where: { studentId },
                data: {
                    status: AdmissionStatus.SEAT_ALLOTTED,
                    allottedSpecialization: allottedSpecialization
                }
            });

            const specialization = await tx.specialization.findUnique({ where: { code: allottedSpecialization } });
            if (specialization) {
                await tx.specialization.update({
                    where: { code: allottedSpecialization },
                    data: { filledSeats: { increment: 1 } }
                });
            }
            await tx.seatAllocation.create({
                data: {
                    studentId,
                    newCourse: allottedSpecialization,
                    allocatedBy: adminId || 'ADMIN',
                    notes: 'Initial Seat Allotment'
                }
            });
        });

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
            const requirements = await prisma.documentRequirement.findMany({
                where: { courseType: student.courseType || '', isRequired: true }
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

        return updatedDoc;
    },

    async requestCourseChange(studentId: string, newSpecialization: string, reason: string) {
        if (!studentId || !newSpecialization || !reason) throw new AppError(MESSAGES.ERROR.STUDENT_NEWCOURSE_REASON_REQUIRED, 400);

        const student = await prisma.student.findUnique({
            where: { id: studentId },
            include: { admissionDetails: true }
        });

        if (!student || !student.admissionDetails?.allottedSpecialization) {
            throw new AppError(MESSAGES.ERROR.STUDENT_NO_ALLOTTED_COURSE, 400);
        }

        const oldSpecialization = student.admissionDetails.allottedSpecialization;

        return await prisma.courseChangeRequest.create({
            data: {
                studentId,
                fromCourse: oldSpecialization,
                toCourse: newSpecialization,
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
                    data: { allottedSpecialization: request.toCourse }
                });

                await tx.specialization.update({
                    where: { code: request.fromCourse },
                    data: { filledSeats: { decrement: 1 } }
                });
                await tx.specialization.update({
                    where: { code: request.toCourse },
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

                    if (hostel.filled >= hostel.capacity) throw new AppError(MESSAGES.ERROR.HOSTEL_FULL, 400);

                    await tx.hostel.update({
                        where: { id: hostelId },
                        data: { filled: { increment: 1 }, updatedBy: adminId }
                    });
                    totalFee += hostel.cost;
                } else {
                    const hostel = await tx.hostel.findUnique({ where: { id: hostelId } });
                    if (hostel) totalFee += hostel.cost;
                }
            }
            else if (accommodationType === AccommodationType.TRANSPORT) {
                if (!transportRouteId) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_ID_REQUIRED, 400);

                if (transportRouteId !== admission.transportRouteId) {
                    const route = await tx.transportRoute.findUnique({ where: { id: transportRouteId } });
                    if (!route) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_NOT_FOUND, 404);

                    if (route.filled >= route.capacity) throw new AppError(MESSAGES.ERROR.TRANSPORT_ROUTE_FULL, 400);

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

            const currentPaid = admission.paidFee + Number(paidAmount || 0);
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
    
        return {
            profilePhotoUrl: student.profilePhotoUrl,
            hallTicketUrl: student.examDetails?.hallTicketUrl,
            ...student.documents.reduce((acc: any, doc: any) => {
                acc[doc.documentKey] = doc.url;
                return acc;
            }, {})
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
    
            archive.on('error', (err) => {
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
                        } catch (err) {
                            logger.error(`Failed to download ${doc.name} from ${doc.url}`);
                        }
                    }
                }
                await archive.finalize();
            })();
        });
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
    }
};
