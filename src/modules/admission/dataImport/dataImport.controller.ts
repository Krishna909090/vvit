import { Request, Response, NextFunction } from "express";
import { processExcelImport } from './dataImport.service';
import { ImportType } from "@prisma/client";
import { AppError } from '../../../utils/AppError';

export const importAdmissionData = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const file = req.file;
    const { importType } = req.body;

    if (!file) {
      throw new AppError("No file uploaded", 400);
    }

    if (!importType) {
      throw new AppError("Import Type is required", 400);
    }
    if (importType !== ImportType.CONVENOR_ADMISSION) {
      throw new AppError("This endpoint only supports CONVENOR_ADMISSION imports", 400);
    }

    const adminId = (req as any).user?.id || "SYSTEM";

    const results = await processExcelImport(file.buffer, adminId);

    res.status(200).json({
      success: true,
      message: "Data import processing completed",
      data: results,
    });
  } catch (error) {
    next(error);
  }
};
