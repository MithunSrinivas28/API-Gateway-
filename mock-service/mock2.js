const fastify = require('fastify')({ logger: false });

fastify.get('/products', async () => ({
  source: 'mock-3002',
  products: [{ id: 99, name: 'Product from 3002' }]
}));

fastify.get('/api/health', async () => ({ status: 'mock-3002-ok' }));

fastify.listen({ port: 3002, host: '127.0.0.1' }, () => {
  console.log('Mock 2 running on port 3002');
});