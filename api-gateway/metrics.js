'use strict';

const client = require('prom-client');

// ── Registry ──────────────────────────────────────────────────────────────────
// Using a custom registry (not the global default) keeps our metrics isolated
// and prevents conflicts if any library registers its own default metrics.
const register = new client.Registry();

// Collect default Node.js metrics (event loop lag, heap, GC, etc.)
client.collectDefaultMetrics({ register, prefix: 'nexus_' });

// ── Counters ──────────────────────────────────────────────────────────────────
const httpRequestsTotal = new client.Counter({
  name:       'nexus_http_requests_total',
  help:       'Total number of HTTP requests received',
  labelNames: ['method', 'route', 'status_code'],
  registers:  [register],
});

const rateLimitHitsTotal = new client.Counter({
  name:      'nexus_rate_limit_hits_total',
  help:      'Total number of requests rejected by rate limiter',
  labelNames: ['ip'],
  registers:  [register],
});

const circuitBreakerOpensTotal = new client.Counter({
  name:       'nexus_circuit_breaker_opens_total',
  help:       'Total number of times a circuit breaker opened',
  labelNames: ['upstream'],
  registers:  [register],
});

// ── Histograms ────────────────────────────────────────────────────────────────
// Buckets chosen to give useful resolution across the expected latency range
// of a local proxy: sub-ms to ~2s.
const httpRequestDurationMs = new client.Histogram({
  name:       'nexus_http_request_duration_ms',
  help:       'HTTP request latency in milliseconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets:    [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
  registers:  [register],
});

const upstreamRequestDurationMs = new client.Histogram({
  name:       'nexus_upstream_request_duration_ms',
  help:       'Upstream proxy call latency in milliseconds',
  labelNames: ['upstream', 'method', 'status_code'],
  buckets:    [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000],
  registers:  [register],
});

// ── Gauges ────────────────────────────────────────────────────────────────────
const circuitBreakerState = new client.Gauge({
  name:       'nexus_circuit_breaker_state',
  help:       'Circuit breaker state per upstream (0=closed, 1=open, 2=half-open)',
  labelNames: ['upstream'],
  registers:  [register],
});

module.exports = {
  register,
  httpRequestsTotal,
  rateLimitHitsTotal,
  circuitBreakerOpensTotal,
  httpRequestDurationMs,
  upstreamRequestDurationMs,
  circuitBreakerState,
};