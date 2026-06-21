import ExcelJS from "exceljs";
import Papa from "papaparse";
import prisma from '../../../config/prisma';
import { AppError } from '../../../utils/AppError';
import logger from '../../../utils/logger';

interface ExcelRow {
  [key: string]: any;
}

interface ParsedRow {
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
  omrId: number;
  entryYear: number;
}

// Fully resolved row ready to insert — returned from preview, accepted by submit
export interface ValidatedRow {
  hallTicketNo: string;
  rank: string | null;
  applicantName: string | null;
  gender: string | null;
  category: string | null;
  region: string | null;
  alottedCategory: string | null;
  phase: string | null;
  institutionCodeId: string | null;
  degree: string | null;
  courseId: string | null;
  omrId: number;
  entryYear: number;
  academicYearId: string;
  year: string;
}

const str = (v: any): string | null =>
  v != null && String(v).trim() !== '' ? String(v).trim() : null;

const toInt = (v: any): number | null =>
  v != null && !isNaN(Number(v)) ? Number(v) : null;

const readCsvRows = (fileBuffer: Buffer): ExcelRow[] => {
  const csv = fileBuffer.toString('utf8');
  const result = Papa.parse(csv, { header: true, skipEmptyLines: true }) as Papa.ParseResult<ExcelRow>;
  if (!result.data || result.data.length === 0) throw new AppError("CSV file is empty", 400);
  // Trim header keys in case CSV has spaces around column names
  return result.data.map((row: ExcelRow) => {
    const cleaned: ExcelRow = {};
    for (const key of Object.keys(row)) cleaned[key.trim()] = row[key];
    return cleaned;
  });
};

const readExcelRows = async (fileBuffer: Buffer): Promise<ExcelRow[]> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new AppError("Excel file has no worksheets", 400);

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
          if ('text' in cellValue) cellValue = (cellValue as any).text;
          else if ('result' in cellValue) cellValue = (cellValue as any).result;
        }
        if (header) rowData[header] = cellValue;
      });
      if (Object.keys(rowData).length > 0) rows.push(rowData);
    }
  });

  if (rows.length === 0) throw new AppError("Excel file is empty", 400);
  return rows;
};

const readFileRows = async (fileBuffer: Buffer, mimetype: string, originalname: string): Promise<ExcelRow[]> => {
  const isCsv = mimetype === 'text/csv' || originalname.toLowerCase().endsWith('.csv');
  return isCsv ? readCsvRows(fileBuffer) : readExcelRows(fileBuffer);
};

const ALLOWED_INST_CODES = new Set(['VVITU', 'VVITPU', 'VVIT']);
const VALID_GENDERS      = new Set(['MALE', 'FEMALE']);

export interface RowError {
  row: number;
  hallTicketNo?: string;
  errors: string[];
}

// Shared: parse + field-validate rows (no DB writes)
// Collects ALL validation errors per row — gender, entryYear, institution code, omrId, hallTicket
const parseRows = (rows: ExcelRow[]) => {
  const parsed: ParsedRow[]  = [];
  const fieldErrors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r            = rows[i];
    const rowNum       = i + 2;
    const hallTicketNo = str(r['HallTicket']);
    const rowErrors: string[] = [];

    if (!hallTicketNo) {
      fieldErrors.push({ row: rowNum, errors: ['Missing HallTicket'] });
      continue; // can't identify the row without a hall ticket
    }

    // Entry year — must always be 1 (1st year only)
    const entryYear = toInt(r['EntryYear'] ?? r['entryYear']);
    if (entryYear !== 1) {
      rowErrors.push(`Invalid EntryYear "${entryYear ?? 'missing'}": only 1st year (value 1) is allowed`);
    }

    // OmrId — must be present (DB existence checked later in resolveAndValidate)
    const omrId = toInt(r['OmrId'] ?? r['omrId'] ?? r['OMRId']);
    if (omrId == null) rowErrors.push('Missing OmrId');

    // Gender — must be MALE or FEMALE
    const genderRaw = str(r['Gender']);
    const gender    = genderRaw ? genderRaw.toUpperCase() : null;
    if (!gender || !VALID_GENDERS.has(gender)) {
      rowErrors.push(`Invalid Gender "${genderRaw ?? 'missing'}": must be MALE or FEMALE`);
    }

    // Institution code — must be VVITU, VVITPU, or VVIT
    const instCode = str(r['InstituteCode']);
    if (!instCode || !ALLOWED_INST_CODES.has(instCode.toUpperCase())) {
      rowErrors.push(`Invalid InstituteCode "${instCode ?? 'missing'}": must be one of VVITU, VVITPU, VVIT`);
    }

    if (rowErrors.length > 0) {
      fieldErrors.push({ row: rowNum, hallTicketNo, errors: rowErrors });
      continue;
    }

    parsed.push({
      rowNum,
      hallTicketNo,
      rank:            str(r['Rank']),
      applicantName:   str(r['ApplicantName']),
      gender:          gender!,
      category:        str(r['Category']),
      region:          str(r['Region']),
      alottedCategory: str(r['AlottedCategory']),
      phase:           str(r['Phase']),
      institutionCode: instCode!.toUpperCase(),
      degree:          str(r['Degree']),
      omrId:           omrId!,
      entryYear:       entryYear!,
    });
  }

  return { parsed, fieldErrors };
};

// Shared: resolve DB lookups + duplicate checks → returns valid resolved rows + all errors
const resolveAndValidate = async (parsed: ParsedRow[], fieldErrors: RowError[]) => {
  const dbErrors: RowError[] = [];
  const duplicates: string[] = [];

  // Duplicate check — DB + within file
  const existing = await prisma.convenorAdmission.findMany({
    where: { hallTicketNo: { in: parsed.map(r => r.hallTicketNo) } },
    select: { hallTicketNo: true },
  });
  const existingSet = new Set(existing.map(e => e.hallTicketNo));

  const seenInFile = new Set<string>();
  const deduped = parsed.filter(r => {
    if (existingSet.has(r.hallTicketNo)) {
      duplicates.push(r.hallTicketNo);
      dbErrors.push({ row: r.rowNum, hallTicketNo: r.hallTicketNo, errors: ['Duplicate HallTicket: already exists in DB'] });
      return false;
    }
    if (seenInFile.has(r.hallTicketNo)) {
      duplicates.push(r.hallTicketNo);
      dbErrors.push({ row: r.rowNum, hallTicketNo: r.hallTicketNo, errors: ['Duplicate HallTicket: repeated in this file'] });
      return false;
    }
    seenInFile.add(r.hallTicketNo);
    return true;
  });

  if (deduped.length === 0) {
    return { valid: [], errors: [...fieldErrors, ...dbErrors], duplicates };
  }

  const uniqueCodes  = [...new Set(deduped.map(r => r.institutionCode).filter(Boolean))] as string[];
  const uniqueOmrIds = [...new Set(deduped.map(r => r.omrId))];

  const [activeYear, instCodeRecords, courseByOmr] = await Promise.all([
    prisma.academicYear.findFirstOrThrow({ where: { isActive: true, isDeleted: false } }),
    uniqueCodes.length > 0
      ? prisma.institutionCode.findMany({
          where: { code: { in: uniqueCodes }, isDeleted: false },
          select: { id: true, code: true },
        })
      : Promise.resolve([] as { id: string; code: string }[]),
    uniqueOmrIds.length > 0
      ? prisma.course.findMany({
          where: { omrId: { in: uniqueOmrIds }, isDeleted: false },
          select: { id: true, omrId: true },
        })
      : Promise.resolve([] as { id: string; omrId: number | null }[]),
  ]);

  const codeToId      = new Map(instCodeRecords.map(r => [r.code, r.id]));
  const omrToCourseId = new Map(courseByOmr.map(c => [c.omrId as number, c.id]));
  const year1 = { academicYearId: activeYear.id, year: activeYear.code };

  const valid: ValidatedRow[] = [];
  for (const r of deduped) {
    const rowErrors: string[] = [];

    // OMR ID must exist in Course table
    if (!omrToCourseId.has(r.omrId)) {
      rowErrors.push(`OmrId ${r.omrId} not found in Course table`);
    }

    if (rowErrors.length > 0) {
      dbErrors.push({ row: r.rowNum, hallTicketNo: r.hallTicketNo, errors: rowErrors });
      continue;
    }

    valid.push({
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
      courseId:          omrToCourseId.get(r.omrId) ?? null,
      omrId:             r.omrId,
      entryYear:         r.entryYear,
      academicYearId:    year1.academicYearId,
      year:              year1.year,
    });
  }

  return { valid, errors: [...fieldErrors, ...dbErrors], duplicates };
};

// ── PREVIEW (array of JSON objects from request body) ─────────────────────────
export const previewJsonImport = async (rows: ExcelRow[]) => {
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError('Request body must be a non-empty array', 400);
  const { parsed, fieldErrors } = parseRows(rows);
  const { valid, errors, duplicates } = await resolveAndValidate(parsed, fieldErrors);

  return {
    total:      rows.length,
    valid:      valid.length,
    invalid:    errors.length,
    duplicates: duplicates.length,
    validRows:  valid,
    errors,
  };
};

// ── PREVIEW (file buffer) — kept for legacy callers ───────────────────────────
export const previewExcelImport = async (fileBuffer: Buffer, mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', originalname = 'file.xlsx') => {
  const rows = await readFileRows(fileBuffer, mimetype, originalname);
  const { parsed, fieldErrors } = parseRows(rows);
  const { valid, errors, duplicates } = await resolveAndValidate(parsed, fieldErrors);

  return {
    total:      rows.length,
    valid:      valid.length,
    invalid:    errors.length,
    duplicates: duplicates.length,
    validRows:  valid,
    errors,
  };
};

// ── SUBMIT — insert pre-validated rows ────────────────────────────────────────
export const submitImport = async (validRows: ValidatedRow[], adminId: string) => {
  if (!validRows || validRows.length === 0) throw new AppError('No valid rows to import', 400);

  // Final duplicate guard in case preview was stale
  const existing = await prisma.convenorAdmission.findMany({
    where: { hallTicketNo: { in: validRows.map(r => r.hallTicketNo) } },
    select: { hallTicketNo: true },
  });
  const existingSet = new Set(existing.map(e => e.hallTicketNo));

  const results = { total: validRows.length, success: 0, failed: 0, errors: [] as { hallTicketNo: string; error: string }[] };

  const toInsert = validRows.filter(r => {
    if (existingSet.has(r.hallTicketNo)) {
      results.failed++;
      results.errors.push({ hallTicketNo: r.hallTicketNo, error: 'Already exists (duplicate)' });
      return false;
    }
    return true;
  });

  if (toInsert.length === 0) return results;

  const buildRow = (r: ValidatedRow) => ({
    hallTicketNo:      r.hallTicketNo,
    rank:              r.rank,
    applicantName:     r.applicantName,
    gender:            r.gender,
    category:          r.category,
    region:            r.region,
    alottedCategory:   r.alottedCategory,
    phase:             r.phase,
    institutionCodeId: r.institutionCodeId,
    degree:            r.degree,
    courseId:          r.courseId,
    omrId:             r.omrId,
    entryYear:         r.entryYear,
    academicYearId:    r.academicYearId,
    year:              r.year,
    status:            'NOT_REPORTED',
    isDeleted:         false,
    createdBy:         adminId,
  });

  const CHUNK = 200;
  for (let c = 0; c < toInsert.length; c += CHUNK) {
    const chunk = toInsert.slice(c, c + CHUNK);
    try {
      await prisma.convenorAdmission.createMany({ data: chunk.map(buildRow), skipDuplicates: false });
      results.success += chunk.length;
    } catch {
      for (const r of chunk) {
        try {
          await prisma.convenorAdmission.create({ data: buildRow(r) });
          results.success++;
        } catch (rowErr: any) {
          logger.error(`Convener import submit row ${r.hallTicketNo}: ${rowErr.message}`);
          results.failed++;
          results.errors.push({ hallTicketNo: r.hallTicketNo, error: rowErr.message });
        }
      }
    }
  }

  return results;
};

// Legacy — kept for backward compatibility
export const processExcelImport = async (fileBuffer: Buffer, adminId: string, mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', originalname = 'file.xlsx') => {
  const rows = await readFileRows(fileBuffer, mimetype, originalname);
  const { parsed, fieldErrors } = parseRows(rows);
  const { valid, errors, duplicates } = await resolveAndValidate(parsed, fieldErrors);

  const results = {
    total:      rows.length,
    success:    0,
    failed:     errors.length,
    duplicates: duplicates,
    errors,
  };

  if (valid.length === 0) return results;

  const submitted = await submitImport(valid, adminId);
  results.success = submitted.success;
  results.failed += submitted.failed;
  results.errors.push(...submitted.errors.map(e => ({ row: 0, hallTicketNo: e.hallTicketNo, errors: [e.error] })));

  return results;
};
