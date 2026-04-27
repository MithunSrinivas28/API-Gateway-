// cache-proxy/index.js
'use strict';

const { createServer } = require('./server');
const redisClient = require('./redis-client');

const PORT = process.env.PROXY_PORT || 6380;
const HOST = process.env.PROXY_HOST || '127.0.0.1';

async function start() {
  await redisClient.connect();

  const server = createServer();

  server.listen(PORT, HOST, () => {
    console.log(`[proxy] TCP server listening on ${HOST}:${PORT}`);
  });

  server.on('error', (err) => {
    console.error('[proxy] server error:', err.message);
    process.exit(1);
  });
}

start();