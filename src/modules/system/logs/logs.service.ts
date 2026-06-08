import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } from '@aws-sdk/client-cloudwatch-logs';
import logger from '../../../utils/logger';
import { AppError } from '../../../utils/AppError';

const cwClient = new CloudWatchLogsClient({
    region: process.env.AWS_REGION || 'ap-south-1'
});

const LOG_GROUP = process.env.CW_LOG_GROUP || '/vvitu/erp/application';

export const searchTransactionLogs = async (
    searchTerm: string | null,
    startTime?: Date,
    endTime?: Date
) => {
    const start = startTime || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = endTime || new Date();

    const query = searchTerm
        ? `fields @timestamp, @message | filter @message like "${searchTerm}" | sort @timestamp asc | limit 500`
        : `fields @timestamp, @message | sort @timestamp asc | limit 500`;

    try {
        const startQuery = await cwClient.send(new StartQueryCommand({
            logGroupName: LOG_GROUP,
            startTime: Math.floor(start.getTime() / 1000),
            endTime: Math.floor(end.getTime() / 1000),
            queryString: query
        }));

        const queryId = startQuery.queryId;
        if (!queryId) throw new AppError('Failed to start CloudWatch query', 500);

        let results: any[] = [];
        let status = 'Running';
        let attempts = 0;

        while (status === 'Running' || status === 'Scheduled') {
            if (attempts++ > 20) break;
            await new Promise(r => setTimeout(r, 500));

            const response = await cwClient.send(new GetQueryResultsCommand({ queryId }));
            status = response.status || 'Complete';
            if (response.results) {
                results = response.results;
            }
        }

        const timeline = results.map(row => {
            const timestampField = row.find((f: any) => f.field === '@timestamp');
            const messageField = row.find((f: any) => f.field === '@message');

            const timestamp = timestampField?.value || '';
            const rawMessage = messageField?.value || '';

            try {
                const parsed = JSON.parse(rawMessage);
                return {
                    timestamp: parsed.timestamp || timestamp,
                    level: parsed.level || 'info',
                    correlationId: parsed.correlationId,
                    module: parsed.module || extractModule(parsed.message),
                    action: parsed.action || extractAction(parsed.message),
                    message: parsed.message,
                    meta: parsed.meta
                };
            } catch {

                return {
                    timestamp,
                    level: rawMessage.includes('error') ? 'error' : rawMessage.includes('warn') ? 'warn' : 'info',
                    correlationId: '',
                    module: extractModule(rawMessage),
                    action: extractAction(rawMessage),
                    message: rawMessage
                };
            }
        });

        return {
            total: timeline.length,
            query: searchTerm || '',
            timeRange: { from: start.toISOString(), to: end.toISOString() },
            timeline
        };

    } catch (error: any) {
        logger.error(`[LogsService] CloudWatch query failed: ${error.message}`);
        throw new AppError('Failed to query logs', 500);
    }
};

export const searchLocalLogs = async (
    searchTerm: string | null,
    days: number = 7,
    startTime?: Date,
    endTime?: Date
) => {
    const fs = await import('fs');
    const path = await import('path');
    const readline = await import('readline');

    const logDir = path.join(process.cwd(), 'logs/erp');
    const results: any[] = [];

    const seenLines = new Set<string>();
    const now = endTime || new Date();

    const readLogFile = async (filePath: string) => {
        if (!fs.existsSync(filePath)) return;
        const fileStream = fs.createReadStream(filePath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        for await (const line of rl) {
            if (!line.trim()) continue;
            if (searchTerm && !line.includes(searchTerm)) continue;

            if (seenLines.has(line)) continue;
            seenLines.add(line);

            try {
                const parsed = JSON.parse(line);
                const entryTime = parsed.timestamp ? new Date(parsed.timestamp) : null;
                if (entryTime) {
                    if (startTime && entryTime < startTime) continue;
                    if (endTime && entryTime > endTime) continue;
                }
                results.push({
                    timestamp: parsed.timestamp,
                    level: parsed.level,
                    correlationId: parsed.correlationId,
                    module: parsed.module || extractModule(parsed.message),
                    action: parsed.action || extractAction(parsed.message),
                    message: parsed.message,
                    meta: parsed.meta
                });
            } catch {
                results.push({
                    timestamp: '',
                    level: 'info',
                    module: extractModule(line),
                    action: extractAction(line),
                    message: line
                });
            }
        }
    };

    for (let d = 0; d < days; d++) {
        const date = new Date(now);
        date.setDate(date.getDate() - d);
        const dateStr = date.toISOString().split('T')[0];

        await readLogFile(path.join(logDir, `application-${dateStr}.log`));
        await readLogFile(path.join(logDir, `error-${dateStr}.log`));
    }

    return {
        total: results.length,
        query: searchTerm || '',
        source: 'local',
        timeRange: {
            from: (startTime || new Date(Date.now() - days * 24 * 60 * 60 * 1000)).toISOString(),
            to: now.toISOString()
        },
        timeline: results.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    };
};

function extractModule(message: string): string {
    const match = message?.match(/\[(\w+?)(?:Service|Controller)?\]/);
    if (match) {
        const raw = match[1];

        if (raw.includes('payment') || raw.includes('Payment') || raw.includes('PhonePe')) return 'PAYMENT';
        if (raw.includes('invoice') || raw.includes('Invoice')) return 'INVOICE';
        if (raw.includes('admission') || raw.includes('Admission')) return 'ADMISSION';
        if (raw.includes('ledger') || raw.includes('Ledger')) return 'LEDGER';
        if (raw.includes('allotment') || raw.includes('Allotment')) return 'ALLOTMENT';
        if (raw.includes('email') || raw.includes('Email')) return 'EMAIL';
        if (raw.includes('webhook') || raw.includes('Webhook')) return 'WEBHOOK';
        if (raw.includes('exam') || raw.includes('Exam')) return 'EXAM';
        if (raw.includes('scholarship') || raw.includes('Scholarship')) return 'SCHOLARSHIP';
        return raw.toUpperCase();
    }
    return 'SYSTEM';
}

function extractAction(message: string): string {
    if (!message) return '';
    const lower = message.toLowerCase();
    if (lower.includes('initiat')) return 'INITIATE';
    if (lower.includes('success')) return 'SUCCESS';
    if (lower.includes('failed') || lower.includes('failure')) return 'FAILED';
    if (lower.includes('generated')) return 'GENERATED';
    if (lower.includes('created')) return 'CREATED';
    if (lower.includes('updated')) return 'UPDATED';
    if (lower.includes('callback') || lower.includes('webhook')) return 'RECEIVED';
    if (lower.includes('redirect')) return 'REDIRECT';
    if (lower.includes('settled')) return 'SETTLED';
    if (lower.includes('sent') || lower.includes('email')) return 'SENT';
    return '';
}
