'use strict'

class LoadBalancer {
  constructor(servers, algorithm = 'round-robin') {
    if (!Array.isArray(servers) || servers.length === 0) {
      throw new Error('LoadBalancer: at least one server is required')
    }

    this.algorithm = algorithm

    this.servers = servers.map(s => ({
      url:               s.url.replace(/\/$/, ''),
      weight:            s.weight ?? 1,
      activeConnections: 0,
      healthy:           true,
      requestsHandled:   0,
    }))

    this._rrCursor  = -1
    this._wrrSeq    = this._buildWRRSequence()
    this._wrrCursor = -1
  }

  _buildWRRSequence() {
    const healthy = this.servers.filter(s => s.healthy)
    if (healthy.length === 0) return []
    const g = healthy.reduce((acc, s) => gcd(acc, s.weight), 0)
    const seq = []
    for (const s of healthy) {
      for (let i = 0; i < s.weight / g; i++) seq.push(s.url)
    }
    return seq
  }

  _healthy() { return this.servers.filter(s => s.healthy) }

  _roundRobin(pool) {
    this._rrCursor = (this._rrCursor + 1) % pool.length
    return pool[this._rrCursor]
  }

  _leastConnections(pool) {
    return pool.reduce((best, s) =>
      s.activeConnections < best.activeConnections ? s : best)
  }

  _weightedRR() {
    if (this._wrrSeq.length === 0) throw new Error('No healthy servers in weighted pool')
    this._wrrCursor = (this._wrrCursor + 1) % this._wrrSeq.length
    return this.servers.find(s => s.url === this._wrrSeq[this._wrrCursor])
  }

  pick() {
    const pool = this._healthy()
    if (pool.length === 0) throw new Error('LoadBalancer: no healthy upstream servers')
    switch (this.algorithm) {
      case 'round-robin': return this._roundRobin(pool)
      case 'least-conn':  return this._leastConnections(pool)
      case 'weighted':    return this._weightedRR()
      default: throw new Error(`Unknown algorithm: ${this.algorithm}`)
    }
  }

  acquire(server) { server.activeConnections++; server.requestsHandled++ }
  release(server) { if (server.activeConnections > 0) server.activeConnections-- }

  markUnhealthy(url) {
    const s = this._find(url)
    if (s && s.healthy) { s.healthy = false; this._wrrSeq = this._buildWRRSequence(); this._wrrCursor = -1 }
  }

  markHealthy(url) {
    const s = this._find(url)
    if (s && !s.healthy) { s.healthy = true; this._wrrSeq = this._buildWRRSequence(); this._wrrCursor = -1 }
  }

  _find(url) { return this.servers.find(s => s.url === url.replace(/\/$/, '')) }

  getStats() {
    return {
      algorithm: this.algorithm,
      servers: this.servers.map(({ url, weight, activeConnections, requestsHandled, healthy }) => ({
        url, weight, activeConnections, requestsHandled, healthy,
      })),
    }
  }
}

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b) }

module.exports = LoadBalancer