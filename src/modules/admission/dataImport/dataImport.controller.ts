import { Request, Response, NextFunction } from "express";
import { processExcelImport } from './dataImport.service';
import { ImportType } from "@prisma/client";
import { AppError } from '../../../utils/AppError';
import { MESSAGES } from '../../../constants/messages';
import prisma from '../../../config/prisma';

export const importAdmissionData = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const file = req.file;
    const { mappingId, importType } = req.body;

    if (!file) {
      throw new AppError("No file uploaded", 400);
    }

    if (!mappingId || !importType) {
      throw new AppError("Mapping ID and Import Type are required", 400);
    }

    // Validate ImportType enum
    if (!Object.values(ImportType).includes(importType as ImportType)) {
       throw new AppError("Invalid Import Type", 400);
    }

    // Admins only (Middleware handles authentication, we just use req.user.id)
    // Assuming req.user is populated by auth middleware
    const adminId = (req as any).user?.id || "SYSTEM"; 

    const results = await processExcelImport(
      file.buffer,
      mappingId,
      importType as ImportType,
      adminId
    );

    res.status(200).json({
      success: true,
      message: "Data import processing completed",
      data: results,
    });
  } catch (error) {
    next(error);
  }
};

export const createImportMapping = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { name, type, mapping } = req.body;

    if (!name || !type || !mapping) {
      throw new AppError("Name, Type, and Mapping JSON are required", 400);
    }

    const newMapping = await prisma.dataImportMapping.create({
      data: {
        name,
        type, // Ensure this matches ImportType enum from frontend
        mapping,
        createdBy: (req as any).user?.userId || "SYSTEM",
      },
    });

    res.status(201).json({
      success: true,
      message: "Import mapping created successfully",
      data: newMapping,
    });
  } catch (error) {
    next(error);
  }
};
