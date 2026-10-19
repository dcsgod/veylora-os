import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesignStore } from './src/store.mjs';
import { TEMPLATES } from './src/templates.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const STATIC_ROOTS = { '/src/': resolve(ROOT, 'src'), '/': resolve(ROOT, 'public') };
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
};
const SERVER_ONLY = new Set(['store.mjs']);
const MAX_BODY = 12 * 1024 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

export function createServer({ dataDir = resolve(ROOT, 'data', 'runtime') } = {}) {
  const store = createDesignStore(dataDir);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'api') {
        if (parts[1] === 'health') return send(res, 200, { ok: true });
        if (parts[1] === 'templates') return send(res, 200, TEMPLATES);
        if (parts[1] === 'designs' && parts.length === 2 && req.method === 'GET') return send(res, 200, store.list());
        if (parts[1] === 'designs' && parts.length === 3) {
          const id = parts[2];
          if (req.method === 'GET') {
            const doc = store.get(id);
            return doc ? send(res, 200, doc) : send(res, 404, { error: 'not found' });
          }
          if (req.method === 'PUT') {
            const result = store.save(id, await readBody(req));
            return send(res, result.ok ? 200 : 422, result);
          }
          if (req.method === 'DELETE') {
            if (!store.remove(id)) return send(res, 404, { error: 'not found' });
            res.writeHead(204, SECURITY_HEADERS);
            return res.end();
          }
        }
        return send(res, 404, { error: 'not found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      return await serveStatic(url.pathname, res);
    } catch (err) {
      if (!err.status) console.error(err);
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'internal error' });
    }
  });
}

async function serveStatic(pathname, res) {
  const prefix = pathname.startsWith('/src/') ? '/src/' : '/';
  const base = STATIC_ROOTS[prefix];
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(prefix.length));
  const file = resolve(base, normalize(rel));
  if (!file.startsWith(base + sep) || (prefix === '/src/' && (SERVER_ONLY.has(rel) || extname(file) !== '.mjs'))) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end('forbidden');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
    return res.end(body);
  } catch {
    res.writeHead(404, SECURITY_HEADERS);
    return res.end('not found');
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 4320);
  createServer().listen(port, '127.0.0.1', () => console.log(`design editor listening on http://127.0.0.1:${port}`));
}
