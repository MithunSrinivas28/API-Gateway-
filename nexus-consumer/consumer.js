// consumer.js
// Standalone Kafka consumer service for Nexus.
// Listens to all gateway event topics and automates actions:
//   - gateway.rate_limit.hit   → track and auto-block repeat offenders
//   - gateway.circuit.opened   → alert on upstream failures
//   - gateway.request.completed → anomaly detection (latency spikes)

const { Kafka, logLevel } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'nexus-consumer',
  brokers: ['localhost:9092'],
  logLevel: logLevel.WARN,
});

const consumer = kafka.consumer({
  groupId: 'nexus-consumer-group',
});

// ─── State ────────────────────────────────────────────────────────────────────

// Track how many times each IP has hit the rate limit
// In production this would be Redis — in-memory is fine for dev
const rateLimitHits = new Map();

// IPs that have been auto-blocked
const blockedIPs = new Set();

// Latency baseline for anomaly detection (simple rolling average)
const latencyWindow = [];
const LATENCY_WINDOW_SIZE = 50;
const LATENCY_SPIKE_MULTIPLIER = 3; // flag if latency > 3x average

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleRateLimitHit(payload) {
  const { ip, method, url } = payload;

  const hits = (rateLimitHits.get(ip) ?? 0) + 1;
  rateLimitHits.set(ip, hits);

  console.log(`[rate-limit] ${ip} hit rate limit (total: ${hits}) — ${method} ${url}`);

  // Auto-block after 5 consecutive rate limit hits
  if (hits >= 5 && !blockedIPs.has(ip)) {
    blockedIPs.add(ip);
    console.warn(`[ACTION] AUTO-BLOCKED IP: ${ip} after ${hits} rate limit violations`);
    // In Phase 5 this would push to Redis so the gateway reads it on next request
  }
}

function handleCircuitOpened(payload) {
  const { upstream, method, url } = payload;
  // In production: page on-call, send Slack/PagerDuty alert
  console.error(`[ACTION] ALERT — Circuit opened for upstream: ${upstream} | triggered by ${method} ${url}`);
}

function handleRequestCompleted(payload) {
  const { method, url, statusCode, latencyMs, clientId } = payload;
  const latency = parseFloat(latencyMs);

  // Maintain rolling window
  latencyWindow.push(latency);
  if (latencyWindow.length > LATENCY_WINDOW_SIZE) latencyWindow.shift();

  // Compute average once we have enough data
  if (latencyWindow.length === LATENCY_WINDOW_SIZE) {
    const avg = latencyWindow.reduce((a, b) => a + b, 0) / LATENCY_WINDOW_SIZE;

    if (latency > avg * LATENCY_SPIKE_MULTIPLIER) {
      console.warn(
        `[ACTION] LATENCY SPIKE — ${method} ${url} took ${latency}ms ` +
        `(avg: ${avg.toFixed(2)}ms, threshold: ${(avg * LATENCY_SPIKE_MULTIPLIER).toFixed(2)}ms) ` +
        `| client: ${clientId}`
      );
    }
  }

  console.log(`[request] ${method} ${url} → ${statusCode} in ${latencyMs}ms | client: ${clientId}`);
}

// ─── Router ───────────────────────────────────────────────────────────────────

function route(topic, payload) {
  switch (topic) {
    case 'gateway.rate_limit.hit':
      return handleRateLimitHit(payload);
    case 'gateway.circuit.opened':
      return handleCircuitOpened(payload);
    case 'gateway.request.completed':
      return handleRequestCompleted(payload);
    default:
      console.warn(`[consumer] unknown topic: ${topic}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  await consumer.connect();
  console.log('[kafka] consumer connected');

  await consumer.subscribe({
    topics: [
      'gateway.rate_limit.hit',
      'gateway.circuit.opened',
      'gateway.request.completed',
    ],
    fromBeginning: true, // replay all events on first start
  });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const payload = JSON.parse(message.value.toString());
        route(topic, payload);
      } catch (err) {
        console.error(`[consumer] failed to process message on ${topic}:`, err.message);
      }
    },
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal) => {
  console.log(`\n[consumer] received ${signal}, shutting down...`);
  await consumer.disconnect();
  console.log('[consumer] disconnected');
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

run().catch((err) => {
  console.error('[consumer] fatal error:', err);
  process.exit(1);
});