// cache-proxy/test-invalidation.js
'use strict';

const redisClient = require('./redis-client');
const { tagKey, invalidateTag } = require('./invalidation');

async function main() {
  // removed redisClient.connect()

  await redisClient.set('product:1', 'laptop');
  await redisClient.set('product:2', 'mouse');

  await tagKey('products', 'product:1');
  await tagKey('products', 'product:2');

  console.log('Before:', await redisClient.mget('product:1', 'product:2'));

  await invalidateTag('products');

  console.log('After:', await redisClient.mget('product:1', 'product:2'));

  await redisClient.quit();
}

main();