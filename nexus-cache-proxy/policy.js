// cache-proxy/policy.js
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function loadPolicy() {
  const file = path.join(__dirname, 'policy.yaml');
  const raw = fs.readFileSync(file, 'utf8');
  return yaml.load(raw);
}

function getPolicy(command) {
  const { policies } = loadPolicy();
  const match = policies.find(
    (p) => p.match.toUpperCase() === command.toUpperCase()
  );
  return match || { enabled: false, ttl: 0 };
}

module.exports = { getPolicy };