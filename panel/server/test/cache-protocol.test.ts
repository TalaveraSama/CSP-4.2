import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TYPE_PINGREQ,
  TYPE_PINGRPL,
  TYPE_REPLY,
  TYPE_REQUEST,
  TYPE_RESENDREQ,
  cacheKey,
  decode,
  encode,
  ProtocolError,
} from '../src/cache/protocol.js';

const REQ = { tag: 0x80, serviceId: 0x2008, networkId: 0x0085, caId: 0x0b00, hash: 0xdeadbeef };
const CW = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');

test('a pending request is the 12 bytes NCam expects', () => {
  const buf = encode({ type: TYPE_REQUEST, request: REQ });
  // type tag sid   onid  caid  hash
  assert.equal(buf.toString('hex'), '01' + '80' + '2008' + '0085' + '0b00' + 'deadbeef');
  assert.equal(buf.length, 12, 'NCam ignores anything that is not exactly 12');
  assert.deepEqual(decode(buf), { type: TYPE_REQUEST, request: REQ });
});

test('an arbitration request carries the double CSP adds', () => {
  const buf = encode({ type: TYPE_REQUEST, request: { ...REQ, arbiter: 0.5 } });
  assert.equal(buf.length, 20);
  const back = decode(buf);
  assert.equal(back.type, TYPE_REQUEST);
  assert.equal(back.type === TYPE_REQUEST ? back.request.arbiter : undefined, 0.5);
});

test('a reply is 29 bytes, or more when it names its origin', () => {
  const bare = encode({ type: TYPE_REPLY, request: REQ, reply: { tag: 0x80, cw: CW } });
  assert.equal(bare.length, 29);
  assert.equal(bare.toString('hex'), '02' + '80' + '2008' + '0085' + '0b00' + 'deadbeef' + '80' + CW.toString('hex'));

  const named = encode({ type: TYPE_REPLY, request: REQ, reply: { tag: 0x80, cw: CW, origin: 'ncam' } });
  assert.equal(named.length, 29 + 2 + 4);
  assert.equal(named.readUInt16BE(29), 4, 'java writeUTF length prefix');
  assert.equal(named.subarray(31).toString(), 'ncam');

  const back = decode(named);
  assert.equal(back.type, TYPE_REPLY);
  if (back.type !== TYPE_REPLY) return;
  assert.deepEqual(back.request, REQ);
  assert.equal(back.reply.cw?.toString('hex'), CW.toString('hex'));
  assert.equal(back.reply.origin, 'ncam');
});

test('an empty reply (nothing found) has no control word', () => {
  const buf = encode({ type: TYPE_REPLY, request: REQ, reply: { tag: 0x80 } });
  assert.equal(buf.length, 13);
  const back = decode(buf);
  assert.equal(back.type === TYPE_REPLY ? back.reply.cw : 'x', undefined);
});

test('ping and pong match the layout of both implementations', () => {
  const ping = 1_767_225_600_123n;
  const req = encode({ type: TYPE_PINGREQ, ping, port: 54278 });
  assert.equal(req.length, 13);
  assert.equal(req.readBigInt64BE(1), ping);
  assert.equal(req.readInt32BE(9), 54278, 'the sender advertises its listen port');

  const rpl = encode({ type: TYPE_PINGRPL, ping });
  assert.equal(rpl.length, 9);
  assert.deepEqual(decode(rpl), { type: TYPE_PINGRPL, ping });
});

test('a ping from NCam decodes even though it writes a 32 bit clock', () => {
  // NCam: buf[0]=3, buf[1..4]=now (ms, truncated), buf[5..8]=0, buf[9..12]=port
  const ncam = Buffer.alloc(13);
  ncam.writeUInt8(TYPE_PINGREQ, 0);
  ncam.writeUInt32BE(0x0123_4567, 1);
  ncam.writeUInt32BE(54279, 9);
  const back = decode(ncam);
  assert.equal(back.type, TYPE_PINGREQ);
  if (back.type !== TYPE_PINGREQ) return;
  assert.equal(back.port, 54279);
  // The 8 bytes have to be echoed back untouched, whatever they mean.
  assert.equal(encode({ type: TYPE_PINGRPL, ping: back.ping }).subarray(1).toString('hex'), ncam.subarray(1, 9).toString('hex'));
});

test('a resend request carries the asking port', () => {
  const buf = encode({ type: TYPE_RESENDREQ, port: 54278, request: REQ });
  assert.equal(buf.length, 16);
  assert.deepEqual(decode(buf), { type: TYPE_RESENDREQ, port: 54278, request: REQ });
});

test('rejects garbage instead of guessing', () => {
  assert.throws(() => decode(Buffer.alloc(0)), ProtocolError);
  assert.throws(() => decode(Buffer.from([9, 1, 2, 3])), /unknown cache message type 9/);
  assert.throws(() => decode(Buffer.from([TYPE_PINGREQ, 1, 2])), /truncated/);
  assert.throws(() => decode(Buffer.from([TYPE_REPLY, 0x80, 0x20])), /truncated/);
  assert.throws(
    () => encode({ type: TYPE_REPLY, request: REQ, reply: { tag: 0x80, cw: Buffer.alloc(8) } }),
    /16 bytes/,
  );
});

test('the cache key separates parity, service and network', () => {
  assert.equal(cacheKey(REQ), '0b00:0085:2008:deadbeef:80');
  assert.notEqual(cacheKey(REQ), cacheKey({ ...REQ, tag: 0x81 }));
  assert.notEqual(cacheKey(REQ), cacheKey({ ...REQ, networkId: 1 }));
});
