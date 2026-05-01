require('./tracing');   // ← MUST be line 1; instruments http before Fastify loads
'use strict';
// ── OpenTelemetry API ─────────────────────────────────────────────────────────
const {
  trace,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
} = require('@opentelemetry/api');

const tracer = trace.getTracer('nexus-gateway', '1.0.0');
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
const { emitEvent } = require('./kafka/producer');
const {
  register,
  httpRequestsTotal,
  rateLimitHitsTotal,
  circuitBreakerOpensTotal,
  httpRequestDurationMs,
  upstreamRequestDurationMs,
  circuitBreakerState,
} = require('./metrics');
const { connectProducer, disconnectProducer } = require('./kafka/producer');
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
fastify.addHook('onRequest', async (req, reply) => {
  // ── 1. Extract incoming trace context (if upstream already started a trace)
  const parentCtx = propagation.extract(context.active(), req.headers);

  // ── 2. Start the root SERVER span for this request
  const span = tracer.startSpan(
    `${req.method} ${req.routeOptions?.url || req.url}`,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'http.method':     req.method,
        'http.url':        req.url,
        'http.route':      req.routeOptions?.url || req.url,
      },
    },
    parentCtx,
  );

  // ── 3. Store span + active context on the request object for child spans
  req.otelSpan = span;
  req.otelCtx  = trace.setSpan(parentCtx, span);

  // ── 4. Bind trace/span IDs to every Pino log line for this request
  const { traceId, spanId } = span.spanContext();
  req.log = req.log.child({ trace_id: traceId, span_id: spanId });
  req.log.info({ url: req.url, method: req.method }, 'request started');
  // ... rest of your existing onRequest logic continues below
});
fastify.addHook('onRequest', async (request, reply) => {
  const ip = request.ip;

  if (!isAllowed(ip)) {
    emitEvent('gateway.rate_limit.hit', {
      ip,
      method: request.method,
      url: request.url,
    });
    rateLimitHitsTotal.inc({ ip });
    return reply.code(429).send({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Try again shortly.'
    });
  }

 const publicPaths = ['/auth/token', '/health', '/metrics'];
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

fastify.addHook('onResponse', async (request, reply) => {
  // ── Close the root OTel span ──────────────────────────────────────────────
  if (request.otelSpan) {
    request.otelSpan.setAttribute('http.status_code', reply.statusCode);
    request.otelSpan.setStatus(
      reply.statusCode >= 500
        ? { code: 2 }
        : { code: 1 }
    );
    request.otelSpan.end();
  }

  // ── Prometheus metrics ────────────────────────────────────────────────────
  const route = request.routeOptions?.url || request.url;
  httpRequestsTotal.inc({
    method:      request.method,
    route,
    status_code: reply.statusCode,
  });
  httpRequestDurationMs.observe(
    { method: request.method, route, status_code: reply.statusCode },
    parseFloat(reply.elapsedTime),
  );

  // ── Telemetry + Kafka ─────────────────────────────────────────────────────
  const decoded = request.user || null;
  const clientId = decoded ? decoded.client_id : 'anonymous';
  const latencyMs = reply.elapsedTime.toFixed(2);

  telemetry.record({
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    latencyMs,
    ip: request.ip,
    clientId,
  });

  if (request.url.startsWith('/api/')) {
    emitEvent('gateway.request.completed', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      latencyMs,
      ip: request.ip,
      clientId,
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
  const clientId = decoded ? decoded.client_id : 'anonymous';
  const latencyMs = reply.elapsedTime.toFixed(2);

  telemetry.record({
    method: request.method,
    url: request.url,
    statusCode: reply.statusCode,
    latencyMs,
    ip: request.ip,
    clientId,
  });

  // Only emit for proxied API routes, skip internal paths
  if (request.url.startsWith('/api/')) {
    emitEvent('gateway.request.completed', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      latencyMs,
      ip: request.ip,
      clientId,
    });
  }
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
fastify.get('/metrics', async (request, reply) => {
  reply.header('content-type', register.contentType);
  return register.metrics();
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

      // Inject W3C traceparent into outgoing headers so upstream
      // spans appear as children of this trace in Jaeger
      const outgoingHeaders = {
        ...request.headers,
        host:                targetUrl.host,
        'x-forwarded-for':   request.ip,
        'x-forwarded-host':  request.hostname,
        'x-forwarded-proto': 'http',
      };
      if (request.otelCtx) {
        propagation.inject(request.otelCtx, outgoingHeaders);
      }

      const options = {
        method:   request.method,
        hostname: targetUrl.hostname,
        port:     targetUrl.port || 80,
        path:     targetUrl.pathname.replace(/^\/api/, '') + targetUrl.search,
        headers:  outgoingHeaders,
      };

      const { options: transformedOptions, requestId } = transformRequest(options, request);

      // ── CLIENT span wraps the entire upstream http call ───────────────────
      const upstreamSpan = tracer.startSpan('upstream.proxy', {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.method':  request.method,
          'http.url':     targetUrl.href,
          'peer.service': server.url,
        },
      }, request.otelCtx);
      const upstreamCtx = trace.setSpan(request.otelCtx, upstreamSpan);
      const upstreamStart = Date.now();
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

        upstreamSpan.setAttribute('http.status_code', proxyRes.statusCode);
          upstreamSpan.setStatus({ code: proxyRes.statusCode >= 500 ? 2 : 1 });
          upstreamSpan.end();
          upstreamRequestDurationMs.observe(
            {
              upstream:    server.url,
              method:      request.method,
              status_code: proxyRes.statusCode,
            },
            Date.now() - upstreamStart,
          );
          lb.release(server);
          resolve();
        });

        proxyReq.on('error', (err) => {
          upstreamSpan.recordException(err);
          upstreamSpan.setStatus({ code: 2 });
          upstreamSpan.end();
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
        emitEvent('gateway.circuit.opened', {
          upstream: server.url,
          method: request.method,
          url: request.url,
        });
        circuitBreakerOpensTotal.inc({ upstream: server.url });
        circuitBreakerState.set({ upstream: server.url }, 1);
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
  await disconnectProducer();
  await fastify.close();
  fastify.log.info('Server closed. Exiting.');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

fastify.listen({ port: 3000, host: '0.0.0.0' })
  .then(async (address) => {
    await connectProducer();
    console.log(`API Gateway running at ${address}`);
  })
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

