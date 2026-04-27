'use strict'

const fs   = require('fs')
const path = require('path')

const SERVICES_FILE = path.join(__dirname, 'services.json')
const POLL_INTERVAL = 5000 // re-read every 5 seconds

/**
 * Reads services.json and syncs the LB pool.
 * - New URLs    → lb.markHealthy (adds back if previously removed)
 * - Removed URLs → lb.markUnhealthy (pulls from rotation)
 */
function startDiscovery(lb, logger) {
  let lastKnown = new Set(lb.servers.map(s => s.url))

  const poll = () => {
    try {
      const raw      = fs.readFileSync(SERVICES_FILE, 'utf8')
      const parsed   = JSON.parse(raw)
      const current  = new Set(parsed.services.map(s => s.url.replace(/\/$/, '')))

      // Newly added servers
      for (const url of current) {
        if (!lastKnown.has(url)) {
          lb.markHealthy(url)
          console.log(`[Discovery] New upstream added — ${url}`)
        }
      }

      // Removed servers
      for (const url of lastKnown) {
        if (!current.has(url)) {
          lb.markUnhealthy(url)
         console.log(`[Discovery] Upstream removed — ${url}`)
        }
      }

      lastKnown = current

    } catch (err) {
     console.error(`[Discovery] Failed to read services.json`, err)
    }
  }

  // Run immediately then on interval
  poll()
  const timer = setInterval(poll, POLL_INTERVAL)

  // Return stop function for graceful shutdown
  return () => clearInterval(timer)
}

module.exports = { startDiscovery }