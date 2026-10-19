import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/store.mjs';
import { createApi } from './src/api.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = resolve(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  'referrer-policy': 'no-referrer',
};

export function createServer({ dataDir = resolve(ROOT, 'data', 'runtime'), seed = 42 } = {}) {
  const store = createStore({ dataDir, seed });
  const api = createApi(store);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, SECURITY_HEADERS);
        return res.end('method not allowed');
      }
      await serveStatic(url.pathname, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = resolve(PUBLIC, normalize(rel));
  if (!file.startsWith(PUBLIC + sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end('forbidden');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(body);
  } catch {
    res.writeHead(404, SECURITY_HEADERS);
    res.end('not found');
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 4310);
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`supply-chain planner listening on http://127.0.0.1:${port}`);
  });
}
