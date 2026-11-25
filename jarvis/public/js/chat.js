// Send one turn to one model and read the reply. All network calls go through
// the local proxy (server.js) so the browser is not blocked by CORS and keys
// never leave your machine except to the provider you chose.

import { buildRequest, parseError, extractText, extractDelta, redactHeaders } from './providers.js';
import { demoReply, demoStream } from './demo.js';

export class ProviderError extends Error {
  constructor(info) {
    super(info.message);
    this.name = 'ProviderError';
    Object.assign(this, info);
  }
}

export async function sendViaProxy(req, signal) {
  const res = await fetch('proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis-proxy': '1' },
    body: JSON.stringify({ url: req.url, method: req.method || 'POST', headers: req.headers, body: req.body }),
    signal,
  });
  if (res.status === 599) {
    const info = await res.json().catch(() => ({}));
    throw new ProviderError({ message: info.message || 'Could not reach the provider.', network: true, param: null });
  }
  return res;
}

async function* readSSE(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* ignore keep-alives */ }
    }
  }
}

async function* readNDJSON(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) { try { yield JSON.parse(line); } catch { /* skip */ } }
    }
  }
  if (buf.trim()) { try { yield JSON.parse(buf); } catch { /* skip */ } }
}

// Returns { text, request } and calls onDelta(fullTextSoFar) while streaming.
export async function runTurn({ conn, model, meta, saved, system, messages, signal, onDelta }) {
  const req = buildRequest({ conn, model, meta, saved, system, messages });
  const shown = {
    url: req.url,
    method: req.method,
    headers: redactHeaders(req.headers),
    body: req.body,
    skipped: req.skipped,
  };

  if (conn.providerId === 'demo') {
    const full = demoReply(messages, { temperature: req.body.temperature });
    let text = '';
    const streaming = req.body.stream === true;
    for await (const part of demoStream(full, { signal, maxTokens: req.body.max_tokens, delay: streaming ? 18 : 0 })) {
      text += part;
      if (streaming) onDelta?.(text);
    }
    if (!streaming) {
      // A short, interruptible pause so the waiting state is visible.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 700);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
    return { text, request: shown };
  }

  const res = await sendViaProxy(req, signal);
  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError({ ...parseError(conn.providerId, model, meta, res.status, body), request: shown });
  }
  const ct = res.headers.get('content-type') || '';
  let text = '';
  if (ct.includes('event-stream')) {
    for await (const evt of readSSE(res)) {
      const d = extractDelta(req.kind, evt);
      if (d.error) throw new ProviderError({ ...parseError(conn.providerId, model, meta, 200, JSON.stringify(evt)), request: shown });
      if (d.delta) { text += d.delta; onDelta?.(text); }
    }
  } else if (ct.includes('ndjson') || (req.kind === 'ollama' && req.stream)) {
    for await (const evt of readNDJSON(res)) {
      const d = extractDelta(req.kind, evt);
      if (d.error) throw new ProviderError({ ...parseError(conn.providerId, model, meta, 200, JSON.stringify(evt)), request: shown });
      if (d.delta) { text += d.delta; onDelta?.(text); }
    }
  } else {
    const json = await res.json();
    text = extractText(req.kind, json);
  }
  return { text, request: shown };
}

export async function discoverModels(conn, provider) {
  const d = provider.discover(conn);
  const res = await sendViaProxy({ url: d.url, method: 'GET', headers: d.headers }, undefined);
  const body = await res.text();
  if (!res.ok) {
    const info = parseError(conn.providerId, '', null, res.status, body);
    throw new ProviderError(info);
  }
  let json;
  try { json = JSON.parse(body); } catch { throw new ProviderError({ message: 'The server answered, but not with a model list.' }); }
  return provider.parseModels(json);
}
