// cache-proxy/invalidation.js
'use strict';

const fs = require('fs');
const path = require('path');
const redisClient = require('./redis-client');

const script = fs.readFileSync(path.join(__dirname, 'invalidate.lua'), 'utf8');

async function tagKey(tag, key) {
  await redisClient.sadd(`tag:${tag}`, key);
}

async function invalidateTag(tag) {
  const deleted = await redisClient.eval(script, 1, `tag:${tag}`);
  console.log(`[invalidation] tag:${tag} — deleted ${deleted} keys`);
  return deleted;
}

module.exports = { tagKey, invalidateTag };