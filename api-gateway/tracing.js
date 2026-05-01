'use strict';

// Setting env var before SDK init is the most reliable way to set service name
// across all OTel SDK versions
process.env.OTEL_SERVICE_NAME = 'nexus-gateway';

const { NodeSDK }            = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter }  = require('@opentelemetry/exporter-trace-otlp-http');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');

const exporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4318/v1/traces',
});

const sdk = new NodeSDK({
  spanProcessors: [new BatchSpanProcessor(exporter, {
    maxQueueSize:         2048,
    scheduledDelayMillis: 500,
    maxExportBatchSize:   512,
  })],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('[otel] tracing shut down'))
    .catch((err) => console.error('[otel] shutdown error', err))
    .finally(() => process.exit(0));
});