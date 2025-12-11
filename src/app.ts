import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import hpp from 'hpp';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import authRoutes from './routes/authRoutes';
import studentRoutes from './routes/studentRoutes';
import adminRoutes from './routes/adminRoutes';
import examRoutes from './routes/examRoutes';
import uploadRoutes from './routes/uploadRoutes';
import invigilatorRoutes from './routes/invigilatorRoutes';
import logger from './utils/logger';
import { globalErrorHandler } from './middlewares/errorMiddleware';

const app = express();

// Trust Proxy (Required for Rate Limiting behind load balancers/proxies like Nginx/AWS ALB)
app.set('trust proxy', 1);

// Middlewares
app.use(helmet()); // Secure HTTP headers
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*', // Configure this in env for production
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(compression()); // Gzip compression
app.use(express.json({ limit: '10kb' })); // Body limit
app.use(hpp()); // Prevent HTTP Parameter Pollution

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/auth', limiter); // Apply stricter limit to auth routes
app.use('/api', limiter); // Apply to other API routes if needed

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
    apis: ['./src/routes/*.ts'],
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Routes
app.use('/auth', authRoutes);
app.use('/student', studentRoutes);
app.use('/admin', adminRoutes);
app.use('/exam', examRoutes);
app.use('/invigilator', invigilatorRoutes);
app.use('/api/upload', uploadRoutes);

// Global Error Handler
app.use(globalErrorHandler);

app.get('/', (req, res) => {
    res.send('College Admission API is running');
});

export default app;
