// middlewares/securityHeaders.ts
// Enhanced security headers configuration

import helmet from 'helmet';
import { isProduction } from '../config/envValidator';

/**
 * Enhanced Helmet configuration with strict security policies
 */
export const enhancedSecurityHeaders = helmet({
    // Content Security Policy
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for Swagger
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: isProduction() ? [] : null,
        },
    },

    // Strict Transport Security (HSTS)
    // Forces HTTPS for 1 year, including subdomains
    hsts: {
        maxAge: 31536000, // 1 year in seconds
        includeSubDomains: true,
        preload: true,
    },

    // X-Frame-Options: Prevent clickjacking
    frameguard: {
        action: 'deny',
    },

    // X-Content-Type-Options: Prevent MIME sniffing
    noSniff: true,

    // X-XSS-Protection: Enable XSS filter
    xssFilter: true,

    // Referrer-Policy: Control referrer information
    referrerPolicy: {
        policy: 'strict-origin-when-cross-origin',
    },

    // X-Permitted-Cross-Domain-Policies
    permittedCrossDomainPolicies: {
        permittedPolicies: 'none',
    },

    // Hide X-Powered-By header
    hidePoweredBy: true,

    // DNS Prefetch Control
    dnsPrefetchControl: {
        allow: false,
    },

    // IE No Open
    ieNoOpen: true,

    // Cross-Origin-Embedder-Policy
    crossOriginEmbedderPolicy: false, // Set to true if you need strict isolation

    // Cross-Origin-Opener-Policy
    crossOriginOpenerPolicy: {
        policy: 'same-origin',
    },

    // Cross-Origin-Resource-Policy
    crossOriginResourcePolicy: {
        policy: 'same-origin',
    },

    // Origin-Agent-Cluster
    originAgentCluster: true,
});

/**
 * Additional custom security headers
 */
export const additionalSecurityHeaders = (req: any, res: any, next: any) => {
    // Permissions Policy (formerly Feature Policy)
    res.setHeader(
        'Permissions-Policy',
        'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()'
    );

    // X-Download-Options: Prevent IE from executing downloads
    res.setHeader('X-Download-Options', 'noopen');

    // Expect-CT: Certificate Transparency
    if (isProduction()) {
        res.setHeader('Expect-CT', 'max-age=86400, enforce');
    }

    // Cache-Control for sensitive endpoints
    if (req.path.includes('/auth') || req.path.includes('/admin')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }

    next();
};
