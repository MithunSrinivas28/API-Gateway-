// cache-proxy/resp/serializer.js
'use strict';

function serialize(value) {
  if (value === null) {
    return '$-1\r\n';
  }

  switch (value.type) {
    case 'simple_string':
      return `+${value.value}\r\n`;

    case 'error':
      return `-${value.value}\r\n`;

    case 'integer':
      return `:${value.value}\r\n`;

    case 'bulk_string':
      if (value.value === null) return '$-1\r\n';
      const bytes = Buffer.byteLength(value.value, 'utf8');
      return `$${bytes}\r\n${value.value}\r\n`;

    case 'array':
      if (value.value === null) return '*-1\r\n';
      const parts = value.value.map(serialize);
      return `*${value.value.length}\r\n${parts.join('')}`;

    default:
      throw new Error(`Cannot serialize unknown type: '${value.type}'`);
  }
}

module.exports = { serialize };