// cache-proxy/server.js
'use strict';

const net = require('net');
const { RespParser } = require('./resp/parser');
const { serialize } = require('./resp/serializer');
const redisClient = require('./redis-client');

function createServer() {
  const server = net.createServer((socket) => {
    const parser = new RespParser();
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[proxy] client connected: ${addr}`);

    parser.on('command', async (parsed) => {
      try {
        // Commands arrive as RESP arrays e.g. ['SET', 'foo', 'bar']
        if (parsed.type !== 'array' || !parsed.value) {
          socket.write(serialize({ type: 'error', value: 'ERR invalid command format' }));
          return;
        }

        // Extract raw string args from bulk_string elements
        const args = parsed.value.map((el) => el.value);
        const [command, ...rest] = args;

        // Forward to real Redis using ioredis call method
        const result = await redisClient.call(command, ...rest);

        // Build response based on what ioredis returned
        let response;
        if (result === null) {
          response = { type: 'bulk_string', value: null };
        } else if (typeof result === 'number') {
          response = { type: 'integer', value: result };
        } else if (Array.isArray(result)) {
          response = {
            type: 'array',
            value: result.map((r) => ({ type: 'bulk_string', value: r })),
          };
        } else {
          response = { type: 'bulk_string', value: String(result) };
        }

        socket.write(serialize(response));
      } catch (err) {
        socket.write(serialize({ type: 'error', value: `ERR ${err.message}` }));
      }
    });

    parser.on('error', (err) => {
      console.error(`[proxy] parse error from ${addr}:`, err.message);
      socket.write(serialize({ type: 'error', value: `ERR ${err.message}` }));
      socket.destroy();
    });

    socket.on('data', (chunk) => parser.feed(chunk));

    socket.on('close', () => {
      console.log(`[proxy] client disconnected: ${addr}`);
      parser.reset();
    });

    socket.on('error', (err) => {
      console.error(`[proxy] socket error from ${addr}:`, err.message);
      parser.reset();
    });
  });

  return server;
}

module.exports = { createServer };