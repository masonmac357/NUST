// Jarvis local server: serves the app and relays model requests to the
// providers you connect. Binds to 127.0.0.1 only.
//
//   node server.js              -> http://127.0.0.1:4173
//   PORT=8080 node server.js
//   JARVIS_LOG_REQUESTS=1 node server.js   (print outgoing requests, keys hidden)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'host']);

function redact(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = /authorization|api-key/i.test(k) ? '(hidden)' : v;
  return out;
}

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleProxy(req, res, opts) {
  // A custom header forces a CORS preflight for cross-site pages, which this
  // server never approves, so only the Jarvis page itself can use the relay.
  if (req.headers['x-jarvis-proxy'] !== '1' || req.method !== 'POST') {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Forbidden' }));
  }
  let env;
  try { env = JSON.parse(await readBody(req)); } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: `Bad relay request: ${e.message}` }));
  }
  let target;
  try { target = new URL(env.url); } catch {
    res.writeHead(599, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: `"${env.url}" is not a valid URL. Check the connection's base URL.` }));
  }
  if (!/^https?:$/.test(target.protocol)) {
    res.writeHead(599, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: 'Only http and https URLs can be used.' }));
  }
  const method = (env.method || 'POST').toUpperCase();
  const headers = { ...(env.headers || {}) };
  const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(env.body ?? {});
  if (opts.log) console.log(`[jarvis] -> ${method} ${target.href}\n${JSON.stringify({ headers: redact(headers), body: env.body }, null, 2)}`);
  opts.onRequest?.({ url: target.href, method, headers: redact(headers), body: env.body });

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  let upstream;
  try {
    upstream = await fetch(target, { method, headers, body, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return;
    const cause = e.cause?.code || e.cause?.message || e.message;
    res.writeHead(599, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ message: `Could not reach ${target.host} (${cause}). Is the server running and the base URL right?` }));
  }
  const out = {};
  upstream.headers.forEach((v, k) => { if (!HOP.has(k)) out[k] = v; });
  out['cache-control'] = 'no-store';
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}

async function handleStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'permissions-policy': 'microphone=(self)',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

export function createServer(opts = {}) {
  return http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/proxy') {
      handleProxy(req, res, opts).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: e.message }));
      });
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      handleStatic(req, res);
    } else {
      res.writeHead(405); res.end();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  createServer({ log: process.env.JARVIS_LOG_REQUESTS === '1' }).listen(port, host, () => {
    console.log(`Jarvis is running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  });
}
