# Nexus — API Gateway + Intelligent Cache Proxy

> A distributed backend system built from first principles.

---

## What Is This?

Nexus is a distributed backend system built from first principles — an API Gateway layered with an Intelligent Cache Proxy, written entirely in Node.js.

It covers the full request lifecycle: from a client hitting the gateway, through authentication and rate limiting, across a TCP-based cache proxy that speaks Redis's binary protocol, all the way to the upstream service.
---

## System Architecture

```
Client
  │
  ▼
┌─────────────────────────────────────────┐
│         API Gateway  (Port 3000)        │
│                                         │
│  onRequest  → Token Bucket Rate Limiter │
│             → JWT Verifier (HS256)      │
│                                         │
│  preHandler → Header Injection          │
│                                         │
│  Proxy      → /api/* → Mock Service    │
│                                         │
│  onResponse → Telemetry Logger          │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│       Cache Proxy  (Port 6380)          │
│                                         │
│  TCP Server  → RESP Parser              │
│             → Policy Engine (YAML)      │
│             → Singleflight Guard        │
│             → Hot Key Detector          │
│             → Tag Invalidation (Lua)    │
│             → RESP Serializer           │
└──────────────────┬──────────────────────┘
                   │
                   ▼
             Redis  (Port 6379)
                   │
                   ▼
┌─────────────────────────────────────────┐
│       Mock Service  (Port 3001)         │
│  /products  /health                     │
└─────────────────────────────────────────┘
```

Each layer has one job and one job only. The gateway enforces policy. The proxy manages cache intelligence. Redis stores data. The mock service represents any upstream you'd put behind this in production.

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

Every request — whether it succeeds, gets rate-limited, or fails auth — is logged with full context at `onResponse`. That hook fires *after* the reply is flushed, so latency and status codes are finalized before they're recorded.

```
GET /api/products → 200 → 6.2ms → client: gateway-client → ip: 127.0.0.1
POST /auth/token  → 401 → 0.9ms → client: anonymous
GET /api/products → 429 → 0.38ms → client: anonymous → rate limited
```

Inspect everything live at `GET /telemetry`.

### Proxy Layer

All `/api/*` traffic is forwarded to the mock service at port `3001`. The `/api` prefix is stripped — `/api/products` becomes `/products` upstream. Uses `undici` under the hood with persistent TCP connection pooling. No new handshake per request.

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
 handler      → Proxy to upstream via undici pool
      │
      ▼
 onResponse   → Record telemetry (latency now finalized)
```

The ordering is intentional. Authentication and rate limiting fire before routing — rejected requests burn zero upstream resources.

### File Structure

```
api-gateway/
├── server.js        ← hooks, routes, proxy, graceful shutdown
├── rateLimiter.js   ← token bucket (pure in-memory Map)
├── auth.js          ← client credential store + validation
└── telemetry.js     ← request log + /telemetry endpoint

mock-service/
└── server.js        ← upstream mock: /products, /health
```

---

## Phase 2 — Intelligent Cache Proxy

The cache proxy is a **TCP server** that sits between the gateway and Redis. It speaks RESP — the same binary protocol Redis itself speaks — which means any Redis client can point at it transparently.

This isn't a caching layer bolted onto HTTP. It operates at the protocol level. It reads raw bytes off a socket, parses them into commands, applies intelligent policy, and either responds from cache or forwards to real Redis.

### Why TCP, Not HTTP?

Redis uses RESP (REdis Serialization Protocol) over raw TCP. There's no HTTP envelope, no headers, no JSON. To proxy Redis transparently, you must speak the same protocol. The `net` module gives exactly that — a raw socket you read bytes from and write bytes to.

### RESP Protocol Parser

TCP has no concept of message boundaries. `SET foo bar` might arrive as 3 separate `data` events. The parser maintains an internal byte buffer, accumulates incoming chunks, and only emits a complete command when every required byte has arrived.

It handles all 5 RESP types:

| Prefix | Type | Example |
|--------|------|---------|
| `+` | Simple String | `+OK\r\n` |
| `-` | Error | `-ERR unknown command\r\n` |
| `:` | Integer | `:1000\r\n` |
| `$` | Bulk String | `$6\r\nfoobar\r\n` |
| `*` | Array | `*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n` |

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

**Why Lua?** Lua scripts run atomically inside Redis. No other command can interrupt mid-execution. This prevents partial invalidation — the scenario where some keys get deleted and others don't under concurrent requests. Either all keys under a tag are gone, or none are.

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

**Why?** Hot keys expire at the worst possible time — when they're being hit the hardest. Detecting and extending their TTL keeps the most valuable data warm without any manual intervention. Cold keys expire naturally. Hot keys stay cached.

```
product:1 → hit 10 times → TTL was 60s → TTL becomes 180s
```

### File Structure

```
nexus-cache-proxy/
├── index.js              ← entry point, boots TCP server + Redis client
├── server.js             ← TCP server, connection lifecycle, command dispatch
├── redis-client.js       ← single shared ioredis instance
├── policy.js             ← loads and queries YAML policy
├── policy.yaml           ← cache rules per command
├── singleflight.js       ← in-flight request deduplication
├── invalidation.js       ← tag-based cache invalidation
├── invalidate.lua        ← atomic Lua deletion script
├── hotkey.js             ← hit tracking + TTL extension
└── resp/
    ├── parser.js         ← stateful streaming RESP decoder
    └── serializer.js     ← RESP encoder
```

---

## Getting Started

**Prerequisites:** Node.js v18+, Docker

### 1. Start Redis

```bash
docker run -d -p 6379:6379 redis
```

### 2. Run Mock Service (Port 3001)

```bash
cd mock-service
npm install
node server.js
```

### 3. Run API Gateway (Port 3000)

```bash
cd api-gateway
npm install
node server.js
```

### 4. Run Cache Proxy (Port 6380)

```bash
cd nexus-cache-proxy
npm install
node index.js
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

| Service | Port |
|---------|------|
| API Gateway | 3000 |
| Mock Service | 3001 |
| Cache Proxy | 6380 |
| Redis | 6379 |

---

## Key Design Decisions

**Why `onRequest` for rate limiting and auth?**
It's the earliest Fastify lifecycle hook — before body parsing, before routing. A rejected request at this stage costs microseconds. Putting these checks later wastes cycles on requests that were never going to succeed.

**Why token bucket over fixed-window counters?**
Fixed windows punish users for timing. A burst at 11:59:59 and another at 12:00:01 count as two separate windows despite being 2 seconds apart. Token bucket accumulates allowance over real elapsed time and tolerates natural bursts while enforcing a true average rate.

**Why `0.0.0.0` on the gateway but `127.0.0.1` on the mock service?**
The gateway is the public entry point — it binds to all interfaces. The mock service should never be directly reachable from outside. Binding to loopback enforces that boundary at the network level, not just in code.

**Why a custom RESP parser instead of using ioredis on both sides?**
ioredis abstracts RESP into JS promises — `client.get('key')`. A proxy needs to be protocol-transparent. It must parse raw bytes to understand *what command was issued* before deciding whether to serve from cache or forward to Redis. You have to own the parse/serialize cycle.

**Why Lua for cache invalidation?**
Redis executes Lua scripts atomically. No command can interleave between reads and deletes inside the script. Without atomicity, concurrent invalidation requests could partially delete a tag — leaving stale keys in cache with no way to track them.

**Why singleflight?**
A cache miss under load without singleflight means every concurrent request fires its own Redis call. With singleflight, the first request fires, and everyone else awaits the same promise. One network round-trip per key no matter how many concurrent requests.

---

## What's Next

- **Phase 3** — Load balancing (round-robin, least connections, weighted), circuit breaker via opossum, retry + timeout handling, request/response transformation
- **Phase 4** — Kafka event streaming: emit gateway and proxy events, build consumer service, automate IP blocking and alerting
- **Phase 5** — OpenTelemetry distributed tracing, Prometheus metrics, Grafana dashboards
- **Phase 6** — Docker Compose full stack, GitHub Actions CI/CD, AWS ECS + S3 + Lambda deployment

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js |
| Gateway Framework | Fastify |
| Proxy Transport | @fastify/http-proxy + undici |
| Auth | @fastify/jwt (HS256) |
| Rate Limiting | Custom token bucket (in-memory) |
| Cache Proxy | Custom TCP server (net module) |
| Cache Protocol | RESP — hand-rolled parser + serializer |
| Redis Client | ioredis |
| Policy Config | js-yaml |
| Atomic Invalidation | Redis Lua scripting |
| Infrastructure | Docker |

---

*Every design decision in this project was made with production failure modes in mind. The interesting insights don't come from getting things right — they come from understanding exactly why things go wrong.*
