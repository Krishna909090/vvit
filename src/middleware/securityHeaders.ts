

import helmet from 'helmet';
import { isProduction } from '../config/envValidator';

export const enhancedSecurityHeaders = helmet({

    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: isProduction() ? [] : null,
        },
    },

    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
    },

    frameguard: {
        action: 'deny',
    },

    noSniff: true,

    xssFilter: true,

    referrerPolicy: {
        policy: 'strict-origin-when-cross-origin',
    },

    permittedCrossDomainPolicies: {
        permittedPolicies: 'none',
    },

    hidePoweredBy: true,

    dnsPrefetchControl: {
        allow: false,
    },

    ieNoOpen: true,

    crossOriginEmbedderPolicy: false,

    crossOriginOpenerPolicy: {
        policy: 'unsafe-none',
    },

    crossOriginResourcePolicy: {
        policy: 'cross-origin',
    },

    originAgentCluster: true,
});

export const additionalSecurityHeaders = (req: any, res: any, next: any) => {

    res.setHeader(
        'Permissions-Policy',
        'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
    );

    res.setHeader('X-Download-Options', 'noopen');

    if (isProduction()) {
        res.setHeader('Expect-CT', 'max-age=86400, enforce');
    }

    if (req.path.includes('/auth') || req.path.includes('/admin')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }

    next();
};
