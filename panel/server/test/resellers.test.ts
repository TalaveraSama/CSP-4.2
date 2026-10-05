import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ResellerStore, addMonths, isoDate } from '../src/resellers.js';

const store = () => new ResellerStore(join(mkdtempSync(join(tmpdir(), 'csp-res-')), 'resellers.json'));

test('a reseller logs in with his own password, hashed', () => {
  const db = store();
  const juan = db.create('juan', 'secreta', 50);
  assert.notEqual(juan.password, 'secreta');
  assert.match(juan.password, /^[0-9a-f]{32}:[0-9a-f]{64}$/, 'salt:hash');

  assert.equal(db.login('juan', 'secreta')?.id, juan.id);
  assert.equal(db.login('JUAN', 'secreta')?.id, juan.id, 'the name is case insensitive');
  assert.equal(db.login('juan', 'otra'), undefined);
  assert.equal(db.login('nadie', 'secreta'), undefined);
});

test('a disabled reseller cannot log in, and says why', () => {
  const db = store();
  const r = db.create('juan', 'secreta');
  db.update(r.id, { enabled: false });
  assert.throws(() => db.login('juan', 'secreta'), /disabled/);
});

test('refuses nonsense instead of creating junk', () => {
  const db = store();
  db.create('juan', 'secreta');
  assert.throws(() => db.create('juan', 'otra'), /already exists/);
  assert.throws(() => db.create('con espacios', 'secreta'), /may only contain/);
  assert.throws(() => db.create('ok', 'x'), /too short/);
  assert.throws(() => db.create('ok', 'secreta', -5), /positive whole number/);
});

test('credits are charged per month and never go negative', () => {
  const db = store();
  const r = db.create('juan', 'secreta', 3);

  db.charge(r.id, 1, 'create cliente1');
  assert.equal(db.byId(r.id)?.credits, 2);

  db.charge(r.id, 2, 'renew cliente1 (2 months)');
  assert.equal(db.byId(r.id)?.credits, 0);

  assert.throws(() => db.charge(r.id, 1, 'create cliente2'), /not enough credits: 0 left, 1 needed/);
  assert.equal(db.byId(r.id)?.credits, 0, 'a failed charge changes nothing');

  db.addCredits(r.id, 10, 'top up');
  assert.equal(db.byId(r.id)?.credits, 10);
  assert.throws(() => db.addCredits(r.id, -99), /negative balance/);
});

test('every movement is in the ledger, newest first', () => {
  const db = store();
  const r = db.create('juan', 'secreta', 5);
  db.charge(r.id, 2, 'create cliente1');
  db.addCredits(r.id, 7, 'payment');

  const ledger = db.ledger();
  assert.deepEqual(
    ledger.map((e) => [e.delta, e.balance, e.reason]),
    [
      [7, 10, 'payment'],
      [-2, 3, 'create cliente1'],
      [5, 5, 'initial balance'],
    ],
  );
  db.create('ana', 'otra', 1);
  assert.equal(db.ledger(100, r.id).length, 3, 'filtered by reseller');
});

test('clients belong to someone, and survive their reseller', () => {
  const db = store();
  const juan = db.create('juan', 'secreta', 10);
  db.claim('cliente1', juan.id, '2026-12-31');
  db.claim('cliente2', juan.id);
  db.claim('propio', 'admin');

  assert.deepEqual(db.clientsOf(juan.id).sort(), ['cliente1', 'cliente2']);
  assert.equal(db.owner('cliente1'), juan.id);
  assert.equal(db.record('cliente1')?.expiresAt, '2026-12-31');

  db.remove(juan.id);
  assert.equal(db.owner('cliente1'), 'admin', 'the clients are not cut off');
  assert.equal(db.byId(juan.id), undefined);
});

test('expiry is tracked by the panel, whatever the backend supports', () => {
  const db = store();
  const r = db.create('juan', 'secreta', 10);
  db.claim('vencido', r.id, '2020-01-01');
  db.claim('vigente', r.id, '2999-01-01');
  db.claim('sinfecha', r.id);

  assert.deepEqual(db.expired(), ['vencido']);
  db.setExpiry('vencido', '2999-01-01');
  assert.deepEqual(db.expired(), []);
});

test('adding months clamps the day instead of overflowing', () => {
  assert.equal(isoDate(addMonths(new Date('2026-01-31T00:00:00Z'), 1)), '2026-02-28');
  assert.equal(isoDate(addMonths(new Date('2026-01-15T00:00:00Z'), 2)), '2026-03-15');
  assert.equal(isoDate(addMonths(new Date('2026-11-30T00:00:00Z'), 3)), '2027-02-28');
});

test('the store survives a restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'csp-res-')), 'resellers.json');
  const first = new ResellerStore(path);
  const r = first.create('juan', 'secreta', 4);
  first.claim('cliente1', r.id, '2026-12-31');
  first.charge(r.id, 1, 'create cliente1');

  const second = new ResellerStore(path);
  assert.equal(second.find('juan')?.credits, 3);
  assert.equal(second.owner('cliente1'), r.id);
  assert.equal(second.login('juan', 'secreta')?.id, r.id);

  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes('secreta'), 'the password is never stored in clear');
});
