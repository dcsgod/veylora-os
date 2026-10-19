import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';

let server;
let base;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'app-'));
  server = await createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('health endpoint', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
});

test('serves index and blocks traversal', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fserver.mjs`)).status, 403);
});

test('collection CRUD', async () => {
  const created = await fetch(`${base}/api/items`, { method: 'POST', body: JSON.stringify({ id: 'a', title: 'First' }) });
  assert.equal(created.status, 201);
  assert.equal((await (await fetch(`${base}/api/items`)).json()).length, 1);
  assert.equal((await fetch(`${base}/api/items/a`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/items/a`)).status, 404);
  assert.equal((await fetch(`${base}/api/items`, { method: 'POST', body: '{bad' })).status, 400);
});
