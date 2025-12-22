import express from "express";
import multer from "multer";
import { importAdmissionData, createImportMapping } from './dataImport.controller';
import { authenticate, authorize } from '../../middlewares/authMiddleware';
import { Role } from "@prisma/client";

const router = express.Router();

// Memory storage for immediate processing
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

router.post(
  "/import",
  authenticate,
  authorize([Role.SUPER_ADMIN, Role.ADMIN]),
  upload.single("file"),
  importAdmissionData
);

router.post(
  "/mapping",
  authenticate,
  authorize([Role.SUPER_ADMIN, Role.ADMIN]),
  createImportMapping
);

export default router;
