import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { getCorrelationId, getContext } from './requestContext';

const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, module: mod, action, ...meta }) => {
        const msg = typeof message === 'object' ? JSON.stringify(message, null, 2) : message;
        const correlationId = getCorrelationId();
        const prefix = mod && action ? `[${mod}] ${action} ` : mod ? `[${mod}] ` : '';
        const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `${timestamp} [${level}] [${correlationId}]: ${prefix}${msg}${metaStr}`;
    })
);

const cloudWatchFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => {
        const { timestamp, level, message, stack, module: mod, action, ...meta } = info;
        const ctx = getContext();
        const entry: Record<string, any> = {
            timestamp,
            level,
            correlationId: ctx.correlationId,
            userId: ctx.userId,
            message: typeof message === 'object' ? JSON.stringify(message) : message,
        };
        if (mod) entry.module = mod;
        if (action) entry.action = action;
        if (stack) entry.stack = stack;
        if (Object.keys(meta).length) entry.meta = meta;
        return JSON.stringify(entry);
    })
);

const logger = winston.createLogger({
    transports: [

        new winston.transports.Console({
            format: consoleFormat
        }),

        new DailyRotateFile({
            filename: 'logs/erp/application-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            format: cloudWatchFormat
        }),

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

export const createModuleLogger = (moduleName: string) => ({
    info: (action: string, message: string, meta?: Record<string, any>) => {
        logger.info(message, { module: moduleName, action, ...meta });
    },
    warn: (action: string, message: string, meta?: Record<string, any>) => {
        logger.warn(message, { module: moduleName, action, ...meta });
    },
    error: (action: string, message: string, meta?: Record<string, any>) => {
        logger.error(message, { module: moduleName, action, ...meta });
    }
});

export default logger;
