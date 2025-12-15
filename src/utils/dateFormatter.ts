// src/utils/dateFormatter.ts
/**
 * Centralized date/time formatting utilities for IST timezone
 */

/**
 * Format a date into dd-MM-yyyy string in IST.
 */
export const formatDate = (date: Date | null | undefined): string | null => {
    if (!date) return null;
    return new Date(date).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
    }).replace(/\//g, '-');
};

/**
 * Format a time part using 12-hour clock in IST.
 */
export const formatTime = (date: Date | null | undefined): string | null => {
    if (!date) return null;
    return new Date(date)
        .toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
            timeZone: 'Asia/Kolkata',
        })
        .toUpperCase();
};

/**
 * Format a full datetime into 'dd-MM-yyyy HH:mm AM/PM' string in IST.
 * Used for timestamps like createdAt, updatedAt, verifiedAt, etc.
 */
export const formatDateTime = (date: Date | null | undefined): string | null => {
    if (!date) return null;
    
    const d = new Date(date);
    const dateStr = formatDate(d);
    const timeStr = formatTime(d);
    return `${dateStr} ${timeStr}`;
};
