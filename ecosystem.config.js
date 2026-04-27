module.exports = {
    apps: [
        {
            name: 'vvitu-prod-api',
            script: 'dist/server.js',
            cwd: '/var/www/erp/vvit',
            instances: 'max', // Scale to all available CPUs
            exec_mode: 'cluster',
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'production',
                ENABLE_SCHEDULER: 'false', // Disable scheduler in API nodes
            }
        },
        {
            name: 'vvitu-prod-worker',
            script: 'dist/server.js',
            cwd: '/var/www/erp/vvit',
            instances: 1, // Single instance for background jobs
            exec_mode: 'fork',
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'production',
                ENABLE_SCHEDULER: 'true',  // Enable scheduler
                DISABLE_WEB_SERVER: 'true' // Disable API on worker
            }
        },
        {
            name: 'vvitu-dev',
            script: 'dist/server.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            watch: true,
            ignore_watch: ["node_modules", "logs", ".git", "dist", "uploads", "tmp", "*.log"],
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'development',
                ENABLE_SCHEDULER: 'true'
            }
        },
        {
            // ✅ LOCAL APP WITH DATE VALIDATION SKIP FOR TESTING
            name: 'vvitu-local',
            script: 'dist/server.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            watch: true,
            ignore_watch: ["node_modules", "logs", ".git", "dist", "uploads", "tmp", "*.log"],
            max_memory_restart: '300M',
            env: {
                NODE_ENV: 'local',
                ENABLE_SCHEDULER: 'true',
                USE_LOCAL_DB: 'true',
                // Using DATABASE_URL from .env or fallback
                SKIP_DATE_VALIDATION: 'true', // Skip date check for testing
            }
        }
    ]
};
