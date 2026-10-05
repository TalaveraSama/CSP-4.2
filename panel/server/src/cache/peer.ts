import { createSocket, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';

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
  type CacheReply,
  type CacheRequest,
} from './protocol.js';

/**
 * A node in a CSP cache cluster.
 *
 * It behaves like any other peer: it answers pings, stores the ecm -> cw
 * pairs the cluster broadcasts, replies to resend requests out of that store
 * and can push entries of its own. That makes the panel able to *see* the
 * cache (what is flowing, which peers are alive, how fresh the entries are)
 * without having to ask CSP or NCam for it.
 *
 * It deliberately lives in its own process: a cache peer has to stay up and
 * keep state, while the panel is stateless and restarting it should cost
 * nothing.
 */

export interface PeerAddress {
  host: string;
  port: number;
}

export interface CacheNodeOptions {
  /** UDP port to listen on (the peers' `remote-port`). */
  port: number;
  bind?: string;
  /** Peers to ping and to forward entries to. */
  peers?: PeerAddress[];
  /** Seconds an entry stays in the store. CSP's default cw-max-age is 19. */
  maxAge?: number;
  /** Hard cap on stored entries, so a busy cluster cannot eat the box. */
  maxEntries?: number;
  /** Seconds between pings. CSP pings every 10s, NCam every 4s. */
  pingInterval?: number;
  /** Learn senders that ping us but are not configured. */
  autoAddPeers?: boolean;
  log?: (message: string) => void;
}

export interface PeerStats {
  host: string;
  /** The peer's *listen* port: where we send, and what its pings advertise. */
  port: number;
  /** Round trip of our last ping, in ms. */
  rtt?: number;
  lastSeen?: number;
  auto: boolean;
}

/**
 * Where datagrams actually came from.
 *
 * CardServProxy receives on its configured port but *sends* from an ephemeral
 * one (`new DatagramSocket()` in ClusteredCache), so the source port of an
 * incoming entry says nothing about which peer sent it. Counting traffic per
 * observed source instead of guessing a peer keeps the numbers truthful.
 */
export interface SourceStats {
  host: string;
  port: number;
  replies: number;
  requests: number;
  lastSeen: number;
}

export interface CacheStats {
  port: number;
  since: number;
  entries: number;
  pending: number;
  received: { replies: number; requests: number; resends: number; pings: number; invalid: number };
  sent: { replies: number; pings: number; pongs: number; resends: number };
  hits: number;
  misses: number;
  peers: PeerStats[];
  sources: SourceStats[];
}

interface Entry {
  cw: Buffer;
  origin?: string;
  at: number;
  request: CacheRequest;
  from?: string;
}

const MAX_DATAGRAM = 512;

export class CspCacheNode extends EventEmitter {
  private socket?: Socket;
  private timer?: NodeJS.Timeout;
  private readonly store = new Map<string, Entry>();
  private readonly pending = new Map<string, number>();
  private readonly peers = new Map<string, PeerStats>();
  private readonly sources = new Map<string, SourceStats>();
  /** Ping token -> which peer we sent it to and when. */
  private readonly pings = new Map<string, { peer: string; at: number }>();
  private pingSeq = 0;
  private readonly started = Date.now();

  private readonly counters = {
    replies: 0,
    requests: 0,
    resends: 0,
    pings: 0,
    invalid: 0,
    sentReplies: 0,
    sentPings: 0,
    sentPongs: 0,
    sentResends: 0,
    hits: 0,
    misses: 0,
  };

  private readonly maxAge: number;
  private readonly maxEntries: number;
  private readonly pingInterval: number;
  private readonly autoAddPeers: boolean;
  private readonly log: (message: string) => void;

  constructor(private readonly options: CacheNodeOptions) {
    super();
    this.maxAge = (options.maxAge ?? 19) * 1000;
    this.maxEntries = options.maxEntries ?? 20_000;
    this.pingInterval = (options.pingInterval ?? 10) * 1000;
    this.autoAddPeers = options.autoAddPeers ?? true;
    this.log = options.log ?? (() => undefined);
    for (const peer of options.peers ?? []) this.addPeer(peer, false);
  }

  private key(peer: PeerAddress): string {
    return `${peer.host}:${peer.port}`;
  }

  addPeer(peer: PeerAddress, auto = true): PeerStats {
    const key = this.key(peer);
    let stats = this.peers.get(key);
    if (!stats) {
      stats = { host: peer.host, port: peer.port, auto };
      this.peers.set(key, stats);
      this.log(`peer ${key}${auto ? ' (learned)' : ''}`);
    }
    return stats;
  }

  async start(): Promise<void> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('message', (data, rinfo) => this.onMessage(data, rinfo.address, rinfo.port));
    socket.on('error', (err) => {
      this.log(`socket error: ${err.message}`);
      this.emit('error', err);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.options.port, this.options.bind ?? '0.0.0.0', () => {
        socket.off('error', reject);
        resolve();
      });
    });

    this.ping();
    this.timer = setInterval(() => {
      this.ping();
      this.sweep();
    }, this.pingInterval);
    this.timer.unref?.();
    this.log(`listening on ${this.options.bind ?? '0.0.0.0'}:${this.options.port}`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  /* ----------------------------------------------------------- receiving */

  private onMessage(data: Buffer, host: string, port: number): void {
    if (data.length > MAX_DATAGRAM) {
      this.counters.invalid += 1;
      return;
    }
    let message;
    try {
      message = decode(data);
    } catch (err) {
      this.counters.invalid += 1;
      if (err instanceof ProtocolError) this.log(`from ${host}:${port}: ${err.message}`);
      return;
    }

    switch (message.type) {
      case TYPE_REPLY: {
        this.counters.replies += 1;
        this.source(host, port).replies += 1;
        this.touch(host);
        if (message.reply.cw) this.remember(message.request, message.reply, host);
        this.emit('reply', message.request, message.reply, host);
        break;
      }
      case TYPE_REQUEST: {
        this.counters.requests += 1;
        this.source(host, port).requests += 1;
        this.touch(host);
        // A pending request from a peer: somebody is already asking a card
        // for this ecm, so we note it and do not ask for it ourselves.
        this.pending.set(cacheKey(message.request), Date.now());
        this.emit('request', message.request, host);
        break;
      }
      case TYPE_PINGREQ: {
        this.counters.pings += 1;
        // The sender tells us which port it listens on; that is the address
        // to answer and to remember, not the ephemeral source port.
        const peer = this.autoAddPeers ? this.addPeer({ host, port: message.port }) : this.peers.get(`${host}:${message.port}`);
        if (peer) peer.lastSeen = Date.now();
        this.send(encode({ type: TYPE_PINGRPL, ping: message.ping }), host, message.port);
        this.counters.sentPongs += 1;
        break;
      }
      case TYPE_PINGRPL: {
        // Each ping carries a token unique to the peer it went to, which is
        // the only reliable way to tell two peers on the same host apart.
        const sent = this.pings.get(String(message.ping));
        const peer = sent ? this.peers.get(sent.peer) : undefined;
        if (peer) {
          peer.lastSeen = Date.now();
          peer.rtt = Date.now() - sent!.at;
        } else {
          this.touch(host);
        }
        this.pings.delete(String(message.ping));
        break;
      }
      case TYPE_RESENDREQ: {
        this.counters.resends += 1;
        const entry = this.lookup(message.request);
        if (entry) {
          this.send(
            encode({
              type: TYPE_REPLY,
              request: message.request,
              reply: { tag: message.request.tag, cw: entry.cw, origin: entry.origin },
            }),
            host,
            message.port,
          );
          this.counters.sentResends += 1;
        }
        break;
      }
    }
  }

  /** Mark every peer on that host as alive: traffic arrived from there. */
  private touch(host: string): void {
    for (const peer of this.peers.values()) if (peer.host === host) peer.lastSeen = Date.now();
  }

  private source(host: string, port: number): SourceStats {
    const key = `${host}:${port}`;
    let stats = this.sources.get(key);
    if (!stats) {
      stats = { host, port, replies: 0, requests: 0, lastSeen: 0 };
      this.sources.set(key, stats);
    }
    stats.lastSeen = Date.now();
    return stats;
  }

  /* -------------------------------------------------------------- store */

  private remember(request: CacheRequest, reply: CacheReply, from?: string): void {
    if (!reply.cw) return;
    const key = cacheKey(request);
    this.pending.delete(key);
    this.store.set(key, { cw: reply.cw, origin: reply.origin, at: Date.now(), request, from });
    if (this.store.size > this.maxEntries) {
      // Map keeps insertion order, so the oldest key is the first one.
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
  }

  private lookup(request: CacheRequest): Entry | undefined {
    const entry = this.store.get(cacheKey(request));
    if (!entry) {
      this.counters.misses += 1;
      return undefined;
    }
    if (Date.now() - entry.at > this.maxAge) {
      this.store.delete(cacheKey(request));
      this.counters.misses += 1;
      return undefined;
    }
    this.counters.hits += 1;
    return entry;
  }

  private sweep(): void {
    const deadline = Date.now() - this.maxAge;
    for (const [key, entry] of this.store) if (entry.at < deadline) this.store.delete(key);
    for (const [key, at] of this.pending) if (at < deadline) this.pending.delete(key);
    for (const [key, sent] of this.pings) if (sent.at < deadline) this.pings.delete(key);
  }

  /* ------------------------------------------------------------ sending */

  private send(buf: Buffer, host: string, port: number): void {
    this.socket?.send(buf, port, host, (err) => {
      if (err) this.log(`send to ${host}:${port} failed: ${err.message}`);
    });
  }

  private broadcast(buf: Buffer): void {
    for (const peer of this.peers.values()) this.send(buf, peer.host, peer.port);
  }

  ping(): void {
    if (this.peers.size === 0) return;
    const now = Date.now();
    for (const [key, peer] of this.peers) {
      // token = millisecond clock in the high bits, a counter in the low ones,
      // so the reply identifies both the peer and the moment.
      const token = BigInt(now) * 1024n + BigInt(this.pingSeq++ % 1024);
      this.pings.set(String(token), { peer: key, at: now });
      this.send(encode({ type: TYPE_PINGREQ, ping: token, port: this.options.port }), peer.host, peer.port);
    }
    this.counters.sentPings += 1;
  }

  /** Publish an ecm -> cw pair to the cluster (and keep it ourselves). */
  publish(request: CacheRequest, reply: CacheReply): void {
    this.remember(request, reply);
    this.broadcast(encode({ type: TYPE_REPLY, request, reply }));
    this.counters.sentReplies += 1;
  }

  /** Ask the cluster to resend an entry we are missing. */
  requestResend(request: CacheRequest): void {
    this.broadcast(encode({ type: TYPE_RESENDREQ, port: this.options.port, request }));
  }

  get(request: CacheRequest): Buffer | undefined {
    return this.lookup(request)?.cw;
  }

  stats(): CacheStats {
    const c = this.counters;
    return {
      port: this.options.port,
      since: this.started,
      entries: this.store.size,
      pending: this.pending.size,
      received: { replies: c.replies, requests: c.requests, resends: c.resends, pings: c.pings, invalid: c.invalid },
      sent: { replies: c.sentReplies, pings: c.sentPings, pongs: c.sentPongs, resends: c.sentResends },
      hits: c.hits,
      misses: c.misses,
      peers: [...this.peers.values()],
      sources: [...this.sources.values()],
    };
  }

  /** Most recent entries, newest first — what the panel shows as "live cache". */
  recent(limit = 50): Array<{ key: string; age: number; origin?: string; from?: string; caId: number; serviceId: number }> {
    const out = [...this.store.entries()]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, limit)
      .map(([key, e]) => ({
        key,
        age: Math.round((Date.now() - e.at) / 1000),
        origin: e.origin,
        from: e.from,
        caId: e.request.caId,
        serviceId: e.request.serviceId,
      }));
    return out;
  }
}
