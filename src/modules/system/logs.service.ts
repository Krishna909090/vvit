import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } from '@aws-sdk/client-cloudwatch-logs';
import logger from '../../utils/logger';
import { AppError } from '../../utils/AppError';

const cwClient = new CloudWatchLogsClient({
    region: process.env.AWS_REGION || 'ap-south-1'
});

const LOG_GROUP = process.env.CW_LOG_GROUP || '/vvitu/erp/application';

/**
 * Search logs by correlationId, studentId, applicationId, or txnId.
 * Returns structured timeline entries.
 */
export const searchTransactionLogs = async (
    searchTerm: string,
    startTime?: Date,
    endTime?: Date
) => {
    const start = startTime || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // default 7 days
    const end = endTime || new Date();

    const query = `
        fields @timestamp, @message
        | filter @message like "${searchTerm}"
        | sort @timestamp asc
        | limit 500
    `;

    try {
        const startQuery = await cwClient.send(new StartQueryCommand({
            logGroupName: LOG_GROUP,
            startTime: Math.floor(start.getTime() / 1000),
            endTime: Math.floor(end.getTime() / 1000),
            queryString: query
        }));

        const queryId = startQuery.queryId;
        if (!queryId) throw new AppError('Failed to start CloudWatch query', 500);

        // Poll for results (CloudWatch Insights is async)
        let results: any[] = [];
        let status = 'Running';
        let attempts = 0;

        while (status === 'Running' || status === 'Scheduled') {
            if (attempts++ > 20) break; // max ~10 seconds
            await new Promise(r => setTimeout(r, 500));

            const response = await cwClient.send(new GetQueryResultsCommand({ queryId }));
            status = response.status || 'Complete';
            if (response.results) {
                results = response.results;
            }
        }

        // Parse results into structured timeline
        const timeline = results.map(row => {
            const timestampField = row.find((f: any) => f.field === '@timestamp');
            const messageField = row.find((f: any) => f.field === '@message');

            const timestamp = timestampField?.value || '';
            const rawMessage = messageField?.value || '';

            // Try to parse as JSON (structured log)
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
                // Plain text log — extract what we can
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
            query: searchTerm,
            timeRange: { start: start.toISOString(), end: end.toISOString() },
            timeline
        };

    } catch (error: any) {
        logger.error(`[LogsService] CloudWatch query failed: ${error.message}`);
        throw new AppError('Failed to query logs', 500);
    }
};

/**
 * Fallback: Search from local log files when CloudWatch is not configured.
 */
export const searchLocalLogs = async (searchTerm: string, days: number = 7) => {
    const fs = await import('fs');
    const path = await import('path');
    const readline = await import('readline');

    const logDir = path.join(process.cwd(), 'logs/erp');
    const results: any[] = [];

    // Read recent log files
    const now = new Date();
    for (let d = 0; d < days; d++) {
        const date = new Date(now);
        date.setDate(date.getDate() - d);
        const dateStr = date.toISOString().split('T')[0];
        const filePath = path.join(logDir, `application-${dateStr}.log`);

        if (!fs.existsSync(filePath)) continue;

        const fileStream = fs.createReadStream(filePath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        for await (const line of rl) {
            if (line.includes(searchTerm)) {
                try {
                    const parsed = JSON.parse(line);
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
        }
    }

    return {
        total: results.length,
        query: searchTerm,
        source: 'local',
        timeline: results.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    };
};

// Extract module from legacy log messages like "[initiateApplicationFeePayment]" or "[InvoiceService]"
function extractModule(message: string): string {
    const match = message?.match(/\[(\w+?)(?:Service|Controller)?\]/);
    if (match) {
        const raw = match[1];
        // Map common prefixes to module names
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

// Extract action from legacy log messages
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
