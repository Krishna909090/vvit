import ExcelJS from "exceljs";
import prisma from '../../../config/prisma';
import { AppError } from '../../../utils/AppError';
import logger from '../../../utils/logger';
import { ImportType, QuotaType, ApplicationMode, AdmissionStatus, AdmissionEntryType, Prisma } from "@prisma/client";
import { Role } from '../../../constants/roles';
import { resolveInstitutionCodeId } from '../../../utils/institutionCodeCache';

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

  // ── CONVENOR ADMISSION: batch duplicate-check then bulk insert ──────────
  // Reads directly from the known Excel column names; no DataImportMapping needed.
  if (importType === ImportType.CONVENOR_ADMISSION) {
    const results = {
      total: rows.length,
      success: 0,
      failed: 0,
      duplicates: [] as string[],
      errors: [] as any[],
    };

    interface ConvenorRow {
      rowNum: number;
      hallTicketNo: string;
      rank: string | null;
      applicantName: string | null;
      gender: string | null;
      category: string | null;
      region: string | null;
      alottedCategory: string | null;
      phase: string | null;
      institutionCode: string | null;
      degree: string | null;
      course: string | null;
    }

    const str = (v: any) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);

    const parsed: ConvenorRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const hallTicketNo = str(r['HallTicket']);
      if (!hallTicketNo) {
        results.failed++;
        results.errors.push({ row: i + 2, error: 'Missing HallTicket' });
        continue;
      }
      parsed.push({
        rowNum:          i + 2,
        hallTicketNo,
        rank:            str(r['Rank']),
        applicantName:   str(r['ApplicantName']),
        gender:          str(r['Gender']),
        category:        str(r['Category']),
        region:          str(r['Region']),
        alottedCategory: str(r['AlottedCategory']),
        phase:           str(r['Phase']),
        institutionCode: str(r['InstituteCode']),
        degree:          str(r['Degree']),
        course:          str(r['AlottedCourse']),
      });
    }

    if (parsed.length === 0) return results;

    // Single query: find which hall tickets already exist
    const existing = await prisma.convenorAdmission.findMany({
      where: { hallTicketNo: { in: parsed.map(r => r.hallTicketNo) } },
      select: { hallTicketNo: true },
    });
    const existingSet = new Set(existing.map(e => e.hallTicketNo));

    const toInsert: ConvenorRow[] = [];
    for (const r of parsed) {
      if (existingSet.has(r.hallTicketNo)) {
        results.duplicates.push(r.hallTicketNo);
        results.failed++;
      } else {
        toInsert.push(r);
      }
    }

    if (toInsert.length > 0) {
      const activeYear = await prisma.academicYear.findFirstOrThrow({
        where: { isActive: true, isDeleted: false },
      });
      const prevYear = await prisma.academicYear.findFirst({
        where: { isDeleted: false, startDate: { lt: activeYear.startDate } },
        orderBy: { startDate: 'desc' },
      });
      const targetYearId = prevYear?.id ?? activeYear.id;

      // Build a code→id map for all institution codes referenced in this upload
      const uniqueCodes = [...new Set(toInsert.map(r => r.institutionCode).filter(Boolean))] as string[];
      const instCodeRecords = uniqueCodes.length > 0
        ? await prisma.institutionCode.findMany({
            where: { code: { in: uniqueCodes }, isDeleted: false },
            select: { id: true, code: true },
          })
        : [];
      const codeToId = new Map(instCodeRecords.map(r => [r.code, r.id]));

      const CHUNK = 200;
      for (let c = 0; c < toInsert.length; c += CHUNK) {
        const chunk = toInsert.slice(c, c + CHUNK);
        const insertData = chunk.map(r => ({
          hallTicketNo:      r.hallTicketNo,
          rank:              r.rank,
          applicantName:     r.applicantName,
          gender:            r.gender,
          category:          r.category,
          region:            r.region,
          alottedCategory:   r.alottedCategory,
          phase:             r.phase,
          institutionCodeId: r.institutionCode ? (codeToId.get(r.institutionCode) ?? null) : null,
          degree:            r.degree,
          course:            r.course,
          academicYearId:    targetYearId,
          isDeleted:         false,
          createdBy:         adminId,
        }));

        try {
          await prisma.convenorAdmission.createMany({ data: insertData, skipDuplicates: false });
          results.success += chunk.length;
        } catch (error: any) {
          // Fallback: row-by-row to isolate failures
          for (const r of chunk) {
            try {
              await prisma.convenorAdmission.create({
                data: {
                  hallTicketNo:      r.hallTicketNo,
                  rank:              r.rank,
                  applicantName:     r.applicantName,
                  gender:            r.gender,
                  category:          r.category,
                  region:            r.region,
                  alottedCategory:   r.alottedCategory,
                  phase:             r.phase,
                  institutionCodeId: r.institutionCode ? (codeToId.get(r.institutionCode) ?? null) : null,
                  degree:            r.degree,
                  course:            r.course,
                  academicYearId:    targetYearId,
                  isDeleted:         false,
                  createdBy:         adminId,
                },
              });
              results.success++;
            } catch (rowErr: any) {
              logger.error(`Convener import row ${r.rowNum}: ${rowErr.message}`);
              results.failed++;
              results.errors.push({ row: r.rowNum, hallTicketNo: r.hallTicketNo, error: rowErr.message });
            }
          }
        }
      }
    }

    return results;
  }

  // ── OFFLINE ADMISSION ────────────────────────────────────────────────────
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

    try {
      {
        // OFFLINE_ADMISSION — create User + Student + StudentAdmission
        const phone = rowData["phone"] ? String(rowData["phone"]).trim() : null;
        const name = rowData["name"] || "Unknown Student";
        const email = rowData["email"] ? String(rowData["email"]).toLowerCase() : null;

        if (!phone) {
          results.failed++;
          results.errors.push({ row: i + 2, error: "Missing Phone Number" });
          continue;
        }

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
              quotaType: QuotaType.MANAGEMENT,
              applicationMode: ApplicationMode.OFFLINE,
              isOffline: true,
              createdBy: adminId,
            },
            update: {
              name,
              fatherName: rowData["fatherName"] || undefined,
            },
          });

          const existingAdm = await tx.studentAdmission.findUnique({ where: { studentId: student.id } });
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
                institutionCodeId: await resolveInstitutionCodeId('MGMT'),
              },
            });
          }
        });
      }

      results.success++;
    } catch (error: any) {
      logger.error(`Import failed for row ${i + 2}: ${error.message}`);
      results.failed++;
      results.errors.push({ row: i + 2, error: error.message });
    }
  }

  return results;
};
