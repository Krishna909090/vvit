import express from "express";
import multer from "multer";
import { importAdmissionData, previewImport, submitImportData } from './dataImport.controller';
import { authenticate, authorizePermission } from '../../../middleware/rbac.middleware';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Legacy — parses + inserts in one shot
router.post("/import",         authenticate, authorizePermission(['admission.create.all']), upload.single("file"), importAdmissionData);

// Step 1: upload file, get preview (valid/invalid counts + resolved rows)
router.post("/import/preview", authenticate, authorizePermission(['admission.create.all']), upload.single("file"), previewImport);

// Step 2: send validRows from preview response to actually insert
router.post("/import/submit",  authenticate, authorizePermission(['admission.create.all']), submitImportData);

export default router;
