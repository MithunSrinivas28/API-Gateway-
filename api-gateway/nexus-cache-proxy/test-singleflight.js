// cache-proxy/test-singleflight.js
'use strict';

const singleflight = require('./singleflight');

let callCount = 0;

async function fakeRedisCall() {
  callCount++;
  await new Promise((r) => setTimeout(r, 100));
  return 'result';
}

async function main() {
  const results = await Promise.all([
    singleflight.do('foo', fakeRedisCall),
    singleflight.do('foo', fakeRedisCall),
    singleflight.do('foo', fakeRedisCall),
  ]);

  console.log('Results:', results);
  console.log('Redis calls made:', callCount); // should be 1
}

main();