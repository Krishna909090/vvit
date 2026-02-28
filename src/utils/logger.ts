import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getCorrelationId } from './requestContext';

// Human-readable format for local console
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const msg = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;
        const correlationId = getCorrelationId();
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `${timestamp} [${level}] [${correlationId}]: ${msg}${metaStr}`;
    })
);

// JSON format for CloudWatch — one log entry per line, fully queryable via Insights
const cloudWatchFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => {
        const { timestamp, level, message, stack, ...meta } = info;
        const entry: Record<string, any> = {
            timestamp,
            level,
            correlationId: getCorrelationId(),
            message: typeof message === 'object' ? JSON.stringify(message) : message,
        };
        if (stack) entry.stack = stack;
        if (Object.keys(meta).length) entry.meta = meta;
        return JSON.stringify(entry);
    })
);

const logger = winston.createLogger({
    transports: [
        // Console — colourised plain text for local dev
        new winston.transports.Console({
            format: consoleFormat
        }),
        // File (→ CloudWatch agent) — one JSON object per line
        new DailyRotateFile({
            filename: 'logs/erp/application-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            format: cloudWatchFormat
        }),
        // Separate error-only file for quick error triage
        new DailyRotateFile({
            filename: 'logs/erp/error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'error',
            format: cloudWatchFormat
        })
    ],
});

export default logger;
