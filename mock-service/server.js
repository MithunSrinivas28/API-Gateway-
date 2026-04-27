const fastify = require('fastify')({ logger: true });

fastify.get('/health', async (request, reply) => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    forwarded_for: request.headers['x-forwarded-for'] || null,
    gateway_timestamp: request.headers['x-gateway-timestamp'] || null
  };
});

fastify.get('/products', async (request, reply) => {
  return {
    products: [
      { id: 1, name: 'Laptop', price: 999 },
      { id: 2, name: 'Mouse', price: 25 },
      { id: 3, name: 'Keyboard', price: 75 }
    ]
  };
});

fastify.listen({ port: 3001, host: '127.0.0.1' }, (err, address) => {
  if (err) throw err;
  console.log(`Mock service running at ${address}`);
});