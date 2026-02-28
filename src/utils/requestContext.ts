
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export interface RequestContext {
    correlationId: string;
    userId: string;
    [key: string]: any;
}

const context = new AsyncLocalStorage<RequestContext>();

export const requestContextMiddleware = (req: Request, res: Response, next: NextFunction) => {
    // Honour an incoming correlation ID (e.g. from API gateway or frontend) or generate a fresh one
    const correlationId =
        (req.headers['x-correlation-id'] as string) ||
        (req.headers['x-request-id'] as string) ||
        randomUUID();

    // Echo the correlation ID back so callers can trace their request
    res.setHeader('x-correlation-id', correlationId);

    const defaultContext: RequestContext = {
        correlationId,
        userId: 'system', // Default to system for unauthenticated or background tasks
    };

    context.run(defaultContext, () => {
        next();
    });
};

export const runInContext = (callback: () => void, initialContext: Partial<RequestContext> = {}) => {
    const fullContext: RequestContext = {
        correlationId: randomUUID(),
        userId: 'system',
        ...initialContext,
    };
    context.run(fullContext, callback);
};

export const getContext = (): RequestContext => {
    const store = context.getStore();
    return store || { correlationId: 'no-context', userId: 'system' };
};

export const getCorrelationId = (): string => {
    return context.getStore()?.correlationId ?? 'no-context';
};

export const setContextUser = (userId: string) => {
    const store = context.getStore();
    if (store) {
        store.userId = userId;
    }
};
