#!/usr/bin/env node
/**
 * csp-cache-node — a standalone peer in the CSP cache cluster.
 *
 * It joins the cluster over UDP (same protocol as CardServProxy's
 * ClusteredCache and NCam's csp_port) and publishes what it sees over a tiny
 * HTTP endpoint the panel can read:
 *
 *   GET /stats    counters, peers, round trip times
 *   GET /recent   the newest cache entries
 *   GET /healthz
 *
 * Separate process on purpose: the cache has to stay up and keep state, the
 * panel does not.
 *
 *   CACHE_PORT=54280 CACHE_PEERS=127.0.0.1:54279,127.0.0.1:54278 csp-cache-node
 */
import { createServer } from 'node:http';

import { CspCacheNode, type PeerAddress } from './peer.js';

function parsePeers(value: string | undefined): PeerAddress[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.lastIndexOf(':');
      if (at < 1) throw new Error(`peer "${entry}" should look like host:port`);
      const port = Number(entry.slice(at + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`peer "${entry}" has a bad port`);
      return { host: entry.slice(0, at), port };
    });
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const port = num(process.env.CACHE_PORT, 54280);
  const httpPort = num(process.env.CACHE_HTTP_PORT, 8099);
  const httpHost = process.env.CACHE_HTTP_HOST ?? '127.0.0.1';

  const node = new CspCacheNode({
    port,
    bind: process.env.CACHE_BIND ?? '0.0.0.0',
    peers: parsePeers(process.env.CACHE_PEERS),
    maxAge: num(process.env.CACHE_MAX_AGE, 19),
    maxEntries: num(process.env.CACHE_MAX_ENTRIES, 20_000),
    pingInterval: num(process.env.CACHE_PING_INTERVAL, 10),
    autoAddPeers: process.env.CACHE_AUTO_ADD_PEERS !== '0',
    log: (message) => console.log(`[csp-cache] ${message}`),
  });

  await node.start();

  const http = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    switch (path) {
      case '/healthz':
        return json({ ok: true, port });
      case '/stats':
        return json(node.stats());
      case '/recent':
        return json({ entries: node.recent(Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')) || 50) });
      default:
        return json({ error: 'not found' }, 404);
    }
  });
  // A busy stats port must not take the cache peer down with an unhandled
  // 'error' event and a stack trace nobody can act on.
  http.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[csp-cache] stats port ${httpHost}:${httpPort} is already in use — set CACHE_HTTP_PORT`);
    } else {
      console.error(`[csp-cache] stats server: ${err.message}`);
    }
    void node.stop().finally(() => process.exit(1));
  });
  http.listen(httpPort, httpHost, () => console.log(`[csp-cache] stats on http://${httpHost}:${httpPort}/stats`));

  const bye = async () => {
    await node.stop();
    http.close();
    process.exit(0);
  };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}

main().catch((err) => {
  console.error(`[csp-cache] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
