'use strict'

const CircuitBreaker = require('opossum')

const breakers = new Map()

const BREAKER_OPTIONS = {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 10000,
  volumeThreshold: 3,
}

function getBreaker(url) {
  if (!breakers.has(url)) {
    // Wrap an identity function — actual action passed via fire()
    const breaker = new CircuitBreaker((fn) => fn(), BREAKER_OPTIONS)

    breaker.on('open', (onOpen) => {
  console.log(`[CB] OPEN — ${url} failing, fast-failing requests`)
  if (onOpen) onOpen(url)
})
    breaker.on('halfOpen', () => console.log(`[CB] HALF-OPEN — ${url} testing recovery`))
    breaker.on('close',    () => console.log(`[CB] CLOSED    — ${url} recovered`))

    breakers.set(url, breaker)
  }
  return breakers.get(url)
}

function getBreakerStats() {
  const stats = {}
  for (const [url, breaker] of breakers.entries()) {
    stats[url] = {
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
    }
  }
  return stats
}

module.exports = { getBreaker, getBreakerStats }