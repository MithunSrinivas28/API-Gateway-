const telemetryLog = [];

function record(entry) {
  const record = {
    timestamp: new Date().toISOString(),
    method: entry.method,
    url: entry.url,
    statusCode: entry.statusCode,
    latencyMs: entry.latencyMs,
    ip: entry.ip,
    clientId: entry.clientId || 'anonymous'
  };

  telemetryLog.push(record);
  console.log('[TELEMETRY]', JSON.stringify(record));
}

function getLogs() {
  return telemetryLog;
}

module.exports = { record, getLogs };