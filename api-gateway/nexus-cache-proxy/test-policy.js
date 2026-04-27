// cache-proxy/test-policy.js
'use strict';

const { getPolicy } = require('./policy');

const commands = ['GET', 'SET', 'DEL', 'HGET'];

commands.forEach((cmd) => {
  const policy = getPolicy(cmd);
  console.log(`[${cmd}]`, policy);
});