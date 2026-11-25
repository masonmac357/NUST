// Claude is the only provider. This module knows which controls each Claude
// model supports, how each is spelled in the Messages API, how to build a
// request, how to read a reply, and how to read a rejection.
//
// Support levels:
//   'yes'       documented for this model family
//   'uncertain' may work, depends on the exact model
//   'no'        rejected by this model; the control is disabled
//
// Pure module: no DOM, no fetch. Used by the app and by the unit tests.

import { PARAMS, checkValue } from './params.js';

export const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const DEFAULT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

// Anthropic requires max_tokens. While the control is on its default, Jarvis
// sends a generous limit so replies are not cut off mid-thought.
export const defaultMaxTokens = (stream) => (stream ? 64000 : 16000);

const yes = (extra = {}) => ({ support: 'yes', ...extra });
const maybe = (note, extra = {}) => ({ support: 'uncertain', note, ...extra });
const no = (note, extra = {}) => ({ support: 'no', note, ...extra });

// ---------------------------------------------------------------- helpers

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

export function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

// --------------------------------------------------------- model families

export function family(model) {
  const m = String(model).toLowerCase();
  if (/claude-(fable|mythos)|claude-(opus|sonnet|haiku)-5|claude-opus-4-[78]/.test(m)) return 'current';
  if (/claude-(opus|sonnet)-4-6/.test(m)) return 'transitional';
  if (/claude-(opus|sonnet|haiku)-4(-[0-5])?|claude-3-7/.test(m)) return 'budget';
  if (/claude-3|claude-2|claude-instant/.test(m)) return 'legacy';
  return 'unknown';
}

function supportsFallbacks(model) {
  return /claude-(fable-5-[12]|mythos-5-[12]|opus-5-5|opus-5(?![-\d])|sonnet-5-5)/.test(String(model).toLowerCase());
}

function caps(model, meta) {
  const fam = family(model);
  const maxOut = meta?.max_tokens || (fam === 'current' || fam === 'transitional' ? 128000 : 64000);
  const p = {
    max_output_tokens: yes({ wire: 'max_tokens', required: true, max: maxOut, note: 'Claude requires this field. While it is on default, Jarvis sends 16,000 (64,000 when streaming) so replies are not cut short.' }),
    stop: yes({ wire: 'stop_sequences' }),
    stream: yes(),
  };
  const sampling = (s) => ({ temperature: { ...s, min: 0, max: 1 }, top_p: { ...s }, top_k: { ...s, max: 500 } });
  if (fam === 'current') {
    Object.assign(p, sampling(no('This Claude model rejects sampling settings; use reasoning effort to steer it.')));
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    const defNote = /opus-5-5|haiku-5-5/.test(model) ? 'Claude’s default on this model is medium.' : 'Claude’s default on this model is high.';
    p.reasoning_effort = yes({ wire: 'output_config.effort', options: levels, note: defNote });
    p.reasoning_budget = no('This model thinks adaptively; use reasoning effort instead.');
  } else if (fam === 'transitional') {
    Object.assign(p, sampling(yes()));
    p.reasoning_effort = yes({ wire: 'output_config.effort', options: ['low', 'medium', 'high', 'max'] });
    p.reasoning_budget = maybe('Deprecated on this model; prefer reasoning effort.', { min: 1024 });
  } else if (fam === 'budget') {
    Object.assign(p, sampling(yes()));
    p.reasoning_effort = /opus-4-5/.test(model) ? yes({ wire: 'output_config.effort', options: ['low', 'medium', 'high'] }) : no('This Claude model has no effort setting.');
    p.reasoning_budget = yes({ min: 1024 });
  } else if (fam === 'legacy') {
    Object.assign(p, sampling(yes()));
    p.reasoning_effort = no('This Claude model has no effort setting.');
    p.reasoning_budget = no('This Claude model cannot think before answering.');
  } else {
    const note = 'Unrecognised Claude model id; support depends on the model.';
    Object.assign(p, sampling(maybe(note)));
    p.reasoning_effort = maybe(note, { wire: 'output_config.effort', options: ['low', 'medium', 'high', 'xhigh', 'max'] });
    p.reasoning_budget = maybe(note, { min: 1024 });
  }
  return p;
}

function extras(model) {
  const fam = family(model);
  const adaptive = fam === 'current' || fam === 'transitional';
  const out = [
    {
      id: 'thinking_display', label: 'Thinking summary', type: 'enum', options: ['summarized', 'omitted'], wire: 'thinking.display', also: { 'thinking.type': 'adaptive' },
      support: adaptive ? 'yes' : 'no', note: adaptive ? 'Jarvis hides thinking from the chat either way; this only changes what Claude returns.' : 'Only models that think adaptively offer this.',
      desc: 'Whether Claude returns a readable summary of its reasoning alongside the answer.',
    },
    {
      id: 'inference_geo', label: 'Inference region', type: 'enum', options: ['global', 'us'], wire: 'inference_geo',
      support: adaptive ? 'yes' : 'no', note: adaptive ? null : 'Available on Claude 4.6 and later.',
      desc: 'Where Anthropic runs the model for this request.',
    },
  ];
  if (supportsFallbacks(model)) {
    out.push({
      id: 'refusal_fallback', label: 'Refusal fallback', type: 'boolean', jarvisDefault: true, support: 'yes',
      desc: 'If Claude’s safety checks decline a request, let Anthropic retry it on another Claude model inside the same call.',
      note: 'On by default in Jarvis (sends fallbacks: "default" with a beta header). The reply says when a fallback answered. Set Off to leave it out.',
    });
  }
  return out;
}

// ------------------------------------------------- capabilities & settings

export function describeControls(model, meta) {
  const c = caps(model, meta);
  const common = [];
  for (const [id, base] of Object.entries(PARAMS)) {
    const cap = c[id] || { support: 'no', note: 'Claude does not offer this setting.' };
    const def = { ...base, ...cap, id, label: base.label, desc: base.desc };
    if (cap.options) def.options = cap.options;
    def.wire = cap.wire || WIRE[id] || null;
    common.push(def);
  }
  return { common, extras: extras(model).map((e) => ({ ...e, extra: true })) };
}

const WIRE = { temperature: 'temperature', top_p: 'top_p', top_k: 'top_k', stop: 'stop_sequences', stream: 'stream', reasoning_effort: 'output_config.effort' };

// Split saved settings into what will be sent and what is skipped.
export function effectiveParams(model, meta, saved = {}) {
  const { common, extras: ex } = describeControls(model, meta);
  const send = {};
  const sendExtras = {};
  const skipped = [];
  for (const def of common) {
    const v = saved.params?.[def.id];
    if (v === undefined) continue;
    if (def.support === 'no') skipped.push({ id: def.id, label: def.label, reason: def.note || 'Not supported by this model.' });
    else send[def.id] = v;
  }
  for (const def of ex) {
    let v = saved.params?.[def.id];
    if (v === undefined && def.jarvisDefault !== undefined) v = def.jarvisDefault;
    if (v === undefined) continue;
    if (def.support === 'no') { if (saved.params?.[def.id] !== undefined) skipped.push({ id: def.id, label: def.label, reason: def.note }); continue; }
    sendExtras[def.id] = v;
  }
  return { params: send, extraParams: sendExtras, skipped, common, extras: ex };
}

// Validate values, ranges and combinations: [{ param, level, message }].
// Errors block sending.
export function validateSettings(model, meta, saved = {}) {
  const issues = [];
  const { params, common, extras: ex } = effectiveParams(model, meta, saved);
  const byId = Object.fromEntries([...common, ...ex].map((d) => [d.id, d]));
  for (const [id, v] of Object.entries(saved.params || {})) {
    const def = byId[id];
    if (!def) continue;
    if (def.support === 'no') {
      issues.push({ param: id, level: 'warning', message: `${def.label} is not supported by ${model}, so Jarvis will leave it out.` });
      continue;
    }
    const err = checkValue(def, v);
    if (err) issues.push({ param: id, level: 'error', message: err });
  }
  const has = (id) => params[id] !== undefined;
  const maxTokens = params.max_output_tokens ?? defaultMaxTokens(params.stream === true);
  if (has('reasoning_budget')) {
    if (params.reasoning_budget < 1024) issues.push({ param: 'reasoning_budget', level: 'error', message: 'Claude needs a reasoning budget of at least 1024 tokens.' });
    if (params.reasoning_budget >= maxTokens) issues.push({ param: 'reasoning_budget', level: 'error', message: `The reasoning budget must be smaller than the output token limit (${maxTokens}).` });
    for (const id of ['temperature', 'top_k']) {
      if (has(id)) issues.push({ param: id, level: 'error', message: `Claude does not allow ${byId[id].label.toLowerCase()} changes while a reasoning budget is set.` });
    }
    if (has('top_p') && params.top_p < 0.95) issues.push({ param: 'top_p', level: 'error', message: 'With a reasoning budget, Claude only accepts top-p between 0.95 and 1.' });
    if (has('reasoning_effort')) issues.push({ param: 'reasoning_effort', level: 'warning', message: 'Reasoning effort and a reasoning budget overlap; Claude may reject the pair.' });
  }
  if (has('temperature') && has('top_p')) issues.push({ param: 'top_p', level: 'warning', message: 'Recent Claude models reject temperature and top-p together. Change only one if the request fails.' });
  if (!has('max_output_tokens') && params.stream !== true && family(model) !== 'legacy') {
    // fine: 16,000 is safe for non-streaming requests
  }
  if (has('max_output_tokens') && params.max_output_tokens > 21333 && params.stream !== true) {
    issues.push({ param: 'max_output_tokens', level: 'warning', message: 'Large output limits can time out without streaming. Turn Streaming on if long replies fail.' });
  }
  const extra = saved.extra;
  if (extra !== undefined && (typeof extra !== 'object' || extra === null || Array.isArray(extra))) {
    issues.push({ param: '__extra', level: 'error', message: 'Advanced JSON must be an object, like {"key": "value"}.' });
  } else if (extra) {
    for (const k of Object.keys(extra)) {
      if (['model', 'messages', 'system'].includes(k)) {
        issues.push({ param: '__extra', level: 'error', message: `"${k}" is managed by Jarvis and cannot be set in Advanced JSON.` });
      } else if (['temperature', 'top_p', 'top_k', 'max_tokens', 'stop_sequences', 'stream'].includes(k)) {
        issues.push({ param: '__extra', level: 'warning', message: `"${k}" in Advanced JSON overrides the matching control.` });
      }
    }
  }
  return issues;
}

// Build the exact outgoing request.
export function buildRequest({ conn, model, meta, saved, system, messages }) {
  const eff = effectiveParams(model, meta, saved);
  const { params } = eff;
  const caps_ = Object.fromEntries(eff.common.map((d) => [d.id, d]));
  const stream = params.stream === true;
  const body = {
    model,
    max_tokens: params.max_output_tokens ?? defaultMaxTokens(stream),
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  for (const [id, value] of Object.entries(params)) {
    if (id === 'max_output_tokens') continue;
    if (id === 'reasoning_budget') { body.thinking = { type: 'enabled', budget_tokens: value }; continue; }
    const wire = caps_[id]?.wire || WIRE[id];
    if (wire) setPath(body, wire, value);
  }
  const headers = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION };
  if (conn.apiKey) headers['x-api-key'] = conn.apiKey;
  for (const def of eff.extras) {
    const v = eff.extraParams[def.id];
    if (v === undefined) continue;
    if (def.id === 'refusal_fallback') {
      if (v === true) { body.fallbacks = 'default'; headers['anthropic-beta'] = FALLBACK_BETA; }
      continue;
    }
    setPath(body, def.wire, v);
    if (def.also) for (const [p, val] of Object.entries(def.also)) setPath(body, p, val);
  }
  deepMerge(body, saved?.extra || {});
  return { url: `${trimSlash(conn.baseUrl || DEFAULT_BASE_URL)}/messages`, method: 'POST', headers, body, skipped: eff.skipped, stream };
}

export function discoverRequest(conn) {
  return { url: `${trimSlash(conn.baseUrl || DEFAULT_BASE_URL)}/models?limit=100`, method: 'GET', headers: { 'x-api-key': conn.apiKey || '', 'anthropic-version': ANTHROPIC_VERSION } };
}

export function parseModels(json) {
  return (Array.isArray(json?.data) ? json.data : []).filter((m) => m && m.id).map((m) => ({ id: m.id, meta: m }));
}

export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = /authorization|api-key/i.test(k) ? (v ? '•••• (hidden)' : v) : v;
  return out;
}

// --------------------------------------------------------- reading replies

// Full (non-streaming) response -> { text, model, stopReason, stopDetails, fallback }
export function readMessage(json) {
  const content = Array.isArray(json?.content) ? json.content : [];
  const fb = content.find((b) => b.type === 'fallback');
  return {
    text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    model: json?.model || null,
    stopReason: json?.stop_reason || null,
    stopDetails: json?.stop_details || null,
    fallback: fb ? { from: fb.from?.model, to: fb.to?.model } : null,
  };
}

// One streaming event -> partial info.
export function readEvent(evt) {
  if (!evt) return {};
  if (evt.type === 'error' || evt.error) return { error: evt.error?.message || JSON.stringify(evt.error || evt) };
  if (evt.type === 'message_start') return { model: evt.message?.model };
  if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') return { delta: evt.delta.text };
  if (evt.type === 'content_block_start' && evt.content_block?.type === 'fallback') {
    return { fallback: { from: evt.content_block.from?.model, to: evt.content_block.to?.model } };
  }
  if (evt.type === 'message_delta') return { stopReason: evt.delta?.stop_reason, stopDetails: evt.delta?.stop_details };
  return {};
}

// Read a rejection: { message, param, status }, where param is the id of the
// control Claude complained about, when it can be told.
export function parseError(model, meta, status, text) {
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const errObj = json?.error;
  let message = (typeof errObj === 'string' ? errObj : errObj?.message) || json?.message || String(text || '').slice(0, 400) || `HTTP ${status}`;
  if (typeof message !== 'string') message = JSON.stringify(message);
  const haystack = message.toLowerCase();
  const { common, extras: ex } = describeControls(model, meta);
  const candidates = [];
  for (const d of [...common, ...ex]) {
    const names = new Set([d.id]);
    if (d.wire) { names.add(d.wire); names.add(d.wire.split('.').pop()); }
    if (d.id === 'reasoning_budget') { names.add('budget_tokens'); names.add('thinking.budget_tokens'); }
    if (d.id === 'reasoning_effort') { names.add('effort'); names.add('output_config.effort'); }
    if (d.id === 'max_output_tokens') names.add('max_tokens');
    if (d.id === 'refusal_fallback') { names.add('fallbacks'); }
    if (d.id === 'thinking_display') names.add('thinking.display');
    for (const n of names) {
      const esc = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = haystack.match(new RegExp(`(^|[^a-z0-9_.])${esc}([^a-z0-9_]|$)`));
      if (m) candidates.push({ id: d.id, at: m.index, len: n.length });
    }
  }
  candidates.sort((a, b) => a.at - b.at || b.len - a.len);
  return { message, param: candidates[0]?.id || null, status };
}
