

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import logger from '../utils/logger';
import path from 'path';

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

const FILE_SIZE_LIMITS = {
    profilePhoto: 2 * 1024 * 1024,
    document: 5 * 1024 * 1024,
    hallTicket: 1 * 1024 * 1024,
    default: 5 * 1024 * 1024
};

const FILE_SIGNATURES: { [key: string]: number[][] } = {
    'image/jpeg': [
        [0xFF, 0xD8, 0xFF, 0xE0],
        [0xFF, 0xD8, 0xFF, 0xE1],
        [0xFF, 0xD8, 0xFF, 0xE2],
        [0xFF, 0xD8, 0xFF, 0xE3]
    ],
    'image/png': [
        [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    ],
    'image/webp': [
        [0x52, 0x49, 0x46, 0x46]
    ],
    'application/pdf': [
        [0x25, 0x50, 0x44, 0x46]
    ]
};

function validateFileSignature(buffer: Buffer, mimeType: string): boolean {
    const signatures = FILE_SIGNATURES[mimeType];
    if (!signatures) {
        return false;
    }

    const headerMatch = signatures.some(signature => {
        return signature.every((byte, index) => buffer[index] === byte);
    });

    if (!headerMatch) {
        return false;
    }

    if (mimeType === 'image/webp') {
        const webpMarker = [0x57, 0x45, 0x42, 0x50];
        const markerMatch = webpMarker.every((byte, index) => buffer[8 + index] === byte);
        if (!markerMatch) {
            return false;
        }
    }

    return true;
}

function sanitizeFilename(filename: string): string {

    let sanitized = filename.replace(/[\/\\]/g, '_').replace(/\0/g, '');

    sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, '_');

    const ext = path.extname(sanitized);
    const name = path.basename(sanitized, ext);
    const maxLength = 100;
    
    if (name.length > maxLength) {
        sanitized = name.substring(0, maxLength) + ext;
    }
    
    return sanitized;
}

export const validateFileUpload = (
    allowedTypes: string[] | 'images' | 'documents' | 'all' = 'all',
    maxSize: number = FILE_SIZE_LIMITS.default
) => {
    return (req: Request, res: Response, next: NextFunction) => {
        try {

            const file = req.file;
            
            if (!file) {

                return next();
            }

            const allowedMimeTypes = typeof allowedTypes === 'string' 
                ? ALLOWED_MIME_TYPES[allowedTypes] 
                : allowedTypes;

            if (file.size > maxSize) {
                logger.warn(`[FileUpload] File too large: ${file.size} bytes (max: ${maxSize}), user: ${req.user?.userId}`);
                throw new AppError(
                    `File size exceeds limit. Maximum allowed: ${Math.round(maxSize / 1024 / 1024)}MB`,
                    400
                );
            }

            if (!allowedMimeTypes.includes(file.mimetype)) {
                logger.warn(`[FileUpload] Invalid MIME type: ${file.mimetype}, user: ${req.user?.userId}`);
                throw new AppError(
                    `File type not allowed. Allowed types: ${allowedMimeTypes.join(', ')}`,
                    400
                );
            }

            if (!file.buffer) {
                logger.warn(`[FileUpload] File buffer unavailable (disk storage not supported), user: ${req.user?.userId}`);
                throw new AppError(
                    'File buffer is unavailable. Memory storage is required for file validation.',
                    400
                );
            }
            const isValidSignature = validateFileSignature(file.buffer, file.mimetype);
            if (!isValidSignature) {
                logger.warn(`[FileUpload] File signature mismatch for MIME type: ${file.mimetype}, user: ${req.user?.userId}`);
                throw new AppError(
                    'File content does not match declared file type. Possible file spoofing detected.',
                    400
                );
            }

            if (file.originalname) {
                file.originalname = sanitizeFilename(file.originalname);
            }

            const suspiciousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.js', '.jar', '.app'];
            const fileExt = path.extname(file.originalname).toLowerCase();
            if (suspiciousExtensions.includes(fileExt)) {
                logger.error(`[FileUpload] Suspicious file extension detected: ${fileExt}, user: ${req.user?.userId}`);
                throw new AppError('File type not allowed for security reasons', 400);
            }

            logger.info(`[FileUpload] File validated: ${file.originalname}, size: ${file.size}, type: ${file.mimetype}, user: ${req.user?.userId}`);

            next();
        } catch (error) {
            next(error);
        }
    };
};

export const validateProfilePhoto = validateFileUpload('images', FILE_SIZE_LIMITS.profilePhoto);
export const validateDocument = validateFileUpload('documents', FILE_SIZE_LIMITS.document);
export const validateHallTicket = validateFileUpload(['application/pdf', 'image/jpeg', 'image/png'], FILE_SIZE_LIMITS.hallTicket);

export function generateSecureFilename(originalFilename: string, userId?: string): string {
    const timestamp = Date.now();
    const randomString = require('crypto').randomBytes(8).toString('hex');
    const ext = path.extname(originalFilename);
    const userPrefix = userId ? `${userId.substring(0, 8)}_` : '';

    return `${userPrefix}${timestamp}_${randomString}${ext}`;
}

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
