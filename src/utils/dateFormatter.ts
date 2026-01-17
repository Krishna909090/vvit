// src/utils/dateFormatter.ts
/**
 * Centralized date/time formatting utilities for IST timezone
 * Optimized with cached Intl.DateTimeFormat instances for performance
 */

const IST_TIMEZONE = 'Asia/Kolkata';

// Cached formatters to avoid recreating them for every call (High Performance)
const dateFormatter = new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: IST_TIMEZONE,
});

const timeFormatter = new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: IST_TIMEZONE,
});

/**
 * Format a date into dd-MM-yyyy string in IST.
 */
export const formatDate = (date: Date | null | undefined): string | null => {
    if (!date) return null;
    try {
        // format() returns "dd/MM/yyyy", handle slashes
        return dateFormatter.format(new Date(date)).replace(/\//g, '-');
    } catch (e) {
        return null;
    }
    
};

/**
 * Format a time part using 12-hour clock in IST.
 */
export const formatTime = (date: Date | null | undefined): string | null => {
    if (!date) return null;
    try {
        return timeFormatter.format(new Date(date)).toUpperCase();
    } catch (e) {
        return null;
    }
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
