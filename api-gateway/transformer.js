'use strict'

/**
 * transformRequest
 * Mutates the options object before the upstream http.request is fired.
 * Add/remove headers, rewrite paths, inject tracing IDs etc.
 */
function transformRequest(options, request) {
  // Inject a unique request ID for distributed tracing
  const requestId = `nexus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  options.headers['x-request-id']  = requestId
  options.headers['x-gateway-version'] = '1.0.0'

  // Strip any internal auth headers the client should never forward
  delete options.headers['x-internal-secret']
  delete options.headers['x-admin-override']

  return { options, requestId }
}

/**
 * transformResponse
 * Wraps the upstream response body with gateway metadata.
 * Only runs on JSON responses.
 */
async function transformResponse(proxyRes, requestId) {
  const contentType = proxyRes.headers['content-type'] || ''
  if (!contentType.includes('application/json')) return null

  const raw = await readBody(proxyRes)

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw // not valid JSON, return as-is
  }

  return JSON.stringify({
    data:      parsed,
    _meta: {
      requestId,
      gateway:   'nexus',
      timestamp: new Date().toISOString(),
    }
  })
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.on('end',  () => resolve(Buffer.concat(chunks).toString()))
    stream.on('error', reject)
  })
}

module.exports = { transformRequest, transformResponse }