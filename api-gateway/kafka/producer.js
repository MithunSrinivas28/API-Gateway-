// kafka/producer.js
const { Kafka, Partitioners, logLevel } = require('kafkajs');

const kafka = new Kafka({
  clientId: 'nexus-gateway',
  brokers: ['localhost:9092'],
  logLevel: logLevel.WARN,
});

const producer = kafka.producer({
  createPartitioner: Partitioners.LegacyPartitioner,
  allowAutoTopicCreation: true,
});

let connected = false;

async function connectProducer() {
  if (connected) return;
  await producer.connect();
  connected = true;
  console.log('[kafka] producer connected');
}

async function disconnectProducer() {
  if (!connected) return;
  await producer.disconnect();
  connected = false;
  console.log('[kafka] producer disconnected');
}

async function emitEvent(topic, payload) {
  if (!connected) {
    console.warn(`[kafka] producer not connected, dropping event: ${topic}`);
    return;
  }
  try {
    await producer.send({
      topic,
      messages: [
        {
          key: payload.correlationId ?? null,
          value: JSON.stringify({
            ...payload,
            emittedAt: new Date().toISOString(),
          }),
        },
      ],
    });
  } catch (err) {
    console.error(`[kafka] failed to emit to ${topic}:`, err.message);
  }
}

module.exports = { connectProducer, disconnectProducer, emitEvent };