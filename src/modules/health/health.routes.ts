// routes/healthRoutes.ts
// Health check and monitoring endpoints

import { Router, Request, Response } from 'express';
import prisma from '../../config/prisma';
import logger from '../../utils/logger';
import { version } from '../../../package.json';

const router = Router();

// ═══════════════════════════════════════════════════════════
//  BASIC HEALTH CHECK
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /health
 * @desc    Lightweight health check — confirms the API process is running.
 *          Does NOT verify downstream dependencies (database, cache, etc.).
 * @access  Public (no authentication required).
 * @returns {{ status: "ok", version: string, timestamp: string, uptime: number }}
 */
router.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
        status: 'ok',
        version: version || '1.0.1',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});

// ═══════════════════════════════════════════════════════════
//  DETAILED HEALTH CHECK
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /health/detailed
 * @desc    Comprehensive health check that verifies database connectivity, memory usage, and CPU stats.
 *          Returns "ok" (200), "degraded" (200), or "unhealthy" (503) based on subsystem checks.
 * @access  Public (no authentication required).
 * @sideEffect Executes a `SELECT 1` query against the database to test connectivity.
 * @returns {{ status: string, timestamp: string, uptime: number, version: string, environment: string,
 *             checks: { database, memory, disk }, details: { memoryUsage, cpuUsage } }}
 */
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

// ═══════════════════════════════════════════════════════════
//  READINESS PROBE
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /health/ready
 * @desc    Kubernetes-style readiness probe. Returns 200 only when the database is reachable,
 *          indicating the service can accept traffic.
 * @access  Public (no authentication required).
 * @sideEffect Executes a `SELECT 1` query against the database.
 * @returns {{ status: "ready" | "not ready", timestamp: string, error?: string }}
 *          200 if ready, 503 if not.
 */
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

// ═══════════════════════════════════════════════════════════
//  LIVENESS PROBE
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /health/live
 * @desc    Kubernetes-style liveness probe. Always returns 200 if the process is running.
 *          Does NOT check any dependencies.
 * @access  Public (no authentication required).
 * @returns {{ status: "alive", timestamp: string }}
 */
router.get('/health/live', (req: Request, res: Response) => {
    res.status(200).json({
        status: 'alive',
        timestamp: new Date().toISOString(),
    });
});

// ═══════════════════════════════════════════════════════════
//  PROCESS METRICS
// ═══════════════════════════════════════════════════════════

/**
 * @route   GET /metrics
 * @desc    Expose raw process metrics (memory, CPU, uptime) for monitoring tools and dashboards.
 * @access  Public (no authentication required).
 * @returns {{ timestamp: string, uptime: number,
 *             memory: { heapUsed, heapTotal, external, rss },
 *             cpu: { user, system },
 *             process: { pid, version, platform, arch } }}
 */
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
