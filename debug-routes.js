const express = require('express');
const appModule = require('./dist/app');
const app = appModule.default || appModule;
const rateLimitMiddleware = require('./dist/middlewares/rateLimitMiddleware');

console.log('--- Control Test ---');
const controlApp = express();
controlApp.use((req, res, next) => next());
console.log('Control App _router type:', typeof controlApp._router);
if (controlApp._router) {
    console.log('Control App logic works. _router is present.');
}

console.log('\n--- Imported App Test ---');
console.log('Imported App _router type:', typeof app._router);
console.log('Imported app.mountpath:', app.mountpath);

console.log('\n--- Middleware Check ---');
console.log('authRateLimiter type:', typeof rateLimitMiddleware.authRateLimiter);

try {
    const http = require('http');
    const server = http.createServer(app);
    console.log('Server created successfully with imported app.');
    // We won't listen, just validating it doesn't crash
} catch (e) {
    console.error('Failed to create server:', e);
}
