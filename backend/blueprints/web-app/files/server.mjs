import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, send } from './src/http.mjs';
import { createStore } from './src/store.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const HEADERS = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:", 'referrer-policy': 'no-referrer' };
const COLLECTION = /^[a-z][a-z0-9-]{0,40}$/;

// Feature modules may export `routes(store)` returning [{ method, path, handler(req, res, ctx) }].
async function loadFeatureRoutes(store) {
  const file = resolve(ROOT, 'src', 'features.mjs');
  if (!existsSync(file)) return [];
  const mod = await import(pathToFileURL(file).href);
  return typeof mod.routes === 'function' ? mod.routes(store) : [];
}

export async function createServer({ dataDir = resolve(ROOT, 'data', 'runtime') } = {}) {
  const store = createStore({ dataDir });
  const featureRoutes = await loadFeatureRoutes(store);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api') {
        if (parts[1] === 'health') return send(res, 200, { ok: true });
        const feature = featureRoutes.find((r) => r.method === req.method && r.path === url.pathname);
        if (feature) return await feature.handler(req, res, { url, store, send, readJson });
        const [, collection, id] = parts;
        if (!collection || !COLLECTION.test(collection)) return send(res, 404, { error: 'not found' });
        if (req.method === 'GET' && !id) return send(res, 200, store.list(collection));
        if (req.method === 'GET') {
          const rec = store.get(collection, id);
          return rec ? send(res, 200, rec) : send(res, 404, { error: 'not found' });
        }
        if (req.method === 'POST' && !id) {
          const result = store.put(collection, await readJson(req));
          return send(res, result.created ? 201 : 200, result.record);
        }
        if (req.method === 'DELETE' && id) return store.remove(collection, id) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not found' });
        return send(res, 405, { error: 'method not allowed' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = resolve(PUBLIC, normalize(rel));
      if (!file.startsWith(PUBLIC + sep)) {
        res.writeHead(403, HEADERS);
        return res.end('forbidden');
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...HEADERS });
        return res.end(body);
      } catch {
        res.writeHead(404, HEADERS);
        return res.end('not found');
      }
    } catch (err) {
      if (!err.status) console.error(err);
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'internal error' });
    }
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 4330);
  (await createServer()).listen(port, '127.0.0.1', () => console.log(`app listening on http://127.0.0.1:${port}`));
}
