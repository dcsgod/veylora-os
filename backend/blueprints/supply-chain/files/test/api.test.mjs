import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';

let server;
let base;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scp-'));
  server = createServer({ dataDir: dir, seed: 42 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};
const post = async (p, body, type = 'application/json') => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('health and summary', async () => {
  assert.deepEqual((await get('/api/health')).body, { ok: true, synthetic: true });
  const s = (await get('/api/summary')).body;
  assert.equal(s.products, 8);
  assert.equal(s.locations, 3);
});

test('serves the UI and blocks traversal', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Supply-chain planner/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const t = await fetch(`${base}/..%2fserver.mjs`);
  assert.equal(t.status, 403);
});

test('create supplier persists; invalid supplier rejected', async () => {
  const ok = await post('/api/suppliers', { id: 'SUP-Z', name: 'Zed', leadTimeDays: 10, minOrderQty: 5, reliability: 0.9 });
  assert.equal(ok.status, 201);
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  assert.ok(state.suppliers.some((s) => s.id === 'SUP-Z'));
  const bad = await post('/api/suppliers', { id: 'SUP-Y', name: 'Y', leadTimeDays: -3, minOrderQty: 5, reliability: 0.9 });
  assert.equal(bad.status, 422);
});

test('referential integrity is enforced', async () => {
  const r = await post('/api/inventory', { sku: 'SKU-NOPE', locationId: 'WH-EAST', onHand: 1, onOrder: 0 });
  assert.equal(r.status, 422);
  assert.match(r.body.errors[0], /unknown sku/);
});

test('CSV ingest applies valid rows and reports invalid ones', async () => {
  const csv = 'sku,locationId,onHand,onOrder\nSKU-1001,WH-EAST,999,0\nSKU-1001,WH-WEST,-1,0\n';
  const r = await post('/api/ingest/inventory', csv, 'text/csv');
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, 1);
  assert.equal(r.body.errors.length, 1);
  const inv = (await get('/api/inventory')).body.find((i) => i.sku === 'SKU-1001' && i.locationId === 'WH-EAST');
  assert.equal(inv.onHand, 999);
});

test('forecast, replenishment and capacity endpoints', async () => {
  const f = await get('/api/forecast?sku=SKU-2001&method=holt&horizon=4');
  assert.equal(f.status, 200);
  assert.equal(f.body.forecast.length, 4);
  assert.equal(f.body.backtest.length, 3);
  assert.equal((await get('/api/forecast?method=nope')).status, 400);
  assert.equal((await get('/api/forecast?sku=MISSING')).status, 404);
  assert.equal((await get('/api/replenishment?serviceLevel=0.99')).status, 200);
  assert.equal((await get('/api/replenishment?serviceLevel=2')).status, 400);
  assert.equal((await get('/api/capacity')).body.length, 3);
});

test('scenarios are run, saved and validated', async () => {
  const r = await post('/api/scenarios', { name: 'Surge', params: { demandMultiplier: 1.4, disruptedSupplierId: 'SUP-C' } });
  assert.equal(r.status, 201);
  assert.ok(r.body.summary.scenarioOrderValue >= 0);
  const list = (await get('/api/scenarios')).body;
  assert.equal(list[0].name, 'Surge');
  assert.equal((await post('/api/scenarios', { params: { demandMultiplier: 99 } })).status, 400);
  assert.ok(existsSync(join(dir, 'state.json')));
});

test('malformed JSON returns 400', async () => {
  const r = await post('/api/products', '{not json');
  assert.equal(r.status, 400);
});
