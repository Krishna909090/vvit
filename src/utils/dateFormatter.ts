

const IST_TIMEZONE = 'Asia/Kolkata';

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

export const formatDate = (date: Date | null | undefined): string | null => {
    if (!date) return null;
    try {

        return dateFormatter.format(new Date(date)).replace(/\//g, '-');
    } catch (e) {
        return null;
    }
    
};

export const formatTime = (date: Date | null | undefined): string | null => {
    if (!date) return null;
    try {
        return timeFormatter.format(new Date(date)).toUpperCase();
    } catch (e) {
        return null;
    }
};

export const formatDateTime = (date: Date | null | undefined): string | null => {
    if (!date) return null;
    
    const d = new Date(date);
    const dateStr = formatDate(d);
    const timeStr = formatTime(d);
    return `${dateStr} ${timeStr}`;
};
