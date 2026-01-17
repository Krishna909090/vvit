import express from "express";
import multer from "multer";
import { importAdmissionData, createImportMapping } from './dataImport.controller';
import { authenticate, authorizePermission } from '../../middleware/rbac.middleware';

const router = express.Router();

// Memory storage for immediate processing
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

router.post(
  "/import",
  authenticate,
  authorizePermission('admission.create'),
  upload.single("file"),
  importAdmissionData
);

router.post(
  "/mapping",
  authenticate,
  authorizePermission('admission.create'),
  createImportMapping
);

export default router;
