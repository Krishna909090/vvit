import { Request, Response, NextFunction } from "express";
import { processExcelImport, previewJsonImport, submitImport } from './dataImport.service';
import { ImportType } from "@prisma/client";
import { AppError } from '../../../utils/AppError';
import { z } from 'zod';

const validatedRowSchema = z.object({
  hallTicketNo:      z.string().min(1).max(50),
  rank:              z.string().max(50).nullable(),
  applicantName:     z.string().max(200).nullable(),
  gender:            z.enum(['MALE', 'FEMALE']).nullable(),
  category:          z.string().max(50).nullable(),
  region:            z.string().max(50).nullable(),
  alottedCategory:   z.string().max(50).nullable(),
  phase:             z.string().max(50).nullable(),
  institutionCodeId: z.string().uuid().nullable(),
  degree:            z.string().max(100).nullable(),
  courseId:          z.string().uuid().nullable(),
  omrId:             z.number().int().positive(),
  entryYear:         z.literal(1),
  academicYearId:    z.string().uuid(),
  year:              z.string().max(20),
});

const submitBodySchema = z.object({
  validRows: z.array(validatedRowSchema).min(1, 'validRows must not be empty'),
});

export const importAdmissionData = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const file = req.file;
    const { importType } = req.body;

    if (!file) throw new AppError("No file uploaded", 400);
    if (!importType) throw new AppError("Import Type is required", 400);
    if (importType !== ImportType.CONVENOR_ADMISSION)
      throw new AppError("This endpoint only supports CONVENOR_ADMISSION imports", 400);

    const adminId = (req as any).user?.id || "SYSTEM";
    const results = await processExcelImport(file.buffer, adminId, file.mimetype, file.originalname);

    res.status(200).json({ success: true, message: "Data import processing completed", data: results });
  } catch (error) {
    next(error);
  }
};

export const previewImport = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      throw new AppError("Request body must be a non-empty array of row objects", 400);

    const results = await previewJsonImport(rows);

    res.status(200).json({
      success: true,
      message: "Preview complete",
      data: results,
    });
  } catch (error) {
    next(error);
  }
};

export const submitImportData = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const parsed = submitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(`Invalid submit payload: ${parsed.error.issues.map(i => i.message).join(', ')}`, 400);
    }

    const adminId = (req as any).user?.id || "SYSTEM";
    const results = await submitImport(parsed.data.validRows, adminId);

    res.status(200).json({
      success: true,
      message: `Import complete: ${results.success} inserted, ${results.failed} failed`,
      data: results,
    });
  } catch (error) {
    next(error);
  }
};
