import ExcelJS from "exceljs";
import prisma from '../../../config/prisma';
import { AppError } from '../../../utils/AppError';
import logger from '../../../utils/logger';

interface ExcelRow {
  [key: string]: any;
}

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
  omrId: number | null;
  entryYear: number | null;
}

const str = (v: any): string | null =>
  v != null && String(v).trim() !== '' ? String(v).trim() : null;

const toInt = (v: any): number | null =>
  v != null && !isNaN(Number(v)) ? Number(v) : null;

export const processExcelImport = async (fileBuffer: Buffer, adminId: string) => {
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

  const results = {
    total: rows.length,
    success: 0,
    failed: 0,
    duplicates: [] as string[],
    errors: [] as { row: number; hallTicketNo?: string; error: string }[],
  };

  // Parse all rows, collect valid ones
  const parsed: ConvenorRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const hallTicketNo = str(r['HallTicket']);
    if (!hallTicketNo) {
      results.failed++;
      results.errors.push({ row: i + 2, error: 'Missing HallTicket' });
      continue;
    }
    const entryYear = toInt(r['EntryYear'] ?? r['entryYear']);
    if (entryYear !== 1 && entryYear !== 2) {
      results.failed++;
      results.errors.push({ row: i + 2, hallTicketNo, error: `Invalid EntryYear "${entryYear ?? 'missing'}": must be 1 or 2` });
      continue;
    }

    const omrId = toInt(r['OmrId'] ?? r['omrId'] ?? r['OMRId']);
    if (omrId == null) {
      results.failed++;
      results.errors.push({ row: i + 2, hallTicketNo, error: 'Missing OmrId' });
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
      omrId,
      entryYear,
    });
  }

  if (parsed.length === 0) return results;

  // Pre-flight: single query to find all existing hall tickets
  const existing = await prisma.convenorAdmission.findMany({
    where: { hallTicketNo: { in: parsed.map(r => r.hallTicketNo) } },
    select: { hallTicketNo: true },
  });
  const existingSet = new Set(existing.map(e => e.hallTicketNo));

  const seenInFile = new Set<string>();
  const toInsert = parsed.filter(r => {
    if (existingSet.has(r.hallTicketNo) || seenInFile.has(r.hallTicketNo)) {
      results.duplicates.push(r.hallTicketNo);
      results.failed++;
      return false;
    }
    seenInFile.add(r.hallTicketNo);
    return true;
  });

  if (toInsert.length === 0) return results;

  // Collect unique lookup keys upfront
  const uniqueCodes   = [...new Set(toInsert.map(r => r.institutionCode).filter(Boolean))] as string[];
  const uniqueOmrIds  = [...new Set(toInsert.map(r => r.omrId).filter((v): v is number => v !== null))];

  // Parallel: active year + institution codes + OMR→course (none depend on each other)
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

  // prevYear depends on activeYear.startDate — one more query
  const prevYear = await prisma.academicYear.findFirst({
    where: { isDeleted: false, startDate: { lt: activeYear.startDate } },
    orderBy: { startDate: 'desc' },
  });

  const codeToId      = new Map(instCodeRecords.map(r => [r.code, r.id]));
  const omrToCourseId = new Map(courseByOmr.map(c => [c.omrId as number, c.id]));

  // Validate omrId exists in DB — reject rows with unknown omrIds
  const validToInsert: ConvenorRow[] = [];
  for (const r of toInsert) {
    if (!omrToCourseId.has(r.omrId!)) {
      results.failed++;
      results.errors.push({ row: r.rowNum, hallTicketNo: r.hallTicketNo, error: `OmrId ${r.omrId} not found in Course table` });
    } else {
      validToInsert.push(r);
    }
  }

  if (validToInsert.length === 0) return results;

  // Precompute both year options once instead of resolving per row
  const year1 = { academicYearId: activeYear.id, year: activeYear.code };
  const year2 = prevYear ? { academicYearId: prevYear.id, year: prevYear.code } : year1;

  const buildRow = (r: ConvenorRow) => {
    const { academicYearId, year } = r.entryYear === 2 ? year2 : year1;
    return {
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
      courseId:          r.omrId != null ? (omrToCourseId.get(r.omrId) ?? null) : null,
      omrId:             r.omrId,
      entryYear:         r.entryYear,
      academicYearId,
      year,
      status:            'NOT_REPORTED',
      isDeleted:         false,
      createdBy:         adminId,
    };
  };

  const CHUNK = 200;
  for (let c = 0; c < validToInsert.length; c += CHUNK) {
    const chunk = validToInsert.slice(c, c + CHUNK);
    try {
      await prisma.convenorAdmission.createMany({ data: chunk.map(buildRow), skipDuplicates: false });
      results.success += chunk.length;
    } catch {
      // Fallback: row-by-row to isolate which specific rows failed
      for (const r of chunk) {
        try {
          await prisma.convenorAdmission.create({ data: buildRow(r) });
          results.success++;
        } catch (rowErr: any) {
          logger.error(`Convener import row ${r.rowNum}: ${rowErr.message}`);
          results.failed++;
          results.errors.push({ row: r.rowNum, hallTicketNo: r.hallTicketNo, error: rowErr.message });
        }
      }
    }
  }

  return results;
};
