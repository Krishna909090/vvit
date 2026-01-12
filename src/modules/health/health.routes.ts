// routes/healthRoutes.ts
// Health check and monitoring endpoints

import { Router, Request, Response } from 'express';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { version } from '../../../package.json';

const router = Router();

router.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
        status: 'ok',
        version: version || '1.0.1',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});

router.get('/health/detailed', async (req: Request, res: Response) => {
    const healthCheck = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: version || '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        checks: {
            database: 'unknown',
            memory: 'unknown',
            disk: 'unknown',
        },
        details: {
            memoryUsage: {} as any,
            cpuUsage: {} as any,
        }
    };

    try {
        // Check database connection
        await prisma.$queryRaw`SELECT 1`;
        healthCheck.checks.database = 'healthy';
    } catch (error) {
        healthCheck.status = 'degraded';
        healthCheck.checks.database = 'unhealthy';
        logger.error(`[Health] Database check failed: ${error}`);
    }

    // Check memory usage
    const memUsage = process.memoryUsage();
    const totalMemory = memUsage.heapTotal;
    const usedMemory = memUsage.heapUsed;
    const memoryUsagePercent = (usedMemory / totalMemory) * 100;

    healthCheck.details.memoryUsage = {
        heapUsed: `${Math.round(usedMemory / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(totalMemory / 1024 / 1024)}MB`,
        external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
        usagePercent: `${memoryUsagePercent.toFixed(2)}%`,
    };

    if (memoryUsagePercent > 90) {
        healthCheck.status = 'degraded';
        healthCheck.checks.memory = 'critical';
    } else if (memoryUsagePercent > 75) {
        healthCheck.checks.memory = 'warning';
    } else {
        healthCheck.checks.memory = 'healthy';
    }

    // Check CPU usage
    const cpuUsage = process.cpuUsage();
    healthCheck.details.cpuUsage = {
        user: `${(cpuUsage.user / 1000000).toFixed(2)}s`,
        system: `${(cpuUsage.system / 1000000).toFixed(2)}s`,
    };

    // Overall status
    if (healthCheck.checks.database === 'unhealthy') {
        healthCheck.status = 'unhealthy';
    }

    const statusCode = healthCheck.status === 'ok' ? 200 : 
                       healthCheck.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json(healthCheck);
});

router.get('/health/ready', async (req: Request, res: Response) => {
    try {
        // Check database connection
        await prisma.$queryRaw`SELECT 1`;
        
        res.status(200).json({
            status: 'ready',
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        logger.error(`[Health] Readiness check failed: ${error}`);
        res.status(503).json({
            status: 'not ready',
            timestamp: new Date().toISOString(),
            error: 'Database connection failed',
        });
    }
});

router.get('/health/live', (req: Request, res: Response) => {
    res.status(200).json({
        status: 'alive',
        timestamp: new Date().toISOString(),
    });
});

router.get('/metrics', (req: Request, res: Response) => {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    const metrics = {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: {
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external,
            rss: memUsage.rss,
        },
        cpu: {
            user: cpuUsage.user,
            system: cpuUsage.system,
        },
        process: {
            pid: process.pid,
            version: process.version,
            platform: process.platform,
            arch: process.arch,
        },
    };

    res.status(200).json(metrics);
});

export default router;
