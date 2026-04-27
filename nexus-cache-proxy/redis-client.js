// cache-proxy/redis-client.js
'use strict';

const Redis = require('ioredis');
// redis-client.js
const client = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  // remove lazyConnect
});

client.on('connect', () => console.log('[Redis] Connected'));
client.on('error', (err) => console.error('[Redis] Error:', err.message));

module.exports = client;