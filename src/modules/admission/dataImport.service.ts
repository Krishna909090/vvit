import ExcelJS from "exceljs";
import prisma from '../../config/prisma';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { ImportType, QuotaType, ApplicationMode, AdmissionStatus } from "@prisma/client";
import { Role } from '../../constants/roles';

interface ExcelRow {
  [key: string]: any;
}

export const processExcelImport = async (
  fileBuffer: Buffer,
  mappingId: string,
  importType: ImportType,
  adminId: string
) => {
  // 1. Load Mapping
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

  // 2. Parse Excel using ExcelJS
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);
  
  // Use the first worksheet
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
      throw new AppError("Excel file has no worksheets", 400);
  }

  // Convert Sheet to JSON manually
  const rows: ExcelRow[] = [];
  const headers: string[] = [];
  
  worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) {
          // Capture Headers
          row.eachCell((cell, colNumber) => {
              headers[colNumber] = cell.value ? String(cell.value) : '';
          });
      } else {
          // Capture Data
          const rowData: ExcelRow = {};
          // Iterate over headers to ensure we get all cols even if cell is empty
          headers.forEach((header, index) => {
              if (index === 0) return; // headers array index matches colNumber (1-based usually, but here array is 0-based with holes if sparse?)
              // exceljs colNumber is 1-based. headers array will have index 1 for col 1.
              
              const cell = row.getCell(index);
              let cellValue = cell.value;
              
              // Handle special cell types (hyperlink, formula result)
              if (cellValue && typeof cellValue === 'object') {
                  if ('text' in cellValue) {
                      cellValue = (cellValue as any).text; 
                  } else if ('result' in cellValue) {
                      cellValue = (cellValue as any).result;
                  }
              }
              
              // Normalize date if needed? For now keep raw.
              
              if (header) {
                  rowData[header] = cellValue;
              }
          });
          // Check if row is not empty
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

  // 3. Process Rows
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowData: Record<string, any> = {};

    // Apply Mapping: Excel Header -> DB Field
    for (const [excelKey, dbField] of Object.entries(mapping)) {
      if (row[excelKey] !== undefined) {
        rowData[dbField] = row[excelKey];
      }
    }

    // Basic Validation: Phone (Mandatory for User user)
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
        // A. Create/Find User
        let user = await tx.user.findUnique({ where: { phone } });
        if (!user) {
          user = await tx.user.create({
            data: {
              phone,
              email: email || undefined, // Email might be optional or missing in OMR
              name,
              role: Role.STUDENT,
              createdBy: adminId,
            },
          });
        }

        // B. Prepare Student Data 
        // We need an applicationId. If not in excel, generate one.
        const applicationId = rowData["applicationId"] || `OFF-${phone}-${Date.now()}`;
        
        let quotaType: QuotaType = QuotaType.MANAGEMENT;
        let appMode: ApplicationMode = ApplicationMode.OFFLINE;

        if (importType === ImportType.CONVENOR_ADMISSION) {
           quotaType = QuotaType.CONVENOR;
           // Convenors are technically "Offline" source (Excel) but separate flow
        }

        // C. Create/Update Student
        // Using upsert to update if exists
        const student = await tx.student.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            applicationId,
            name,
            phone,
            email: email || `temp-${phone}@vvitu.in`, // Fallback email needed for unique constraint
            
            // Map other fields from rowData
            fatherName: rowData["fatherName"] || "",
            motherName: rowData["motherName"] || "",
            gender: rowData["gender"] || "O",
            dob: rowData["dob"] ? new Date(rowData["dob"]) : new Date(), // Careful with date parsing
            aadharNumber: rowData["aadharNumber"] ? String(rowData["aadharNumber"]) : "PENDING",
            category: rowData["category"] || "NA",
            country: rowData["country"] || "India",
            address: rowData["address"] || "NA",
            city: rowData["city"] || "NA",
            state: rowData["state"] || "NA",
            pincode: rowData["pincode"] ? String(rowData["pincode"]) : "000000",
            
            quotaType,
            applicationMode: appMode,
            isOffline: true, // For backward compat

            createdBy: adminId,
          },
          update: {
            // Update fields if re-uploading? 
            // For now, let's assume we update basics if provided
            name,
            fatherName: rowData["fatherName"] || undefined,
            admissionDetails: {
               // Ensure admission details exist
               upsert: {
                  create: { status: AdmissionStatus.REGISTERED },
                  update: {}
               }
            }
          }
        });

        // D. Create Admission Details if new
        if (importType === ImportType.OFFLINE_ADMISSION) {
             // For offline management, they start as Registered (ready for Exam)
             // Check if admissionDetails exists (handled in upsert above roughly, but let's be explicit)
             const existingAdm = await tx.studentAdmission.findUnique({ where: { studentId: student.id }});
             if (!existingAdm) {
                await tx.studentAdmission.create({
                    data: {
                        studentId: student.id,
                        status: AdmissionStatus.REGISTERED
                    }
                })
             }
        }

        // E. Convenor Specifics
        if (importType === ImportType.CONVENOR_ADMISSION) {
            await tx.convenorAdmission.upsert({
                where: { studentId: student.id },
                create: {
                    studentId: student.id,
                    rank: rowData["rank"] ? String(rowData["rank"]) : null,
                    hallTicketNo: rowData["hallTicketNo"] ? String(rowData["hallTicketNo"]) : null,
                    allotmentOrder: rowData["allotmentOrder"],
                    // ... map other convenor fields
                },
                update: {
                     rank: rowData["rank"] ? String(rowData["rank"]) : undefined,
                     hallTicketNo: rowData["hallTicketNo"] ? String(rowData["hallTicketNo"]) : undefined,
                }
            });
            
            // Convenors might skip exam and go to Seat Allotted?
            // "Conveyor quota students already seat allotted by the EMCET council"
            // So we update AdmissionStatus to SEAT_ALLOTTED
            await tx.studentAdmission.upsert({
                where: { studentId: student.id },
                create: {
                    studentId: student.id,
                    status: AdmissionStatus.SEAT_ALLOTTED
                },
                update: {
                    status: AdmissionStatus.SEAT_ALLOTTED
                }
            });
        }

      }); // End Transaction

      results.success++;
    } catch (error: any) {
      logger.error(`Import failed for row ${i + 2}: ${error.message}`);
      results.failed++;
      results.errors.push({ row: i + 2, error: error.message });
    }
  }

  return results;
};
