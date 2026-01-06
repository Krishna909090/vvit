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
import verificationRoutes from './modules/admin/verification.routes';
import academicRoutes from './modules/academic/academic.routes';
import qualificationRequirementRoutes from './modules/qualification/qualificationRequirement.routes';
import logger from './utils/logger';
import { globalErrorHandler } from './middlewares/errorMiddleware';
import { generalRateLimiter } from './middlewares/rateLimitMiddleware';
import { enhancedSecurityHeaders, additionalSecurityHeaders } from './middlewares/securityHeaders';

const app = express();

// Trust Proxy (Required for Rate Limiting behind load balancers/proxies like Nginx/AWS ALB)
app.set('trust proxy', 1);

// Security Middlewares (Order matters!)
app.use(enhancedSecurityHeaders); // Enhanced Helmet configuration
app.use(additionalSecurityHeaders); // Custom security headers
app.use(cors({
    origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true), // Allow all if * or undefined (dev), else specific list
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

// Apply general rate limiter (100 req/hr) to all routes
app.use(generalRateLimiter);

app.use('/auth', authRoutes);
app.use('/student', studentRoutes);
app.use('/admin', adminRoutes);
app.use('/exam', examRoutes);
app.use('/invigilator', invigilatorRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/document-requirements', documentRequirementRoutes);
app.use('/finance', paymentRoutes);
app.use('/api/admission', dataImportRoutes);
app.use('/verification', verificationRoutes);
app.use('/admin/academic', academicRoutes);
app.use('/qualification-requirements', qualificationRequirementRoutes);




// Global Error Handler
app.use(globalErrorHandler);

app.get('/', (req, res) => {
    res.send('College Admission API is running');
});

export default app;

