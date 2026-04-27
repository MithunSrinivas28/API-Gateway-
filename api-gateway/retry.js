'use strict'

/**
 * Retries an async action up to maxAttempts times.
 * Waits delayMs between attempts.
 * Calls onRetry(attempt, err) on each failure before retrying.
 */
async function withRetry(action, { maxAttempts = 3, delayMs = 200, onRetry } = {}) {
  let lastErr

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await action(attempt)
    } catch (err) {
      lastErr = err
      if (onRetry) onRetry(attempt, err)
      if (attempt < maxAttempts) await sleep(delayMs)
    }
  }

  throw lastErr
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { withRetry }