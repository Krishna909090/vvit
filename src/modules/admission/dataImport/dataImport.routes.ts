import express from "express";
import multer from "multer";
import { importAdmissionData, createImportMapping } from './dataImport.controller';
import { authenticate, authorize } from '../../../middleware/authMiddleware';
import { Role } from '../../../constants/roles';

const router = express.Router();

// Memory storage for immediate processing
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ═══════════════════════════════════════════════════════════
//  ADMISSION DATA IMPORT
// ═══════════════════════════════════════════════════════════

/**
 * @route   POST /import
 * @desc    Import admission data in bulk from an uploaded spreadsheet (CSV/Excel).
 *          Parses the file in-memory and upserts student admission records.
 * @access  Requires SUPER_ADMIN or ADMIN role.
 * @body    multipart/form-data — field name: `file` (max 10 MB).
 * @sideEffect Creates or updates student admission records in the database based on the file contents.
 * @returns {{ success: boolean, data: { imported: number, skipped: number, errors: ImportError[] } }}
 *          Summary of import results with per-row error details if any.
 */
router.post(
  "/import",
  authenticate,
  authorize([Role.SUPER_ADMIN, Role.ADMIN]),
  upload.single("file"),
  importAdmissionData
);

/**
 * @route   POST /mapping
 * @desc    Create or update a column mapping configuration that maps spreadsheet headers to database fields.
 *          Saved mappings are reused in subsequent /import calls to avoid re-mapping each time.
 * @access  Requires SUPER_ADMIN or ADMIN role.
 * @body    { mappingName, columns: { sourceHeader: targetField, ... } }
 * @returns {{ success: boolean, data: ImportMapping }} The created or updated mapping configuration.
 */
router.post(
  "/mapping",
  authenticate,
  authorize([Role.SUPER_ADMIN, Role.ADMIN]),
  createImportMapping
);

export default router;
