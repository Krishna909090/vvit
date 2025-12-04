module.exports = {
    apps: [
        {
            name: 'vvitu-prod',
            script: 'dist/server.js',
            instances: 1, // Use all available CPUs
            exec_mode: 'cluster', // Cluster mode
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
            instances: 1, // Single instance for dev/staging
            exec_mode: 'fork',
            autorestart: true,
            watch: true, // Enable watch mode
            ignore_watch: ["node_modules", "logs"],
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'development',
            }
        }
    ]
};
