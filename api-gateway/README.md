# Nexus — API Gateway + Intelligent Cache Proxy

> A distributed backend system built from first principles.

---

## What Is This?

Nexus is a distributed backend system built from first principles — an API Gateway layered with an Intelligent Cache Proxy, written entirely in Node.js.

It covers the full request lifecycle: from a client hitting the gateway, through authentication, rate limiting, and load balancing, across a TCP-based cache proxy that speaks Redis's binary protocol, all the way to the upstream service. Every layer has one job. Every design decision has a reason.

---

## System Architecture

```
Client
  │
  ▼
┌──────────────────────────────────────────────────┐
│              API Gateway  (Port 3000)            │
│                                                  │
│  onRequest   → Token Bucket Rate Limiter         │
│              → JWT Verifier (HS256)              │
│                                                  │
│  preHandler  → Header Injection                  │
│                                                  │
│  Proxy       → Load Balancer (RR / LC / WRR)    │
│              → Circuit Breaker (opossum)         │
│              → Retry Engine (withRetry)          │
│              → Request Transformer               │
│              → /api/* → Upstream Pool            │
│                                                  │
│  onResponse  → Response Transformer              │
│              → Telemetry Logger                  │
│                                                  │
│  Discovery   → services.json poller (5s)        │
└──────────────┬──────────────────┬───────────────┘
               │                  │
               ▼                  ▼
     ┌──────────────┐   ┌──────────────┐
     │  Mock 3001   │   │  Mock 3002   │
     │  /products   │   │  /products   │
     │  /health     │   │  /health     │
     └──────────────┘   └──────────────┘

┌──────────────────────────────────────────────────┐
│           Cache Proxy  (Port 6380)               │
│                                                  │
│  TCP Server  → RESP Parser                       │
│              → Policy Engine (YAML)              │
│              → Singleflight Guard                │
│              → Hot Key Detector                  │
│              → Tag Invalidation (Lua)            │
│              → RESP Serializer                   │
└──────────────────────┬───────────────────────────┘
                       │
                       ▼
                 Redis  (Port 6379)
```

Each layer has one job and one job only. The gateway enforces policy and routing. The proxy manages cache intelligence. Redis stores data. The mock services represent any upstream you'd put behind this in production.

---

## Phase 1 — API Gateway

The gateway is the public face of the system. Every request passes through it. Nothing reaches the upstream without the gateway's approval.

### Token Bucket Rate Limiting

Built from scratch. No library. Each IP gets a bucket with **10 tokens** that refills at **2 tokens per second**. The math on every request:

```
tokens = min(capacity, tokens + (Δt × refillRate))
```

This runs in **O(1)** — a single Map lookup and a subtraction. It fires at `onRequest`, the earliest possible lifecycle point in Fastify. A rejected request never touches the router, the proxy, or the upstream. It's dead before it costs anything.

Real numbers from a stress test:
```
429 response → 0.38ms   ← killed at onRequest
200 response → 5–7ms    ← full round-trip
```

### JWT Authentication (HS256)

The `/auth/token` endpoint validates `client_id` + `client_secret` and returns a signed JWT. Every downstream request carries it as `Authorization: Bearer <token>`. Verification is **pure CPU** — recomputing HMAC-SHA256 costs nanoseconds and requires zero I/O. No session store. No database lookup. Scales linearly with CPU.

### Request Telemetry

Every request — whether it succeeds, gets rate-limited, or fails auth — is logged with full context at `onResponse`. That hook fires after the reply is flushed, so latency and status codes are finalized before they're recorded.

```
GET /api/products → 200 → 6.2ms  → client: gateway-client → ip: 127.0.0.1
POST /auth/token  → 401 → 0.9ms  → client: anonymous
GET /api/products → 429 → 0.38ms → client: anonymous → rate limited
```

Inspect everything live at `GET /telemetry`.

### Request Lifecycle

```
Incoming Request
      │
      ▼
 onRequest    → [1] Rate limit check  → 429 if exhausted
              → [2] JWT verification  → 401 if invalid
      │
      ▼
 preHandler   → Inject X-Forwarded-For + X-Gateway-Timestamp
      │
      ▼
 handler      → Proxy to upstream
      │
      ▼
 onResponse   → Record telemetry (latency now finalized)
```

The ordering is intentional. Authentication and rate limiting fire before routing — rejected requests burn zero upstream resources.

---

## Phase 2 — Intelligent Cache Proxy

The cache proxy is a **TCP server** that sits between the gateway and Redis. It speaks RESP — the same binary protocol Redis itself speaks — which means any Redis client can point at it transparently.

This isn't a caching layer bolted onto HTTP. It operates at the protocol level. It reads raw bytes off a socket, parses them into commands, applies intelligent policy, and either responds from cache or forwards to real Redis.

### Why TCP, Not HTTP?

Redis uses RESP (REdis Serialization Protocol) over raw TCP. There's no HTTP envelope, no headers, no JSON. To proxy Redis transparently, you must speak the same protocol. The `net` module gives exactly that — a raw socket you read bytes from and write bytes to.

### RESP Protocol Parser

TCP has no concept of message boundaries. `SET foo bar` might arrive as 3 separate `data` events. The parser maintains an internal byte buffer, accumulates incoming chunks, and only emits a complete command when every required byte has arrived.

It handles all 5 RESP types:

| Prefix | Type          | Example                          |
|--------|---------------|----------------------------------|
| `+`    | Simple String | `+OK\r\n`                        |
| `-`    | Error         | `-ERR unknown command\r\n`       |
| `:`    | Integer       | `:1000\r\n`                      |
| `$`    | Bulk String   | `$6\r\nfoobar\r\n`               |
| `*`    | Array         | `*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n` |

Bulk strings are read by byte count, not by scanning for `\r\n`. This makes the parser binary-safe — a value can contain newlines (like a JSON blob) and the parser handles it correctly.

### YAML Policy Engine

Caching rules are declared in a YAML file, not hardcoded. Change which commands get cached, their TTL, and whether caching is enabled — without touching a single line of proxy code.

```yaml
policies:
  - match: GET
    ttl: 60
    enabled: true
  - match: SET
    ttl: 0
    enabled: false
```

### Singleflight Request Deduplication

Without this, a cache miss under high traffic creates a **thundering herd** — every concurrent request for the same uncached key fires its own Redis call simultaneously.

Singleflight collapses all duplicate in-flight requests for the same key into one. The first request fires. Everyone else waits on the same promise. One Redis call. One result returned to all waiters.

```
100 concurrent GET requests for "product:1" (cache miss)
→ Without singleflight: 100 Redis calls
→ With singleflight:      1 Redis call, 100 responses
```

### Tag-Based Cache Invalidation

Keys are grouped under tags. Invalidating a tag deletes all associated keys in a single atomic operation using a Lua script inside Redis.

**Why Lua?** Lua scripts run atomically inside Redis. No other command can interrupt mid-execution. This prevents partial invalidation — the scenario where some keys get deleted and others don't under concurrent requests.

```
tagKey('products', 'product:1')
tagKey('products', 'product:2')

invalidateTag('products')
→ product:1 deleted
→ product:2 deleted
→ tag:products deleted
```

### Hot Key Detection + TTL Adjustment

The proxy tracks how many times each key is accessed. When a key crosses a hit threshold, it's considered "hot" and its TTL is automatically extended.

Hot keys expire at the worst possible time — when they're being hit the hardest. Detecting and extending their TTL keeps the most valuable data warm without any manual intervention. Cold keys expire naturally. Hot keys stay cached.

```
product:1 → hit 10 times → TTL was 60s → TTL becomes 180s
```

---

## Phase 3 — Gateway Enhancements

Phase 3 extends the gateway from a simple proxy into a resilient traffic management layer. It adds load balancing across multiple upstreams, automatic failure detection and recovery, transparent retry logic, response shaping, and live service discovery — all without restarting the process.

### Load Balancing

The gateway maintains a pool of upstream servers. On each request, `lb.pick()` selects one using the configured algorithm. Three algorithms are supported:

**Round-Robin** — cycles through servers sequentially. No state beyond a cursor index. O(1) per pick.

**Least Connections** — routes to whichever server has the fewest active in-flight requests. Requires per-server counters updated via `lb.acquire()` before the request and `lb.release()` in the finally path.

**Weighted Round-Robin** — GCD-reduces the weight list into a flat sequence. A weight-2 server appears twice for every one time a weight-1 server appears. No float math.

```
servers: [{ url: '3001', weight: 2 }, { url: '3002', weight: 1 }]
WRR sequence: ['3001', '3001', '3002']
```

Each server tracks `activeConnections`, `requestsHandled`, and `healthy` state. Inspect live at `GET /lb-stats`.

### Circuit Breaker

Wraps each upstream in a state machine with three states:

```
         failures > threshold
  CLOSED ──────────────────► OPEN
    ▲                          │
    │      test succeeds       │ resetTimeout elapsed
    └──── HALF-OPEN ◄──────────┘
               │
               │ test fails
               ▼
             OPEN
```

- **Closed** — requests flow normally
- **Open** — breaker trips, requests fast-fail immediately without attempting a connection
- **Half-Open** — after `resetTimeout` (10s), one test request is allowed through

Configuration:
```
timeout:                  5000ms   ← upstream must respond within this
errorThresholdPercentage: 50%      ← trip open if 50% of requests fail
resetTimeout:             10000ms  ← stay open for 10s then half-open
volumeThreshold:          3        ← need at least 3 requests before tripping
```

One breaker instance per upstream URL. Inspect state at `GET /cb-stats`.

### Retry Engine

When an upstream call fails, the request is retried on a freshly picked server before returning an error to the client. Because `lb.pick()` is called on each attempt, retries naturally land on a different upstream.

```
Attempt 1 → 3002 (circuit open) → fail
  wait 200ms
Attempt 2 → 3001 (healthy)      → 200 OK ← client sees this
```

The client receives a 200. The failure is invisible. Latency reflects the retry delay (200ms) plus the successful request time.

A 502 is only returned if all `maxAttempts` (3) are exhausted.

### Request/Response Transformation

Every request is mutated before hitting the upstream. Every JSON response is wrapped before reaching the client. No upstream needs to know about it.

**Request** — injects tracing headers, strips forbidden internal headers:
```
x-request-id:      nexus-<timestamp>-<random>
x-gateway-version: 1.0.0
x-internal-secret: [stripped]
x-admin-override:  [stripped]
```

**Response** — wraps JSON payloads with gateway metadata:
```json
{
  "data": { ...upstream response... },
  "_meta": {
    "requestId": "nexus-1777322108070-hqu2e",
    "gateway": "nexus",
    "timestamp": "2026-04-27T20:35:08.090Z"
  }
}
```

Non-JSON responses (binary, plain text) are passed through untouched.

### Service Discovery

Upstreams are read from `services.json`, not hardcoded. A background poller re-reads the file every 5 seconds and diffs the current pool against the last known state.

- New URL in file → `lb.markHealthy(url)` — added to rotation live
- URL removed from file → `lb.markUnhealthy(url)` — pulled from rotation live

No restart. No downtime. Edit the file and the gateway converges within 5 seconds.

```json
{
  "services": [
    { "url": "http://127.0.0.1:3001", "weight": 2 },
    { "url": "http://127.0.0.1:3002", "weight": 1 }
  ]
}
```

The poller is cleaned up on graceful shutdown via a returned `stopDiscovery()` function.

### Phase 3 Request Lifecycle

```
Incoming Request
      │
      ▼
 onRequest    → [1] Rate limit check  → 429 if exhausted
              → [2] JWT verification  → 401 if invalid
      │
      ▼
 preHandler   → Inject X-Forwarded-For + X-Gateway-Timestamp
      │
      ▼
 handler      → withRetry (up to 3 attempts)
                  │
                  ▼
               lb.pick()             → 503 if no healthy servers
                  │
                  ▼
               transformRequest()    → inject x-request-id, strip headers
                  │
                  ▼
               breaker.fire(action)  → fast-fail if circuit open
                  │
                  ▼
               http.request()        → upstream call
                  │
                  ▼
               transformResponse()   → wrap JSON with _meta
                  │
                  ▼
               lb.release()          → decrement activeConnections
      │
      ▼
 onResponse   → Record telemetry
```

---

## File Structure

```
nexus/
│
├── api-gateway/
│   ├── server.js           ← hooks, routes, proxy, graceful shutdown
│   ├── load-balancer.js    ← round-robin, least-conn, weighted RR
│   ├── circuit-breaker.js  ← opossum wrapper, per-upstream state machine
│   ├── retry.js            ← withRetry — configurable attempts + delay
│   ├── transformer.js      ← request/response transformation
│   ├── discovery.js        ← services.json poller, live pool sync
│   ├── services.json       ← upstream registry
│   ├── rateLimiter.js      ← token bucket (pure in-memory Map)
│   ├── auth.js             ← client credential store + validation
│   └── telemetry.js        ← request log + /telemetry endpoint
│
├── mock-service/
│   ├── server.js           ← upstream mock 1: /products, /health (3001)
│   └── mock2.js            ← upstream mock 2: /products, /health (3002)
│
└── nexus-cache-proxy/
    ├── index.js            ← entry point, boots TCP server + Redis client
    ├── server.js           ← TCP server, connection lifecycle, dispatch
    ├── redis-client.js     ← single shared ioredis instance
    ├── policy.js           ← loads and queries YAML policy
    ├── policy.yaml         ← cache rules per command
    ├── singleflight.js     ← in-flight request deduplication
    ├── invalidation.js     ← tag-based cache invalidation
    ├── invalidate.lua      ← atomic Lua deletion script
    ├── hotkey.js           ← hit tracking + TTL extension
    └── resp/
        ├── parser.js       ← stateful streaming RESP decoder
        └── serializer.js   ← RESP encoder
```

---

## Getting Started

**Prerequisites:** Node.js v18+, Docker

### 1. Start Redis

```bash
docker run -d -p 6379:6379 redis
```

### 2. Run Mock Services

```bash
cd mock-service
npm install
node server.js        # port 3001
node mock2.js         # port 3002 (separate terminal)
```

### 3. Run API Gateway

```bash
cd api-gateway
npm install
node server.js        # port 3000
```

### 4. Run Cache Proxy

```bash
cd nexus-cache-proxy
npm install
node index.js         # port 6380
```

---

## Usage

### Get an Access Token

```bash
curl -X POST http://localhost:3000/auth/token \
  -H "Content-Type: application/json" \
  -d '{"client_id": "gateway-client", "client_secret": "supersecret123"}'
```

### Hit a Protected Route

```bash
curl http://localhost:3000/api/products \
  -H "Authorization: Bearer <your_token>"
```

### Check Load Balancer State

```bash
curl http://localhost:3000/lb-stats \
  -H "Authorization: Bearer <your_token>"
```

### Check Circuit Breaker State

```bash
curl http://localhost:3000/cb-stats \
  -H "Authorization: Bearer <your_token>"
```

### Test the Cache Proxy Directly

```bash
redis-cli -p 6380 SET foo bar
redis-cli -p 6380 GET foo
```

### Inspect Telemetry

```bash
curl http://localhost:3000/telemetry \
  -H "Authorization: Bearer <your_token>"
```

---

## Port Map

| Service      | Port |
|--------------|------|
| API Gateway  | 3000 |
| Mock 1       | 3001 |
| Mock 2       | 3002 |
| Cache Proxy  | 6380 |
| Redis        | 6379 |

---

## Key Design Decisions

**Why `onRequest` for rate limiting and auth?**
It's the earliest Fastify lifecycle hook — before body parsing, before routing. A rejected request at this stage costs microseconds. Putting these checks later wastes cycles on requests that were never going to succeed.

**Why token bucket over fixed-window counters?**
Fixed windows punish users for timing. A burst at 11:59:59 and another at 12:00:01 count as two separate windows despite being 2 seconds apart. Token bucket accumulates allowance over real elapsed time and tolerates natural bursts while enforcing a true average rate.

**Why `0.0.0.0` on the gateway but `127.0.0.1` on the mock services?**
The gateway is the public entry point — it binds to all interfaces. Mock services should never be directly reachable from outside. Binding to loopback enforces that at the network level, not just in code.

**Why replace `@fastify/http-proxy` with a manual proxy?**
`@fastify/http-proxy` hardcodes a single upstream at registration time. Load balancing requires selecting the upstream *per request*, at runtime. Once you need that control, you own the proxy logic.

**Why one circuit breaker per upstream URL?**
A single breaker across all upstreams would trip because of failures on one server, cutting off healthy ones. Isolating breakers means a failing 3002 only affects traffic routed to 3002. 3001 keeps running uninterrupted.

**Why does the retry loop call `lb.pick()` on each attempt?**
Retrying the same server that just failed makes no sense. Calling `lb.pick()` fresh each time lets the load balancer route the retry to a different — likely healthy — upstream. The LB and retry logic compose naturally without any explicit coordination.

**Why `services.json` for discovery instead of a config in `server.js`?**
A file can be edited while the process is running. A hardcoded config cannot. The 5-second polling interval is a deliberate tradeoff — fast enough to react to changes, slow enough to not waste I/O on every request.

**Why a custom RESP parser instead of using ioredis on both sides?**
ioredis abstracts RESP into JS promises — `client.get('key')`. A proxy needs to be protocol-transparent. It must parse raw bytes to understand *what command was issued* before deciding whether to serve from cache or forward to Redis. You have to own the parse/serialize cycle.

**Why Lua for cache invalidation?**
Redis executes Lua scripts atomically. No command can interleave between reads and deletes inside the script. Without atomicity, concurrent invalidation requests could partially delete a tag — leaving stale keys in cache with no way to track them.

**Why singleflight?**
A cache miss under load without singleflight means every concurrent request fires its own Redis call. With singleflight, the first request fires, and everyone else awaits the same promise. One network round-trip per key no matter how many concurrent requests arrive simultaneously.

---

## What's Next

- **Phase 4** — Kafka event streaming via `kafkajs`: emit structured events from the gateway (request completed, circuit opened, rate limit hit) and cache proxy, build a separate consumer service that reacts to them — automating IP blocking, alerts, and audit logging
- **Phase 5** — Full observability: OpenTelemetry distributed tracing, Prometheus metrics, Grafana dashboards, structured log correlation across gateway and proxy
- **Phase 6** — Docker Compose full local stack, GitHub Actions CI/CD pipeline, AWS deployment via ECS + S3 + Lambda

---

## Tech Stack

| Layer              | Technology                          |
|--------------------|-------------------------------------|
| Runtime            | Node.js                             |
| Gateway Framework  | Fastify                             |
| Auth               | @fastify/jwt (HS256)                |
| Rate Limiting      | Custom token bucket (in-memory Map) |
| Load Balancing     | Custom (RR / Least-Conn / WRR)      |
| Circuit Breaker    | opossum                             |
| Proxy Transport    | Node.js `http` module               |
| Cache Proxy        | Custom TCP server (`net` module)    |
| Cache Protocol     | RESP — hand-rolled parser + serializer |
| Redis Client       | ioredis                             |
| Policy Config      | js-yaml                             |
| Atomic Invalidation| Redis Lua scripting                 |
| Infrastructure     | Docker                              |

---

*The interesting insights don't come from getting things right — they come from understanding exactly why things go wrong.*
