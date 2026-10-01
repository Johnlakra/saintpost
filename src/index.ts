// Safety net: a bug inside a third-party library must never take the whole bot down mid-video.
process.on('uncaughtException', err => console.error('💥 Uncaught exception (kept running):', err));
process.on('unhandledRejection', err => console.error('💥 Unhandled rejection (kept running):', err));

import './server.js';
