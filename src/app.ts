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
import uploadRoutes from './modules/upload/upload.routes';
import invigilatorRoutes from './modules/exam/invigilator.routes';
import documentRequirementRoutes from './modules/document/documentRequirement.routes';
import healthRoutes from './modules/health/health.routes';
import paymentRoutes from './modules/finance/payment.routes';
import dataImportRoutes from './modules/admission/dataImport/dataImport.routes';
import verificationRoutes from './modules/studentManagement/verification.routes';
import qualificationRequirementRoutes from './modules/qualification/qualificationRequirement.routes';
import emailLogRoutes from './modules/system/emailLog/emailLog.routes';
import logsRoutes from './modules/system/logs/logs.routes';
import rbacRoutes from './modules/rbac/rbac.routes';
import invoiceRoutes from './modules/finance/invoice.routes';
import feeRoutes from './modules/finance/fee.routes';
import cancellationRoutes from './modules/finance/cancellation.routes';
import proRoutes from './modules/pro/pro.routes';
import logger from './utils/logger';
import { globalErrorHandler } from './middleware/errorMiddleware';
import { generalRateLimiter } from './middleware/rateLimitMiddleware';
import { enhancedSecurityHeaders, additionalSecurityHeaders } from './middleware/securityHeaders';
import { requestContextMiddleware } from './utils/requestContext';
import { sanitizeInput } from './middleware/sanitizeMiddleware';

const app = express();

app.set('trust proxy', 1);

app.use(enhancedSecurityHeaders);
app.use(additionalSecurityHeaders);
app.use(requestContextMiddleware);

if (process.env.CORS_ORIGIN === '*' && process.env.NODE_ENV === 'production') {
    logger.warn('[Security] CORS_ORIGIN is set to "*" in production. Falling back to origin: false (all cross-origin requests denied). Set CORS_ORIGIN to an explicit allow-list.');
}
const corsOrigin: cors.CorsOptions['origin'] =
    (process.env.CORS_ORIGIN === '*' && process.env.NODE_ENV === 'production')
        ? false
        : process.env.CORS_ORIGIN === '*'
            ? true
            : process.env.CORS_ORIGIN
                ? process.env.CORS_ORIGIN.split(',')
                : false;
app.use(cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id'],
    exposedHeaders: ['x-correlation-id'],
    credentials: true,
    maxAge: 86400
}));
app.use(compression());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(hpp());
app.use(sanitizeInput);

app.use(morgan('combined', {
    stream: { write: (message: string) => logger.info(message.trim()) }
}));

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

if (process.env.NODE_ENV !== 'production') {
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));
}

app.use('/', healthRoutes);

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
app.use('/qualification-requirements', qualificationRequirementRoutes);
app.use('/admin/email-logs', emailLogRoutes);
app.use('/system', logsRoutes);
app.use('/rbac', rbacRoutes);
app.use('/admin/finance', invoiceRoutes);
app.use('/admin/cancellation', cancellationRoutes);
app.use('/finance', feeRoutes);
app.use('/pro', proRoutes);

app.use(globalErrorHandler);

app.get('/', (req, res) => {
    res.send('College Admission API is running');
});

export default app;

