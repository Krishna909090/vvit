
import { AsyncLocalStorage } from 'async_hooks';
import { NextFunction, Request, Response } from 'express';

export interface RequestContext {
    userId: string;
    [key: string]: any;
}

const context = new AsyncLocalStorage<RequestContext>();

export const requestContextMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const defaultContext: RequestContext = {
        userId: 'system', // Default to system for unauthenticated or background tasks
    };

    context.run(defaultContext, () => {
        next();
    });
};

export const runInContext = (callback: () => void, initialContext: RequestContext = { userId: 'system' }) => {
    context.run(initialContext, callback);
};

export const getContext = (): RequestContext => {
    const store = context.getStore();
    return store || { userId: 'system' };
};

export const setContextUser = (userId: string) => {
    const store = context.getStore();
    if (store) {
        store.userId = userId;
    }
};
