import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ResellerStore } from '../src/resellers.js';
import { daysUntil, digest, expiringSoon, notifyExpiring, sendTelegram } from '../src/notify.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const store = () => new ResellerStore(join(mkdtempSync(join(tmpdir(), 'csp-notify-')), 'r.json'));

function seeded() {
  const db = store();
  const juan = db.create('juan', 'juanpw', 10);
  const ana = db.create('ana', 'anapw', 10);
  db.claim('manana', juan.id, '2026-10-06');
  db.claim('hoy', juan.id, '2026-10-05');
  db.claim('ayer', juan.id, '2026-10-04');
  db.claim('lejos', juan.id, '2026-12-01');
  db.claim('deana', ana.id, '2026-10-07');
  db.claim('mio', 'admin', '2026-10-06');
  db.claim('sinfecha', juan.id);
  return { db, juan, ana };
}

test('counts the days the way a human would', () => {
  assert.equal(daysUntil('2026-10-05', NOW), 0, 'today');
  assert.equal(daysUntil('2026-10-06', NOW), 1, 'tomorrow');
  assert.equal(daysUntil('2026-10-04', NOW), -1, 'yesterday');
  assert.equal(daysUntil('2026-11-05', NOW), 31);
});

test('lists what is about to die, soonest first, expired included', () => {
  const { db } = seeded();
  const lines = expiringSoon(db, 3, NOW);
  assert.deepEqual(
    lines.map((l) => [l.name, l.daysLeft, l.owner]),
    [
      ['ayer', -1, 'juan'],
      ['hoy', 0, 'juan'],
      ['manana', 1, 'juan'],
      ['mio', 1, 'admin'],
      ['deana', 2, 'ana'],
    ],
  );
  // Lines with no date, and the ones still far away, are left out.
  assert.ok(!lines.some((l) => ['lejos', 'sinfecha'].includes(l.name)));
  assert.equal(expiringSoon(db, 0, NOW).length, 2, 'today and the overdue one');
});

test('the digest reads like something you can act on', () => {
  const { db } = seeded();
  const text = digest(expiringSoon(db, 1, NOW), 'Líneas que vencen en 1 día(s)', true);
  assert.equal(
    text,
    [
      'Líneas que vencen en 1 día(s)',
      '• ayer — vencida hace 1 d (2026-10-04) · juan',
      '• hoy — vence hoy (2026-10-05) · juan',
      '• manana — 1 d (2026-10-06) · juan',
      '• mio — 1 d (2026-10-06) · admin',
    ].join('\n'),
  );
  assert.equal(digest([], 'x', true), undefined, 'nothing to say, no message');
});

test('each reseller is told about his own lines, and the operator about all', async () => {
  const { db, juan, ana } = seeded();
  db.update(juan.id, { telegramChatId: '111' });
  // ana has no chat id: she simply gets no message.

  const posted: Array<{ chat: string; text: string }> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
    posted.push({ chat: body.chat_id, text: body.text });
    return new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;

  const result = await notifyExpiring({
    resellers: db,
    telegram: { token: 'T', chatId: '999' },
    days: 3,
    now: NOW,
    fetchImpl,
  });

  assert.deepEqual(result.sent, ['operator', 'juan']);
  assert.deepEqual(result.failed, []);
  assert.equal(posted.length, 2);

  const operator = posted.find((p) => p.chat === '999')!;
  assert.match(operator.text, /deana/, 'the operator sees every reseller');
  assert.match(operator.text, /· ana/);

  const forJuan = posted.find((p) => p.chat === '111')!;
  assert.ok(!forJuan.text.includes('deana'), "not another reseller's client");
  assert.ok(!forJuan.text.includes('mio'), 'nor the operator own clients');
  assert.ok(!forJuan.text.includes('·'), 'no owner column: they are all his');
  assert.match(forJuan.text, /ayer|hoy|manana/);
});

test('a telegram failure is reported, not thrown, and never blocks the rest', async () => {
  const { db, juan } = seeded();
  db.update(juan.id, { telegramChatId: '111' });

  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { chat_id: string };
    return body.chat_id === '999'
      ? new Response('bad token', { status: 401 })
      : new Response('{"ok":true}', { status: 200 });
  }) as unknown as typeof fetch;

  const result = await notifyExpiring({
    resellers: db,
    telegram: { token: 'T', chatId: '999' },
    now: NOW,
    fetchImpl,
  });
  assert.deepEqual(result.failed, ['operator']);
  assert.deepEqual(result.sent, ['juan'], 'the reseller still got his');
});

test('talks to a real http endpoint the way telegram expects', async () => {
  const received: Array<{ path: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(data) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  process.env.TELEGRAM_API = `http://127.0.0.1:${port}`;

  try {
    await sendTelegram({ token: 'ABC:123' }, '555', 'hola');
    assert.equal(received[0]!.path, '/botABC:123/sendMessage');
    assert.deepEqual(received[0]!.body, { chat_id: '555', text: 'hola', disable_web_page_preview: true });
  } finally {
    delete process.env.TELEGRAM_API;
    await new Promise((r) => server.close(r));
  }
});
