const fastify = require('fastify')({ logger: true });
const httpProxy = require('@fastify/http-proxy');
const fjwt = require('@fastify/jwt');
const { isAllowed } = require('./rateLimiter');
const { validateClient } = require('./auth');
const telemetry = require('./telemetry');

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

fastify.register(httpProxy, {
  upstream: 'http://127.0.0.1:3001',
  prefix: '/api',
  rewritePrefix: '',
  http2: false
});

fastify.get('/health', async (request, reply) => {
  return { status: 'gateway-ok', timestamp: new Date().toISOString() };
});

fastify.get('/telemetry', async (request, reply) => {
  return telemetry.getLogs();
});

// Graceful shutdown
const shutdown = async (signal) => {
  fastify.log.info(`Received ${signal}. Shutting down gracefully...`);
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