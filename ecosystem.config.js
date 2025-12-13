module.exports = {
    apps: [
        {
            name: 'vvitu-prod',
            script: 'dist/server.js',
            instances: 1,
            exec_mode: 'cluster',
            autorestart: true,
            watch: false,
            max_memory_restart: '1G',
            env: {
                NODE_ENV: 'production',
            }
        },
        {
            name: 'vvitu-dev',
            script: 'dist/server.js',
            instances: 1,
            exec_mode: 'fork',
            autorestart: true,
            watch: true,
            ignore_watch: ["node_modules", "logs"],
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'development',
                USE_LOCAL_DB: 'true',
                DB_HOST: 'localhost',
                DB_PORT: '5432',
                DB_NAME: 'vvit',
                DB_USER: 'postgres',
                DB_PASSWORD: '',
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
            ignore_watch: ["node_modules", "logs"],
            max_memory_restart: '300M',
            env: {
                NODE_ENV: 'local',
                USE_LOCAL_DB: 'true',
                DATABASE_URL: 'postgresql://postgres@localhost:5432/vvit',
                SKIP_DATE_VALIDATION: 'true', // Skip date check for testing
            }
        }
    ]
};
