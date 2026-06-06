import express from "express";
import multer from "multer";
import { importAdmissionData, createImportMapping } from './dataImport.controller';
import { authenticate } from '../../../middleware/rbac.middleware';
import { authorize } from '../../../middleware/authMiddleware';
import { Role } from '../../../constants/roles';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
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
