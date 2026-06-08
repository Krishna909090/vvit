

import crypto from 'crypto';

const ENCRYPTION_KEY = process.env.QR_ENCRYPTION_KEY!;
const ALGORITHM = 'aes-256-cbc';

const getKey = (): Buffer => {
    return crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
};

export const encrypt = (text: string): string => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    return `${iv.toString('base64')}:${encrypted}`;
};

export const decrypt = (encryptedText: string): string => {
    try {
        const parts = encryptedText.split(':');
        if (parts.length !== 2) {
            throw new Error('Invalid encrypted format');
        }
        
        const iv = Buffer.from(parts[0], 'base64');
        const encryptedData = parts[1];
        
        const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
        
        let decrypted = decipher.update(encryptedData, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        throw new Error('Decryption failed: Invalid or corrupted data');
    }
};
