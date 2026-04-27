// cache-proxy/resp/parser.js
'use strict';

const { EventEmitter } = require('events');

const INCOMPLETE = Symbol('INCOMPLETE');

class RespParser extends EventEmitter {
  constructor() {
    super();
    this._buf = Buffer.alloc(0);
  }

  feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);

    while (this._buf.length > 0) {
      const result = this._parse(0);
      if (result === INCOMPLETE) break;

      const { value, bytesConsumed } = result;
      this._buf = this._buf.slice(bytesConsumed);
      this.emit('command', value);
    }
  }

  _parse(offset) {
    if (this._buf.length <= offset) return INCOMPLETE;

    const type = String.fromCharCode(this._buf[offset]);
    const lineEnd = this._buf.indexOf('\r\n', offset + 1);
    if (lineEnd === -1) return INCOMPLETE;

    const line = this._buf.toString('utf8', offset + 1, lineEnd);
    const afterLine = lineEnd + 2;

    switch (type) {
      case '+':
        return { value: { type: 'simple_string', value: line }, bytesConsumed: afterLine - offset };

      case '-':
        return { value: { type: 'error', value: line }, bytesConsumed: afterLine - offset };

      case ':': {
        const int = parseInt(line, 10);
        if (isNaN(int)) return INCOMPLETE;
        return { value: { type: 'integer', value: int }, bytesConsumed: afterLine - offset };
      }

      case '$': {
        const len = parseInt(line, 10);
        if (len === -1) return { value: { type: 'bulk_string', value: null }, bytesConsumed: afterLine - offset };

        const dataEnd = afterLine + len;
        if (this._buf.length < dataEnd + 2) return INCOMPLETE;

        const data = this._buf.slice(afterLine, dataEnd).toString('utf8');
        return { value: { type: 'bulk_string', value: data }, bytesConsumed: dataEnd + 2 - offset };
      }

      case '*': {
        const count = parseInt(line, 10);
        if (count === -1) return { value: { type: 'array', value: null }, bytesConsumed: afterLine - offset };

        const elements = [];
        let currentOffset = afterLine;

        for (let i = 0; i < count; i++) {
          const el = this._parse(currentOffset);
          if (el === INCOMPLETE) return INCOMPLETE;
          elements.push(el.value);
          currentOffset += el.bytesConsumed;
        }

        return { value: { type: 'array', value: elements }, bytesConsumed: currentOffset - offset };
      }

      default:
        this.emit('error', new Error(`Unknown RESP type: '${type}'`));
        return INCOMPLETE;
    }
  }

  reset() {
    this._buf = Buffer.alloc(0);
    this.removeAllListeners();
  }
}

module.exports = { RespParser, INCOMPLETE };