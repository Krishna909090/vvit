import multer from 'multer';
import path from 'path';
import { S3Client } from '@aws-sdk/client-s3';
import multerS3 from 'multer-s3';
import { s3Client } from './awsConfig';

// S3 Storage Configuration
const storage = multerS3({
    s3: s3Client,
    bucket: process.env.AWS_BUCKET_NAME || 'vvitu-prod-files',
    metadata: function (req: any, file: any, cb: any) {
        cb(null, { fieldName: file.fieldname });
    },
    key: function (req: any, file: any, cb: any) {
        // Priority: Phone (New Student via Admin) -> UserID (Logged in) -> Param StudentID -> Public
        const rawStudentId = req.query.phone || req.user?.userId || req.params.studentId || 'public';
        const rawFolder = req.query.folder || 'documents';

        // Sanitize to prevent path traversal — allow only alphanumeric, hyphens, underscores
        const sanitize = (val: string) => val.replace(/[^a-zA-Z0-9_\-]/g, '');
        const studentId = sanitize(rawStudentId);
        const folder = sanitize(rawFolder);

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = `${folder}/${studentId}/${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`;
        cb(null, filename);
    }
});

// File filter to validate file types (extension + MIME type)
const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowedTypes: Record<string, string[]> = {
        '.pdf': ['application/pdf'],
        '.jpg': ['image/jpeg'],
        '.jpeg': ['image/jpeg'],
        '.png': ['image/png']
    };

    // Block double extensions (e.g., file.pdf.exe, shell.php.jpg)
    const dotCount = (file.originalname.match(/\./g) || []).length;
    if (dotCount > 1) {
        return cb(new Error('Double extensions are not allowed in file names.'));
    }

    const ext = path.extname(file.originalname).toLowerCase();
    const allowedMimes = allowedTypes[ext];

    if (allowedMimes && allowedMimes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Invalid file type. Allowed: PDF, JPG, JPEG, PNG with matching MIME type.`));
    }
};

// Multer configuration
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

export default upload;

