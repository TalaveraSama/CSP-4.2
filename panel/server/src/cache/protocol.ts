/**
 * The CSP cache protocol (UDP), as spoken by CardServProxy's ClusteredCache
 * and by OSCam/NCam's `[cache] csp_port`.
 *
 * Derived from both implementations in this repository:
 *   src/com/bowman/cardserv/ClusteredCache.java  (writeCacheReq/writeCacheRpl)
 *   vendor/ncam/module-csp.c                     (csp_recv/csp_cache_push_out)
 *
 * Everything is big endian, no framing, one message per datagram:
 *
 *   type 1 REQUEST    type sid onid caid hash [arbiter]      12 or 20 bytes
 *   type 2 REPLY      type sid onid caid hash tag cw[16] [name]   >= 29 bytes
 *   type 3 PINGREQ    type ping(8) port(4)                        13 bytes
 *   type 4 PINGRPL    type ping(8)                                 9 bytes
 *   type 5 RESENDREQ  type port(4) sid onid caid hash             16 bytes
 *
 * where the request body is: tag(1) sid(2) onid(2) caid(2) hash(4).
 *
 * Quirk worth knowing: NCam fills the 8-byte ping field with a 32-bit
 * millisecond value written into its *high* half, so a round trip time
 * computed from an NCam-originated ping is meaningless. Ours is a real
 * 64-bit timestamp, and NCam echoes the 8 bytes back untouched, so pings we
 * send are measured correctly.
 */

export const TYPE_REQUEST = 1;
export const TYPE_REPLY = 2;
export const TYPE_PINGREQ = 3;
export const TYPE_PINGRPL = 4;
export const TYPE_RESENDREQ = 5;

/** ECM identity shared by every cache message. */
export interface CacheRequest {
  /** First ECM byte: 0x80 / 0x81 (even/odd), 0x80 used as a stand-in. */
  tag: number;
  serviceId: number;
  networkId: number;
  caId: number;
  /** CSP's 32-bit hash of the ECM payload. */
  hash: number;
  /** Only in REQUEST messages used for cluster arbitration. */
  arbiter?: number;
}

export interface CacheReply {
  tag: number;
  /** 16 byte control word; absent for an "empty reply" (not found). */
  cw?: Buffer;
  /** Name of the connector/reader that produced the cw, when shared. */
  origin?: string;
}

export type CacheMessage =
  | { type: typeof TYPE_REQUEST; request: CacheRequest }
  | { type: typeof TYPE_REPLY; request: CacheRequest; reply: CacheReply }
  | { type: typeof TYPE_PINGREQ; ping: bigint; port: number }
  | { type: typeof TYPE_PINGRPL; ping: bigint }
  | { type: typeof TYPE_RESENDREQ; port: number; request: CacheRequest };

export class ProtocolError extends Error {}

const REQ_LEN = 11;

function writeRequest(buf: Buffer, offset: number, req: CacheRequest): number {
  buf.writeUInt8(req.tag & 0xff, offset);
  buf.writeUInt16BE(req.serviceId & 0xffff, offset + 1);
  buf.writeUInt16BE(req.networkId & 0xffff, offset + 3);
  buf.writeUInt16BE(req.caId & 0xffff, offset + 5);
  buf.writeUInt32BE(req.hash >>> 0, offset + 7);
  return offset + REQ_LEN;
}

function readRequest(buf: Buffer, offset: number): CacheRequest {
  if (buf.length < offset + REQ_LEN) throw new ProtocolError('truncated cache request');
  return {
    tag: buf.readUInt8(offset),
    serviceId: buf.readUInt16BE(offset + 1),
    networkId: buf.readUInt16BE(offset + 3),
    caId: buf.readUInt16BE(offset + 5),
    hash: buf.readUInt32BE(offset + 7),
  };
}

/** Java's DataOutputStream.writeUTF: 2-byte length then modified UTF-8. */
function writeJavaUtf(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const out = Buffer.allocUnsafe(2 + bytes.length);
  out.writeUInt16BE(bytes.length, 0);
  bytes.copy(out, 2);
  return out;
}

export function encode(message: CacheMessage): Buffer {
  switch (message.type) {
    case TYPE_REQUEST: {
      const extra = message.request.arbiter !== undefined;
      const buf = Buffer.alloc(1 + REQ_LEN + (extra ? 8 : 0));
      buf.writeUInt8(TYPE_REQUEST, 0);
      const end = writeRequest(buf, 1, message.request);
      if (extra) buf.writeDoubleBE(message.request.arbiter!, end);
      return buf;
    }
    case TYPE_REPLY: {
      const { reply } = message;
      const name = reply.origin ? writeJavaUtf(reply.origin) : undefined;
      const cw = reply.cw;
      if (cw && cw.length !== 16) throw new ProtocolError('a control word is 16 bytes');
      const buf = Buffer.alloc(1 + REQ_LEN + 1 + (cw ? 16 : 0) + (cw && name ? name.length : 0));
      buf.writeUInt8(TYPE_REPLY, 0);
      let at = writeRequest(buf, 1, message.request);
      buf.writeUInt8(reply.tag & 0xff, at);
      at += 1;
      if (cw) {
        cw.copy(buf, at);
        at += 16;
        // The name only exists when there is a cw (writeCacheRpl).
        if (name) name.copy(buf, at);
      }
      return buf;
    }
    case TYPE_PINGREQ: {
      const buf = Buffer.alloc(13);
      buf.writeUInt8(TYPE_PINGREQ, 0);
      buf.writeBigInt64BE(message.ping, 1);
      buf.writeInt32BE(message.port, 9);
      return buf;
    }
    case TYPE_PINGRPL: {
      const buf = Buffer.alloc(9);
      buf.writeUInt8(TYPE_PINGRPL, 0);
      buf.writeBigInt64BE(message.ping, 1);
      return buf;
    }
    case TYPE_RESENDREQ: {
      const buf = Buffer.alloc(1 + 4 + REQ_LEN);
      buf.writeUInt8(TYPE_RESENDREQ, 0);
      buf.writeInt32BE(message.port, 1);
      writeRequest(buf, 5, message.request);
      return buf;
    }
    default: {
      const never: never = message;
      throw new ProtocolError(`cannot encode ${JSON.stringify(never)}`);
    }
  }
}

export function decode(buf: Buffer): CacheMessage {
  if (buf.length < 1) throw new ProtocolError('empty datagram');
  const type = buf.readUInt8(0);

  switch (type) {
    case TYPE_REQUEST: {
      const request = readRequest(buf, 1);
      // 20 bytes = arbitration request; CSP uses it to negotiate who asks the
      // card. NCam ignores those, and so does a read-only peer, but decoding
      // it keeps the stats honest.
      if (buf.length >= 1 + REQ_LEN + 8) request.arbiter = buf.readDoubleBE(1 + REQ_LEN);
      return { type: TYPE_REQUEST, request };
    }
    case TYPE_REPLY: {
      const request = readRequest(buf, 1);
      const at = 1 + REQ_LEN;
      if (buf.length < at + 1) throw new ProtocolError('truncated cache reply');
      const reply: CacheReply = { tag: buf.readUInt8(at) };
      if (buf.length >= at + 17) {
        reply.cw = Buffer.from(buf.subarray(at + 1, at + 17));
        const nameAt = at + 17;
        if (buf.length >= nameAt + 2) {
          const len = buf.readUInt16BE(nameAt);
          if (len > 0 && buf.length >= nameAt + 2 + len) {
            reply.origin = buf.subarray(nameAt + 2, nameAt + 2 + len).toString('utf8');
          }
        }
      }
      return { type: TYPE_REPLY, request, reply };
    }
    case TYPE_PINGREQ: {
      if (buf.length < 13) throw new ProtocolError('truncated ping request');
      return { type: TYPE_PINGREQ, ping: buf.readBigInt64BE(1), port: buf.readInt32BE(9) };
    }
    case TYPE_PINGRPL: {
      if (buf.length < 9) throw new ProtocolError('truncated ping reply');
      return { type: TYPE_PINGRPL, ping: buf.readBigInt64BE(1) };
    }
    case TYPE_RESENDREQ: {
      if (buf.length < 16) throw new ProtocolError('truncated resend request');
      return { type: TYPE_RESENDREQ, port: buf.readInt32BE(1), request: readRequest(buf, 5) };
    }
    default:
      throw new ProtocolError(`unknown cache message type ${type}`);
  }
}

/** Stable key for an ECM identity, used to index the store. */
export function cacheKey(req: CacheRequest): string {
  const hex = (n: number, w: number) => n.toString(16).padStart(w, '0');
  // The tag (even/odd) is part of the identity: the same hash with a
  // different parity is a different control word.
  return `${hex(req.caId, 4)}:${hex(req.networkId, 4)}:${hex(req.serviceId, 4)}:${hex(req.hash >>> 0, 8)}:${hex(req.tag, 2)}`;
}
