// Test harness: the real Jarvis server, a mock provider that records every
// request it receives, and scripted browser speech fakes.

import http from 'node:http';
import { createServer } from '../../server.js';

export async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

// A provider double that speaks both the OpenAI chat format and the
// Anthropic messages format, and records the exact bodies it receives.
export function mockProvider() {
  const received = [];
  const rules = { rejectParam: null };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : null;
    received.push({ method: req.method, path: req.url, headers: req.headers, body });
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      if (req.headers['x-api-key']) return json(200, { data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-5-5' }] });
      return json(200, { data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1' }, { id: 'text-embedding-3-small' }] });
    }
    const reply = `Mock reply from ${body?.model}. What matters most to you here?\n<replies>["Speed", "Cost"]</replies>`;
    if (req.url === '/v1/chat/completions') {
      if (rules.rejectParam && body[rules.rejectParam] !== undefined) {
        return json(400, { error: { message: `Unsupported value for '${rules.rejectParam}' on this model.`, type: 'invalid_request_error', param: rules.rejectParam } });
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of reply.match(/.{1,12}/gs)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      return json(200, { id: 'x', model: body.model, choices: [{ message: { role: 'assistant', content: reply } }] });
    }
    if (req.url === '/v1/messages') {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start' })}\n\n`);
        for (const piece of reply.match(/.{1,12}/gs)) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: piece } })}\n\n`);
        res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        return;
      }
      return json(200, { id: 'm', type: 'message', model: body.model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' });
    }
    json(404, { error: { message: 'not found' } });
  });
  return { server, received, rules };
}

export async function startStack() {
  const relayed = [];
  const app = createServer({ onRequest: (r) => relayed.push(r) });
  const appUrl = await listen(app);
  const mock = mockProvider();
  const mockUrl = await listen(mock.server);
  return {
    appUrl, mockUrl, relayed, mock,
    async stop() { app.close(); mock.server.close(); app.closeAllConnections?.(); mock.server.closeAllConnections?.(); },
  };
}

// Scripted stand-ins for SpeechRecognition and speechSynthesis. Every event
// is logged to window.__speechLog so tests can check ordering, e.g. that the
// recogniser is never running while Jarvis is speaking.
export const SPEECH_FAKES = `
(() => {
  const log = window.__speechLog = [];
  window.__heard = ['I want to plan a community garden'];
  window.__speakMs = 1200;
  let active = null;
  class FakeRecognition {
    constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; }
    start() {
      if (active) throw new Error('already started');
      active = this;
      log.push({ t: performance.now(), e: 'rec-start', speaking: window.speechSynthesis.speaking });
      const text = window.__heard.length ? window.__heard.shift() : '';
      const words = text.split(' ');
      const half = words.slice(0, Math.ceil(words.length / 2)).join(' ');
      const res = (t, final) => { const alt = [{ transcript: t, confidence: 0.9 }]; alt.isFinal = final; const list = [alt]; return { results: list, resultIndex: 0 }; };
      this._t1 = setTimeout(() => { if (text) { log.push({ e: 'rec-interim' }); this.onresult && this.onresult(res(half, false)); } }, 250);
      this._t2 = setTimeout(() => { if (text) { log.push({ e: 'rec-final' }); this.onresult && this.onresult(res(text, true)); } this._end(); }, 700);
    }
    _end() { if (active !== this) return; active = null; log.push({ e: 'rec-end' }); this.onend && this.onend(); }
    stop() { clearTimeout(this._t1); clearTimeout(this._t2); this._end(); }
    abort() { clearTimeout(this._t1); clearTimeout(this._t2); if (active === this) { active = null; log.push({ e: 'rec-abort' }); this.onend && this.onend(); } }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;

  const synth = {
    speaking: false, _timers: [], _current: null,
    getVoices() { return [{ name: 'Test Voice A', lang: 'en-US', voiceURI: 'test-a', localService: true }, { name: 'Test Voice B', lang: 'en-GB', voiceURI: 'test-b', localService: true }, { name: 'Voz', lang: 'es-ES', voiceURI: 'test-es', localService: true }]; },
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
