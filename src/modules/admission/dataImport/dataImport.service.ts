import ExcelJS from "exceljs";
import prisma from '../../../config/prisma';
import { AppError } from '../../../utils/AppError';
import logger from '../../../utils/logger';
import { ImportType, QuotaType, ApplicationMode, AdmissionStatus, AdmissionEntryType } from "@prisma/client";
import { Role } from '../../../constants/roles';

interface ExcelRow {
  [key: string]: any;
}

export const processExcelImport = async (
  fileBuffer: Buffer,
  mappingId: string,
  importType: ImportType,
  adminId: string
) => {

  const mappingRecord = await prisma.dataImportMapping.findUnique({
    where: { id: mappingId },
  });

  if (!mappingRecord) {
    throw new AppError("Invalid Data Import Mapping ID", 400);
  }

  if (mappingRecord.type !== importType) {
    throw new AppError("Mapping type does not match requested import type", 400);
  }

  const mapping = mappingRecord.mapping as Record<string, string>;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
      throw new AppError("Excel file has no worksheets", 400);
  }

  const rows: ExcelRow[] = [];
  const headers: string[] = [];
  
  worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {

          row.eachCell((cell, colNumber) => {
              headers[colNumber] = cell.value ? String(cell.value) : '';
          });
      } else {

          const rowData: ExcelRow = {};

          headers.forEach((header, index) => {
              if (index === 0) return;

              const cell = row.getCell(index);
              let cellValue = cell.value;

              if (cellValue && typeof cellValue === 'object') {
                  if ('text' in cellValue) {
                      cellValue = (cellValue as any).text; 
                  } else if ('result' in cellValue) {
                      cellValue = (cellValue as any).result;
                  }
              }

              if (header) {
                  rowData[header] = cellValue;
              }
          });

          if (Object.keys(rowData).length > 0) {
              rows.push(rowData);
          }
      }
  });

  if (rows.length === 0) {
    throw new AppError("Excel file is empty", 400);
  }

  const results = {
    total: rows.length,
    success: 0,
    failed: 0,
    errors: [] as any[],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowData: Record<string, any> = {};

    for (const [excelKey, dbField] of Object.entries(mapping)) {
      if (row[excelKey] !== undefined) {
        rowData[dbField] = row[excelKey];
      }
    }

    const phone = rowData["phone"] ? String(rowData["phone"]).trim() : null;
    const name = rowData["name"] || "Unknown Student";
    const email = rowData["email"] ? String(rowData["email"]).toLowerCase() : null;

    if (!phone) {
      results.failed++;
      results.errors.push({ row: i + 2, error: "Missing Phone Number" });
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {

        const activeYear = await tx.academicYear.findFirstOrThrow({
            where: { isActive: true, isDeleted: false }
        });

        let user = await tx.user.findUnique({ where: { phone } });
        if (!user) {
          user = await tx.user.create({
            data: {
              phone,
              email: email || undefined,
              name,
              role: Role.STUDENT,
              createdBy: adminId,
            },
          });
        }

        const applicationId = rowData["applicationId"] || `OFF-${phone}-${Date.now()}`;
        
        let quotaType: QuotaType = QuotaType.MANAGEMENT;
        let appMode: ApplicationMode = ApplicationMode.OFFLINE;

        if (importType === ImportType.CONVENOR_ADMISSION) {
           quotaType = QuotaType.CONVENOR;

        }

        const student = await tx.student.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            applicationId,
            name,
            phone,
            email: email || `temp-${phone}@vvitu.in`,

            fatherName: rowData["fatherName"] || "",
            motherName: rowData["motherName"] || "",
            gender: rowData["gender"] || "O",
            dob: rowData["dob"] ? new Date(rowData["dob"]) : new Date(),
            aadharNumber: rowData["aadharNumber"] ? String(rowData["aadharNumber"]) : "PENDING",
            category: rowData["category"] || "NA",
            country: rowData["country"] || "India",
            address: rowData["address"] || "NA",
            city: rowData["city"] || "NA",
            state: rowData["state"] || "NA",
            pincode: rowData["pincode"] ? String(rowData["pincode"]) : "000000",
            
            quotaType,
            applicationMode: appMode,
            isOffline: true,

            createdBy: adminId,
          },
          update: {

            name,
            fatherName: rowData["fatherName"] || undefined,
            admissionDetails: {

               upsert: {
                  create: {
                     status: AdmissionStatus.REGISTERED,
                     academicYear: { connect: { id: activeYear.id } },
                     entryType: AdmissionEntryType.REGULAR,
                     entryYearOfStudy: 1,
                     entryAcademicYear: { connect: { id: activeYear.id } },
                     feeCohortAcademicYear: { connect: { id: activeYear.id } },
                     batchAcademicYear: { connect: { id: activeYear.id } },
                     instituteCode: 'MGMT',
                  },
                  update: {}
               }
            }
          }
        });

        if (importType === ImportType.OFFLINE_ADMISSION) {

             const existingAdm = await tx.studentAdmission.findUnique({ where: { studentId: student.id }});
             if (!existingAdm) {
                await tx.studentAdmission.create({
                    data: {
                        studentId: student.id,
                        academicYearId: activeYear.id,
                        status: AdmissionStatus.REGISTERED,

                        entryType: AdmissionEntryType.REGULAR,
                        entryYearOfStudy: 1,
                        entryAcademicYearId: activeYear.id,
                        feeCohortAcademicYearId: activeYear.id,
                        batchAcademicYearId: activeYear.id,
                        instituteCode: 'MGMT',
                    }
                })
             }
        }

        if (importType === ImportType.CONVENOR_ADMISSION) {
            await tx.convenorAdmission.upsert({
                where: { studentId: student.id },
                create: {
                    studentId: student.id,
                    rank: rowData["rank"] ? String(rowData["rank"]) : null,
                    hallTicketNo: rowData["hallTicketNo"] ? String(rowData["hallTicketNo"]) : null,
                    allotmentOrder: rowData["allotmentOrder"],

                },
                update: {
                     rank: rowData["rank"] ? String(rowData["rank"]) : undefined,
                     hallTicketNo: rowData["hallTicketNo"] ? String(rowData["hallTicketNo"]) : undefined,
                }
            });

            await tx.studentAdmission.upsert({
                where: { studentId: student.id },
                create: {
                    studentId: student.id,
                    academicYearId: activeYear.id,
                    status: AdmissionStatus.SEAT_ALLOTTED,
                    entryType: AdmissionEntryType.REGULAR,
                    entryYearOfStudy: 1,
                    entryAcademicYearId: activeYear.id,
                    feeCohortAcademicYearId: activeYear.id,
                    batchAcademicYearId: activeYear.id,
                    instituteCode: 'MGMT',
                },
                update: {
                    status: AdmissionStatus.SEAT_ALLOTTED
                }
            });
        }

      });

      results.success++;
    } catch (error: any) {
      logger.error(`Import failed for row ${i + 2}: ${error.message}`);
      results.failed++;
      results.errors.push({ row: i + 2, error: error.message });
    }
  }

  return results;
};
