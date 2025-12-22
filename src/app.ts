import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import hpp from 'hpp';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import authRoutes from './modules/auth/auth.routes';
import studentRoutes from './modules/student/student.routes';
import adminRoutes from './modules/admin/admin.routes';
import examRoutes from './modules/exam/exam.routes';
import uploadRoutes from './modules/student/upload.routes';
import invigilatorRoutes from './modules/exam/invigilator.routes';
import documentRequirementRoutes from './modules/document/documentRequirement.routes';
import healthRoutes from './modules/health/health.routes';
import paymentRoutes from './modules/finance/payment.routes';
import dataImportRoutes from './modules/admission/dataImport.routes';
import logger from './utils/logger';
import { globalErrorHandler } from './middlewares/errorMiddleware';
import {
    authRateLimiter,
    uploadRateLimiter,
    readRateLimiter,
    writeRateLimiter,
    generalRateLimiter
} from './middlewares/rateLimitMiddleware';
import { enhancedSecurityHeaders, additionalSecurityHeaders } from './middlewares/securityHeaders';

const app = express();

// Trust Proxy (Required for Rate Limiting behind load balancers/proxies like Nginx/AWS ALB)
app.set('trust proxy', 1);

// Security Middlewares (Order matters!)
app.use(enhancedSecurityHeaders); // Enhanced Helmet configuration
app.use(additionalSecurityHeaders); // Custom security headers
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*', // Configure this in env for production
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400 // 24 hours
}));
app.use(compression()); // Gzip compression
app.use(express.json({ limit: '10kb' })); // Body limit
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(hpp()); // Prevent HTTP Parameter Pollution
// app.use(sanitizeInput); // Input sanitization (XSS, NoSQL injection prevention) - TEMPORARILY DISABLED FOR DEMO

app.use(morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) }
}));

// Swagger Setup
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'College Admission API',
            version: '1.0.0',
            description: 'API for College Admission System',
        },
        servers: [
            {
                url: 'http://localhost:3000',
            },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
        security: [
            {
                bearerAuth: [],
            },
        ],
    },
    apis: ['./src/modules/**/*.routes.ts'],
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Health Check Routes (No rate limiting for load balancers)
app.use('/', healthRoutes);

// Routes with Enhanced Rate Limiting
app.use('/auth', authRateLimiter, authRoutes); // Strict: 5 attempts/15min
app.use('/student', readRateLimiter, writeRateLimiter, studentRoutes); // Read: 200/15min, Write: 50/15min
app.use('/admin', readRateLimiter, writeRateLimiter, adminRoutes); // Read: 200/15min, Write: 50/15min
app.use('/exam', readRateLimiter, writeRateLimiter, examRoutes); // Read: 200/15min, Write: 50/15min
app.use('/invigilator', readRateLimiter, writeRateLimiter, invigilatorRoutes); // Read: 200/15min, Write: 50/15min
app.use('/api/upload', uploadRateLimiter, uploadRoutes); // 30 uploads/hour (student-friendly)
app.use('/document-requirements', readRateLimiter, writeRateLimiter, documentRequirementRoutes); // Read: 200/15min, Write: 50/15min
app.use('/payment', writeRateLimiter, paymentRoutes);
app.use('/api/admission', readRateLimiter, writeRateLimiter, dataImportRoutes);


// Apply general rate limiter to any other routes
app.use(generalRateLimiter);

// Global Error Handler
app.use(globalErrorHandler);

app.get('/', (req, res) => {
    res.send('College Admission API is running');
});

export default app;

