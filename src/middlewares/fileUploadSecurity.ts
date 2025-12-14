// middlewares/fileUploadSecurity.ts
// Comprehensive file upload security middleware

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import logger from '../utils/logger';
import path from 'path';

/**
 * Allowed MIME types for different document categories
 */
const ALLOWED_MIME_TYPES = {
    images: [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp'
    ],
    documents: [
        'application/pdf',
        'image/jpeg',
        'image/jpg',
        'image/png'
    ],
    all: [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'application/pdf'
    ]
};

/**
 * File size limits (in bytes)
 */
const FILE_SIZE_LIMITS = {
    profilePhoto: 2 * 1024 * 1024,      // 2MB for profile photos
    document: 5 * 1024 * 1024,          // 5MB for documents (PDFs, scanned docs)
    hallTicket: 1 * 1024 * 1024,        // 1MB for hall tickets
    default: 5 * 1024 * 1024            // 5MB default
};

/**
 * Magic numbers (file signatures) for validating actual file type
 * Prevents file extension spoofing
 */
const FILE_SIGNATURES: { [key: string]: number[][] } = {
    'image/jpeg': [
        [0xFF, 0xD8, 0xFF, 0xE0],  // JPEG JFIF
        [0xFF, 0xD8, 0xFF, 0xE1],  // JPEG EXIF
        [0xFF, 0xD8, 0xFF, 0xE2],  // JPEG
        [0xFF, 0xD8, 0xFF, 0xE3]   // JPEG
    ],
    'image/png': [
        [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]  // PNG
    ],
    'image/webp': [
        [0x52, 0x49, 0x46, 0x46]  // WEBP (RIFF)
    ],
    'application/pdf': [
        [0x25, 0x50, 0x44, 0x46]  // PDF (%PDF)
    ]
};

/**
 * Check if file signature matches the declared MIME type
 */
function validateFileSignature(buffer: Buffer, mimeType: string): boolean {
    const signatures = FILE_SIGNATURES[mimeType];
    if (!signatures) {
        return false;
    }

    return signatures.some(signature => {
        return signature.every((byte, index) => buffer[index] === byte);
    });
}

/**
 * Sanitize filename to prevent directory traversal and other attacks
 */
function sanitizeFilename(filename: string): string {
    // Remove path separators and null bytes
    let sanitized = filename.replace(/[\/\\]/g, '_').replace(/\0/g, '');
    
    // Remove any non-alphanumeric characters except dots, dashes, and underscores
    sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Limit filename length
    const ext = path.extname(sanitized);
    const name = path.basename(sanitized, ext);
    const maxLength = 100;
    
    if (name.length > maxLength) {
        sanitized = name.substring(0, maxLength) + ext;
    }
    
    return sanitized;
}

/**
 * Validate file upload security
 * @param allowedTypes - Array of allowed MIME types or category name
 * @param maxSize - Maximum file size in bytes
 */
export const validateFileUpload = (
    allowedTypes: string[] | 'images' | 'documents' | 'all' = 'all',
    maxSize: number = FILE_SIZE_LIMITS.default
) => {
    return (req: Request, res: Response, next: NextFunction) => {
        try {
            // Get file from request (assuming multer or similar middleware)
            const file = req.file;
            
            if (!file) {
                // No file uploaded - might be optional, let route handler decide
                return next();
            }

            // Get allowed MIME types
            const allowedMimeTypes = typeof allowedTypes === 'string' 
                ? ALLOWED_MIME_TYPES[allowedTypes] 
                : allowedTypes;

            // 1. Check file size
            if (file.size > maxSize) {
                logger.warn(`[FileUpload] File too large: ${file.size} bytes (max: ${maxSize}), user: ${req.user?.userId}`);
                throw new AppError(
                    `File size exceeds limit. Maximum allowed: ${Math.round(maxSize / 1024 / 1024)}MB`,
                    400
                );
            }

            // 2. Check MIME type
            if (!allowedMimeTypes.includes(file.mimetype)) {
                logger.warn(`[FileUpload] Invalid MIME type: ${file.mimetype}, user: ${req.user?.userId}`);
                throw new AppError(
                    `File type not allowed. Allowed types: ${allowedMimeTypes.join(', ')}`,
                    400
                );
            }

            // 3. Validate file signature (magic number check)
            if (file.buffer) {
                const isValidSignature = validateFileSignature(file.buffer, file.mimetype);
                if (!isValidSignature) {
                    logger.warn(`[FileUpload] File signature mismatch for MIME type: ${file.mimetype}, user: ${req.user?.userId}`);
                    throw new AppError(
                        'File content does not match declared file type. Possible file spoofing detected.',
                        400
                    );
                }
            }

            // 4. Sanitize filename
            if (file.originalname) {
                file.originalname = sanitizeFilename(file.originalname);
            }

            // 5. Check for suspicious file extensions
            const suspiciousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js', '.jar', '.app'];
            const fileExt = path.extname(file.originalname).toLowerCase();
            if (suspiciousExtensions.includes(fileExt)) {
                logger.error(`[FileUpload] Suspicious file extension detected: ${fileExt}, user: ${req.user?.userId}`);
                throw new AppError('File type not allowed for security reasons', 400);
            }

            // Log successful validation
            logger.info(`[FileUpload] File validated: ${file.originalname}, size: ${file.size}, type: ${file.mimetype}, user: ${req.user?.userId}`);

            next();
        } catch (error) {
            next(error);
        }
    };
};

/**
 * Specific validators for common use cases
 */
export const validateProfilePhoto = validateFileUpload('images', FILE_SIZE_LIMITS.profilePhoto);
export const validateDocument = validateFileUpload('documents', FILE_SIZE_LIMITS.document);
export const validateHallTicket = validateFileUpload(['application/pdf', 'image/jpeg', 'image/png'], FILE_SIZE_LIMITS.hallTicket);

/**
 * Generate secure random filename
 * Prevents filename collisions and makes files non-guessable
 */
export function generateSecureFilename(originalFilename: string, userId?: string): string {
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const ext = path.extname(originalFilename);
    const userPrefix = userId ? `${userId.substring(0, 8)}_` : '';
    
    return `${userPrefix}${timestamp}_${randomString}${ext}`;
}

/**
 * Validate file count in request
 */
export const validateFileCount = (maxFiles: number = 1) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const files = req.files;
        
        if (Array.isArray(files) && files.length > maxFiles) {
            logger.warn(`[FileUpload] Too many files: ${files.length} (max: ${maxFiles}), user: ${req.user?.userId}`);
            return next(new AppError(`Maximum ${maxFiles} file(s) allowed`, 400));
        }
        
        next();
    };
};
