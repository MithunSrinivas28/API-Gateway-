const fastify = require('fastify')({ logger: true });
const http = require('http');
const LoadBalancer = require('./load-balancer');
const { getBreaker, getBreakerStats } = require('./circuit-breaker');
const { withRetry } = require('./retry');
const { transformRequest, transformResponse } = require('./transformer');
const { startDiscovery } = require('./discovery');
const fjwt = require('@fastify/jwt');
const { isAllowed } = require('./rateLimiter');
const { validateClient } = require('./auth');
const telemetry = require('./telemetry');

const lb = new LoadBalancer(
  [
    { url: 'http://127.0.0.1:3001', weight: 2 },
    { url: 'http://127.0.0.1:3002', weight: 1 },
  ],
  'round-robin'
);

fastify.register(fjwt, {
  secret: 'gateway-super-secret-key-do-not-expose'
});

fastify.addHook('onRequest', async (request, reply) => {
  const ip = request.ip;

  if (!isAllowed(ip)) {
    return reply.code(429).send({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Try again shortly.'
    });
  }

  const publicPaths = ['/auth/token', '/health'];
  if (publicPaths.includes(request.url)) return;

  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Invalid or missing token.'
    });
  }
});

// Propagate real client IP to upstream
fastify.addHook('preHandler', async (request, reply) => {
  request.headers['x-forwarded-for'] = request.ip;
  request.headers['x-gateway-timestamp'] = new Date().toISOString();
});

fastify.addHook('onResponse', async (request, reply) => {
  const decoded = request.user || null;

  telemetry.record({
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    latencyMs: reply.elapsedTime.toFixed(2),
    ip: request.ip,
    clientId: decoded ? decoded.client_id : 'anonymous'
  });
});

fastify.post('/auth/token', async (request, reply) => {
  const { client_id, client_secret } = request.body;

  if (!client_id || !client_secret) {
    return reply.code(400).send({ error: 'client_id and client_secret are required.' });
  }

  if (!validateClient(client_id, client_secret)) {
    return reply.code(401).send({ error: 'Invalid client credentials.' });
  }

  const token = await reply.jwtSign(
    { client_id },
    { expiresIn: '1h' }
  );

  return { access_token: token, token_type: 'Bearer', expires_in: 3600 };
});
fastify.get('/lb-stats', async () => lb.getStats());
fastify.get('/cb-stats', async () => getBreakerStats());
fastify.all('/api/*', async (request, reply) => {
  try {
    await withRetry(async (attempt) => {
      let server;

      try {
        server = lb.pick();
      } catch (err) {
        throw err;
      }

      lb.acquire(server);

      const targetUrl = new URL(request.url, server.url);

      const options = {
        method:   request.method,
        hostname: targetUrl.hostname,
        port:     targetUrl.port || 80,
        path:     targetUrl.pathname.replace(/^\/api/, '') + targetUrl.search,
        headers: {
          ...request.headers,
          host:                targetUrl.host,
          'x-forwarded-for':   request.ip,
          'x-forwarded-host':  request.hostname,
          'x-forwarded-proto': 'http',
        },
      };

      const { options: transformedOptions, requestId } = transformRequest(options, request);
      const action = () => new Promise((resolve, reject) => {
       const proxyReq = http.request(transformedOptions, async (proxyRes) => {
          const HOP_BY_HOP = new Set([
            'connection', 'keep-alive', 'transfer-encoding',
            'te', 'upgrade', 'trailer', 'proxy-authorization', 'proxy-authenticate'
          ]);

          reply.code(proxyRes.statusCode);
          for (const [key, val] of Object.entries(proxyRes.headers)) {
            if (!HOP_BY_HOP.has(key.toLowerCase())) reply.header(key, val);
          }

          const transformed = await transformResponse(proxyRes, requestId);
          if (transformed) {
            reply.header('content-type', 'application/json');
            reply.send(transformed);
          } else {
            reply.send(proxyRes);
          }

          lb.release(server);
          resolve();
        });

        proxyReq.on('error', (err) => {
          lb.release(server);
          reject(err);
        });

        if (request.body) {
          const body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
          proxyReq.setHeader('content-length', Buffer.byteLength(body));
          proxyReq.write(body);
        }

        proxyReq.end();
      });

      const breaker = getBreaker(server.url);
      breaker.fallback(() => {
  lb.release(server);
  throw new Error(`Circuit open for ${server.url}`);
});

      await breaker.fire(action);

      if (attempt > 1) {
        fastify.log.info({ attempt, upstream: server.url }, 'Request succeeded after retry');
      }

    }, {
      maxAttempts: 3,
      delayMs: 200,
      onRetry: (attempt, err) => {
        fastify.log.warn({ attempt, err: err.message }, 'Upstream failed, retrying...');
      }
    });

  } catch (err) {
    fastify.log.error({ err }, 'All retry attempts failed');
    if (!reply.sent) {
      reply.code(502).send({ error: 'Bad Gateway', message: 'All upstream attempts failed' });
    }
  }
});
fastify.get('/health', async (request, reply) => {
  return { status: 'gateway-ok', timestamp: new Date().toISOString() };
});

fastify.get('/telemetry', async (request, reply) => {
  return telemetry.getLogs();
});

// Graceful shutdown
const stopDiscovery = startDiscovery(lb, fastify.log);

const shutdown = async (signal) => {
  fastify.log.info(`Received ${signal}. Shutting down gracefully...`);
  stopDiscovery();
  await fastify.close();
  fastify.log.info('Server closed. Exiting.');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

fastify.listen({ port: 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  console.log(`API Gateway running at ${address}`);
});