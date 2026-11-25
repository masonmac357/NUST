// Send one turn to Claude and read the reply. Calls go through the local
// relay (server.js), which only forwards to Anthropic's API.

import { buildRequest, parseError, readMessage, readEvent, redactHeaders, discoverRequest, parseModels } from './providers.js';

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
    throw new ProviderError({ message: info.message || 'Could not reach Claude.', network: true, param: null });
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
      try { yield JSON.parse(data); } catch { /* keep-alive */ }
    }
  }
}

// Returns { text, request, model, stopReason, stopDetails, fallback }.
export async function runTurn({ conn, model, meta, saved, system, messages, signal, onDelta }) {
  const req = buildRequest({ conn, model, meta, saved, system, messages });
  const shown = { url: req.url, method: req.method, headers: redactHeaders(req.headers), body: req.body, skipped: req.skipped };
  const res = await sendViaProxy(req, signal);
  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError({ ...parseError(model, meta, res.status, body), request: shown });
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('event-stream')) {
    const out = { text: '', model: null, stopReason: null, stopDetails: null, fallback: null };
    for await (const evt of readSSE(res)) {
      const d = readEvent(evt);
      if (d.error) throw new ProviderError({ ...parseError(model, meta, 200, JSON.stringify(evt)), request: shown });
      if (d.model && !out.model) out.model = d.model;
      if (d.fallback) { out.fallback = d.fallback; out.model = d.fallback.to || out.model; }
      if (d.stopReason) { out.stopReason = d.stopReason; out.stopDetails = d.stopDetails || null; }
      if (d.delta) { out.text += d.delta; onDelta?.(out.text); }
    }
    return { ...out, request: shown };
  }
  return { ...readMessage(await res.json()), request: shown };
}

export async function discoverModels(conn) {
  const res = await sendViaProxy(discoverRequest(conn), undefined);
  const body = await res.text();
  if (!res.ok) throw new ProviderError(parseError('', null, res.status, body));
  let json;
  try { json = JSON.parse(body); } catch { throw new ProviderError({ message: 'Anthropic answered, but not with a model list.' }); }
  return parseModels(json);
}
