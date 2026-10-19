import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { createFromTemplate } from '../src/templates.mjs';

let server;
let base;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'de-'));
  server = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('serves UI, browser modules, and blocks server-only and traversal paths', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Design editor/);
  const mod = await fetch(`${base}/src/model.mjs`);
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/src/store.mjs`)).status, 403);
  assert.equal((await fetch(`${base}/src/..%2fserver.mjs`)).status, 403);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 403);
});

test('templates endpoint', async () => {
  const r = await fetch(`${base}/api/templates`);
  assert.equal((await r.json()).length, 4);
});

test('save, list, load and delete a design', async () => {
  const doc = createFromTemplate('presentation-title');
  const put = await fetch(`${base}/api/designs/${doc.id}`, { method: 'PUT', body: JSON.stringify(doc) });
  assert.equal(put.status, 200);
  const list = await (await fetch(`${base}/api/designs`)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].layers, 3);
  const loaded = await (await fetch(`${base}/api/designs/${doc.id}`)).json();
  assert.deepEqual(loaded, doc);
  assert.equal((await fetch(`${base}/api/designs/${doc.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/api/designs/${doc.id}`)).status, 404);
});

test('invalid designs and ids are rejected', async () => {
  const doc = createFromTemplate('blank-square');
  const mismatch = await fetch(`${base}/api/designs/other-id`, { method: 'PUT', body: JSON.stringify(doc) });
  assert.equal(mismatch.status, 422);
  const bad = await fetch(`${base}/api/designs/${doc.id}`, { method: 'PUT', body: JSON.stringify({ ...doc, width: 'big' }) });
  assert.equal(bad.status, 422);
  assert.equal((await fetch(`${base}/api/designs/bad%20id!`)).status, 400);
});
