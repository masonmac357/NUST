// Test harness: the real Jarvis server, a mock of Anthropic's Messages API
// that records every request it receives, and scripted browser speech fakes.

import http from 'node:http';
import { createServer } from '../../server.js';
import { demoReply } from './scripted-claude.mjs';

export const GOOD_KEY = 'sk-ant-test-good';

export async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

// Mock Anthropic. Replies follow the coaching format via the scripted double.
// Message text can trigger special cases: REFUSE, FALLBACK, SLOW.
export function mockAnthropic() {
  const received = [];
  const rules = { rejectParam: null };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    received.push({ method: req.method, path: req.url, headers: req.headers, body });
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-api-key'] !== GOOD_KEY) {
      return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      return json(200, { data: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-5'].map((id) => ({ id, type: 'model', display_name: id, max_tokens: id.endsWith('4-5') ? 64000 : 128000 })) });
    }
    if (req.url !== '/v1/messages') return json(404, { error: { message: 'not found' } });
    if (rules.rejectParam && body[rules.rejectParam] !== undefined) {
      return json(400, { type: 'error', error: { type: 'invalid_request_error', message: `${rules.rejectParam}: not supported for this request` } });
    }
    const last = body.messages.at(-1)?.content || '';
    if (/SLOW/.test(last)) await new Promise((r) => setTimeout(r, 4000));
    let model = body.model;
    const content = [];
    let stop = 'end_turn';
    let details = null;
    let text = demoReply(body.messages);
    if (/REFUSE/.test(last)) { text = ''; stop = 'refusal'; details = { type: 'refusal', category: 'cyber', explanation: null }; }
    if (/FALLBACK/.test(last) && body.fallbacks === 'default') {
      content.push({ type: 'fallback', from: { model }, to: { model: 'claude-opus-4-8' } });
      model = 'claude-opus-4-8';
    }
    if (text) content.push({ type: 'text', text });
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { model, content: [] } });
      for (const piece of text.match(/[\s\S]{1,12}/g) || []) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
      ev('message_delta', { delta: { stop_reason: stop, stop_details: details } });
      ev('message_stop', {});
      return res.end();
    }
    return json(200, { id: 'msg_1', type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_details: details });
  });
  return { server, received, rules };
}

export async function startStack() {
  const relayed = [];
  const mock = mockAnthropic();
  const mockUrl = await listen(mock.server);
  const app = createServer({ onRequest: (r) => relayed.push(r), redirectAnthropicTo: mockUrl });
  const appUrl = await listen(app);
  return {
    appUrl, mockUrl, relayed, mock,
    async stop() { app.closeAllConnections?.(); mock.server.closeAllConnections?.(); app.close(); mock.server.close(); },
  };
}

// Scripted stand-ins for SpeechRecognition and speechSynthesis. Every event
// is logged to window.__speechLog. window.__localSpeech sets what on-device
// recognition reports: 'available' (default), 'unavailable', or 'none' (the
// browser has no on-device API at all).
export const SPEECH_FAKES = `
(() => {
  const log = window.__speechLog = [];
  window.__heard = ['I want to plan a community garden'];
  window.__speakMs = 1200;
  if (!('__localSpeech' in window)) window.__localSpeech = 'available';
  let active = null;
  class FakeRecognition {
    constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; }
    start() {
      if (active) throw new Error('already started');
      active = this;
      log.push({ t: performance.now(), e: 'rec-start', speaking: window.speechSynthesis.speaking, processLocally: this.processLocally === true });
      const text = window.__heard.length ? window.__heard.shift() : '';
      const words = text.split(' ');
      const half = words.slice(0, Math.ceil(words.length / 2)).join(' ');
      const res = (t, final) => { const alt = [{ transcript: t, confidence: 0.9 }]; alt.isFinal = final; return { results: [alt], resultIndex: 0 }; };
      this._t1 = setTimeout(() => { if (text) { log.push({ e: 'rec-interim' }); this.onresult && this.onresult(res(half, false)); } }, 250);
      this._t2 = setTimeout(() => { if (text) { log.push({ e: 'rec-final' }); this.onresult && this.onresult(res(text, true)); } this._end(); }, 700);
    }
    _end() { if (active !== this) return; active = null; log.push({ e: 'rec-end' }); this.onend && this.onend(); }
    stop() { clearTimeout(this._t1); clearTimeout(this._t2); this._end(); }
    abort() { clearTimeout(this._t1); clearTimeout(this._t2); if (active === this) { active = null; log.push({ e: 'rec-abort' }); this.onend && this.onend(); } }
  }
  if (window.__localSpeech !== 'none') {
    FakeRecognition.available = async (o) => { log.push({ e: 'available', o }); return window.__localSpeech; };
    FakeRecognition.install = async () => false;
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;

  const synth = {
    speaking: false, _timers: [], _current: null,
    getVoices() { return [
      { name: 'Online Voice', lang: 'en-US', voiceURI: 'online-us', localService: false },
      { name: 'Test Voice A', lang: 'en-US', voiceURI: 'test-a', localService: true },
      { name: 'Test Voice B', lang: 'en-GB', voiceURI: 'test-b', localService: true },
    ]; },
    addEventListener() {},
    speak(u) {
      this.speaking = true; this._current = u;
      log.push({ t: performance.now(), e: 'speak', text: u.text, rate: u.rate, voice: u.voice && u.voice.voiceURI, recActive: !!active });
      const dur = Math.max(150, window.__speakMs / (u.rate || 1));
      for (let i = 100; i < dur; i += 100) this._timers.push(setTimeout(() => u.onboundary && u.onboundary({}), i));
      this._timers.push(setTimeout(() => { this.speaking = false; this._current = null; log.push({ e: 'speak-end' }); u.onend && u.onend({}); }, dur));
    },
    cancel() {
      this._timers.forEach(clearTimeout); this._timers = [];
      if (this._current) { const u = this._current; this._current = null; this.speaking = false; log.push({ e: 'cancel' }); u.onerror && u.onerror({ error: 'interrupted' }); }
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
})();
`;
