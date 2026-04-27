// cache-proxy/test-hotkey.js
'use strict';

const redisClient = require('./redis-client');
const { checkAndExtend, getHitCount } = require('./hotkey');

async function main() {
  await redisClient.set('product:1', 'laptop');
  await redisClient.expire('product:1', 60);

  console.log('TTL before:', await redisClient.ttl('product:1'));

  // Simulate 10 hits
  for (let i = 0; i < 10; i++) {
    await checkAndExtend('product:1');
  }

  console.log('TTL after:', await redisClient.ttl('product:1'));
  console.log('Hit count:', getHitCount('product:1'));

  await redisClient.quit();
}

main();