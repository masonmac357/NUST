import { PARAMS, coerce } from './params.js';
import {
  DEFAULT_MODELS, DEFAULT_BASE_URL, describeControls, effectiveParams, validateSettings,
  buildRequest, redactHeaders, defaultMaxTokens,
} from './providers.js';
import { chooseModel } from './router.js';
import { systemPrompt, parseReply, speakable } from './coach.js';
import { runTurn, discoverModels } from './chat.js';
import { Voice } from './voice.js';
import { Orb } from './orb.js';
import { load, save, uid, settingsKey } from './store.js';

// ------------------------------------------------------------------ state

const state = {
  // Claude is the only provider; anything else saved by an older version is dropped.
  connections: load('connections', []).filter((c) => c.providerId === 'anthropic'),
  settings: load('settings', {}),
  presets: load('presets', []),
  prefs: { selection: 'auto', priority: 'balanced', motion: 'auto', speakTyped: false, handsfree: false, autoExcluded: {}, ...load('prefs', {}) },
  voiceSettings: { voiceURI: '', rate: 1, lang: '', allowCloud: false, ...load('voice', {}) },
  memories: load('memories', []),
  messages: load('conversation', []),
  phase: 'idle',
  controller: null,
  voiceSession: false,
  silentRetries: 0,
  editTarget: null,
  lastTarget: null,
};
// Never resume a half-finished reply from a previous visit.
state.messages = state.messages.filter((m) => m.status !== 'streaming');

function persist() {
  save('connections', state.connections);
  save('settings', state.settings);
  save('presets', state.presets);
  save('prefs', state.prefs);
  save('voice', state.voiceSettings);
  save('memories', state.memories);
  save('conversation', state.messages);
}

// ---------------------------------------------------------------- helpers

const $ = (s, root = document) => root.querySelector(s);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function richText(s) {
  return esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function allModels() {
  const out = [];
  for (const conn of state.connections) {
    for (const model of conn.models) {
      out.push({ key: settingsKey(conn.id, model), conn, connId: conn.id, connName: conn.name, model });
    }
  }
  return out;
}

const findModel = (key) => allModels().find((m) => m.key === key);

function selectionLabel() {
  if (state.prefs.selection === 'auto') return 'Auto';
  const m = findModel(state.prefs.selection);
  return m ? m.model : 'Auto';
}

let toastTimer = 0;
function toast(text, action) {
  const t = $('#toast');
  t.replaceChildren(h('span', { text }));
  if (action) t.append(h('button', { class: 'btn btn-small', type: 'button', text: action.label, onclick: () => { t.hidden = true; action.run(); } }));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 3500);
}

// ------------------------------------------------------------ orb & voice

const orb = new Orb($('#orb'));
orb.setMotion(state.prefs.motion);
document.body.classList.toggle('motion-off', state.prefs.motion === 'off');

const voice = new Voice({
  onListenStart() { setPhase('listening'); },
  onInterim(text) { showTranscript(text); },
  onListenEnd(text) {
    if (text) {
      state.silentRetries = 0;
      showTranscript(text);
      send(text, { voice: true });
    } else if (state.voiceSession && state.prefs.handsfree && state.silentRetries < 2) {
      state.silentRetries++;
      setPhase('idle', 'I didn’t catch that. Listening again…');
      setTimeout(() => { if (state.voiceSession && state.phase === 'idle') voice.startListening(); }, 600);
    } else {
      state.silentRetries = 0;
      setPhase('idle', 'I didn’t catch anything. Tap Talk to try again.');
    }
  },
  onError(err) {
    const privacy = err.code === 'no-local-recognition' || err.code === 'no-local-voice';
    showVoiceNotice(err.message, privacy ? { label: 'Allow browser speech service', run: allowCloudSpeech } : null);
    if (err.code === 'no-local-voice') { setPhase('idle', 'Reply shown, but not read aloud.'); return; }
    state.voiceSession = false;
    setPhase('error', err.code === 'mic-blocked' ? 'Microphone blocked. You can type instead.'
      : privacy ? 'Voice needs your OK. You can type instead.' : 'Voice isn\u2019t available. You can type instead.');
    openComposer(false);
    setTimeout(() => { if (state.phase === 'error') setPhase('idle'); }, 4000);
  },
  onLevel(v) { orb.setLevel(v); },
  onStatus(text) { $('#status').textContent = text; },
  onWord() { orb.word(); },
  onSpeakStart() { setPhase('speaking'); },
  onSpeakEnd(completed) {
    if (state.phase !== 'speaking') return;
    if (completed && state.voiceSession && state.prefs.handsfree) {
      setPhase('idle', 'Your turn…');
      // A short gap lets the room go quiet before the mic opens again.
      setTimeout(() => { if (state.voiceSession && state.phase === 'idle') voice.startListening(); }, 450);
    } else {
      setPhase('idle', completed ? undefined : 'Interrupted. Your turn.');
    }
  },
  onVoices() { if ($('#panel-voice') && !$('#panel-voice').hidden) renderVoicePanel(); },
});
Object.assign(voice.settings, state.voiceSettings);

const STATUS = {
  idle: () => (state.messages.length ? 'Your turn.' : 'Ready. Talk or type to start.'),
  listening: () => (state.prefs.handsfree ? 'Listening (hands-free)…' : 'Listening… tap Done speaking when you finish.'),
  thinking: (label) => `Thinking${label ? ` with ${label}` : ''}…`,
  speaking: () => 'Speaking. Tap the orb or Interrupt to cut in.',
  error: () => 'Something went wrong.',
};

function setPhase(phase, text) {
  state.phase = phase;
  document.body.dataset.state = phase;
  orb.setState(phase);
  $('#status').textContent = text || STATUS[phase](state.thinkingLabel);
  const inSession = state.voiceSession || phase !== 'idle' || state.messages.length > 0;
  $('#session-actions').hidden = !inSession;
  $('#done-speaking').hidden = phase !== 'listening';
  $('#interrupt').hidden = phase !== 'speaking';
  $('#stop-thinking').hidden = phase !== 'thinking';
  $('#handsfree').checked = !!state.prefs.handsfree;
  const label = { idle: 'Talk to Jarvis', error: 'Talk to Jarvis', listening: 'Done speaking', thinking: 'Stop waiting for the reply', speaking: 'Interrupt Jarvis' }[phase];
  $('#orb-label').textContent = label;
  if (phase === 'idle' || phase === 'error') {
    if (!state.voiceSession) hideTranscript();
  }
  document.body.classList.toggle('conversation-started', state.messages.length > 0);
}

function showTranscript(text) {
  const el = $('#live-transcript');
  el.hidden = false;
  el.textContent = text ? `“${text}”` : '';
}
function hideTranscript() {
  const el = $('#live-transcript');
  el.hidden = true;
  el.textContent = '';
}

function showVoiceNotice(text, action) {
  const n = $('#voice-notice');
  n.replaceChildren(h('span', { text }));
  if (action) n.append(' ', h('button', { class: 'btn btn-small', type: 'button', id: 'allow-cloud-speech', text: action.label, onclick: action.run }));
  n.hidden = !text;
}

function allowCloudSpeech() {
  state.voiceSettings.allowCloud = true;
  Object.assign(voice.settings, state.voiceSettings);
  persist();
  showVoiceNotice('');
  toast('Online speech allowed. Your browser\u2019s speech service will hear what you say. Change this in Settings \u203a Voice.');
  startTalking();
}

async function startTalking() {
  showVoiceNotice('');
  state.voiceSession = true;
  state.silentRetries = 0;
  if (state.phase === 'thinking') return;
  await voice.startListening();
}

function interrupt() {
  if (state.phase === 'speaking') {
    voice.cancelSpeech();
    if (state.voiceSession && state.prefs.handsfree) voice.startListening();
    else setPhase('idle', 'Interrupted. Your turn.');
    return true;
  }
  return false;
}

function stopThinking() {
  state.controller?.abort();
}

let ended = null;
function endConversation() {
  voice.shutdown();
  state.controller?.abort();
  state.voiceSession = false;
  ended = state.messages;
  state.messages = [];
  persist();
  renderLog();
  renderSuggestions([]);
  showVoiceNotice('');
  setPhase('idle', 'Conversation ended. Start a new one any time.');
  toast('Conversation ended.', { label: 'Undo', run: () => { state.messages = ended || []; persist(); renderLog(); setPhase('idle'); } });
}

// --------------------------------------------------------- conversation

function openComposer(focus = true) {
  const c = $('#composer');
  c.hidden = false;
  if (focus) $('#composer-input').focus();
}

function routeFor(text, voiceTurn) {
  const models = allModels();
  if (!models.length) return null;
  if (state.prefs.selection !== 'auto') {
    const m = findModel(state.prefs.selection);
    if (m) return { ...m, auto: false, reason: 'you picked this model' };
    state.prefs.selection = 'auto';
    updateChip();
  }
  let pool = models.filter((m) => !state.prefs.autoExcluded[m.key]);
  if (!pool.length) pool = models;
  const turn = state.messages.filter((m) => m.role === 'user').length - 1;
  const r = chooseModel(pool, text, state.prefs, { voice: voiceTurn, turn });
  return { ...r.choice, auto: true, reason: r.reason };
}

function historyForModel() {
  const turns = [];
  for (const m of state.messages) {
    if (m.status !== 'ok' || !m.content || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else turns.push({ role: m.role, content: m.content });
  }
  return turns;
}

async function send(text, { voice: voiceTurn = false, retryOf = null } = {}) {
  if (state.phase === 'thinking') return;
  let userMsg;
  if (retryOf) {
    userMsg = state.messages.find((m) => m.id === retryOf);
    if (!userMsg) return;
    userMsg.status = 'ok';
    delete userMsg.error;
    voiceTurn = voiceTurn || !!userMsg.voice;
  } else {
    text = String(text || '').trim();
    if (!text) return;
    userMsg = { id: uid(), role: 'user', content: text, status: 'ok', voice: voiceTurn };
    state.messages.push(userMsg);
  }
  renderSuggestions([]);
  persist();
  renderLog();

  const target = routeFor(userMsg.content, voiceTurn);
  if (!target) {
    return fail(userMsg, { title: 'Claude isn\u2019t connected yet', message: 'Add your Anthropic API key so Jarvis can answer.', action: 'connections' });
  }
  const saved = state.settings[target.key] || {};
  const blocking = validateSettings(target.model, target.conn.modelMeta?.[target.model], saved).filter((i) => i.level === 'error');
  if (blocking.length) {
    const def = PARAMS[blocking[0].param];
    return fail(userMsg, {
      title: `${target.model} can’t be sent these settings yet`,
      message: blocking[0].message,
      param: blocking[0].param, key: target.key, paramLabel: def?.label || (blocking[0].param === '__extra' ? 'Advanced JSON' : blocking[0].param),
    });
  }

  state.lastTarget = target.key;
  state.thinkingLabel = target.model;
  setPhase('thinking');
  const asst = {
    id: uid(), role: 'assistant', content: '', status: 'streaming',
    meta: { key: target.key, connId: target.connId, connName: target.connName, model: target.model, auto: target.auto, reason: target.reason },
  };
  state.messages.push(asst);
  renderLog();
  const ctrl = new AbortController();
  state.controller = ctrl;
  try {
    const res = await runTurn({
      conn: target.conn, model: target.model, meta: target.conn.modelMeta?.[target.model], saved,
      system: systemPrompt({ memories: state.memories, voice: voiceTurn }),
      messages: historyForModel().filter((m, i, arr) => !(i === arr.length - 1 && m.role === 'assistant')),
      signal: ctrl.signal,
      onDelta: (t) => updateBubble(asst.id, parseReply(t).text, true),
    });
    const parsed = parseReply(res.text);
    if (res.model && res.model !== target.model) asst.meta.servedBy = res.model;
    if (res.fallback) asst.meta.fallback = res.fallback;
    asst.meta.stopReason = res.stopReason;
    if (res.stopReason === 'refusal') {
      const d = res.stopDetails || {};
      parsed.text = `${parsed.text ? `${parsed.text}\n\n` : ''}Claude declined to continue with this request${d.category ? ` (${d.category})` : ''}.${d.explanation ? ` ${d.explanation}` : ''} You can rephrase it and try again.`;
      parsed.replies = [];
    }
    asst.content = parsed.text || '(Claude sent back an empty reply.)';
    asst.replies = parsed.replies;
    asst.remember = parsed.remember
      .filter((r) => !state.memories.some((m) => m.text.toLowerCase() === r.toLowerCase()))
      .map((r) => ({ text: r, status: 'pending' }));
    asst.request = res.request;
    asst.status = 'ok';
    state.controller = null;
    persist();
    renderLog();
    renderSuggestions(parsed.replies);
    if (voiceTurn || state.prefs.speakTyped) {
      if (voice.supported.synthesis) {
        const spoken = await voice.speak(speakable(parsed.text));
        if (!spoken && state.phase === 'speaking') setPhase('idle');
      } else {
        setPhase('idle', 'Reply ready. This browser can’t read it aloud.');
      }
    } else {
      setPhase('idle');
    }
  } catch (e) {
    state.controller = null;
    state.messages = state.messages.filter((m) => m.id !== asst.id);
    if (e.name === 'AbortError') {
      fail(userMsg, { title: 'Stopped', message: 'You stopped this reply. Your message is kept.', stopped: true });
      return;
    }
    const extrasDefs = describeControls(target.model).extras;
    const param = e.param && (PARAMS[e.param] || extrasDefs.find((x) => x.id === e.param)) ? e.param : null;
    const label = param ? (PARAMS[param]?.label || extrasDefs.find((x) => x.id === param)?.label) : null;
    const authHint = e.status === 401 ? ' Check the API key under Settings \u203a Connections.' : e.status === 429 ? ' You have hit a rate limit; wait a moment and retry.' : e.status === 529 || e.status === 503 ? ' Claude is busy right now; retry shortly.' : '';
    fail(userMsg, {
      title: e.network ? `Couldn\u2019t reach Claude` : `Claude rejected the request${e.status ? ` (${e.status})` : ''}`,
      message: (e.message || String(e)) + authHint,
      param, paramLabel: label, key: target.key, model: target.model,
      request: e.request,
    });
  }
}

function fail(userMsg, err) {
  userMsg.status = err.stopped ? 'stopped' : 'failed';
  userMsg.error = err;
  persist();
  renderLog();
  setPhase(err.stopped ? 'idle' : 'error', err.stopped ? 'Stopped. Your message is kept.' : err.title);
  if (!err.stopped) setTimeout(() => { if (state.phase === 'error') setPhase('idle', 'Fix the issue below, then retry. Your message is kept.'); }, 2500);
}

function updateBubble(id, text, typing) {
  const el = document.querySelector(`[data-msg="${id}"] .bubble`);
  if (!el) return;
  el.innerHTML = richText(text);
  el.classList.toggle('typing', !!typing);
  el.closest('.msg').scrollIntoView?.({ block: 'nearest' });
}

function renderLog() {
  const log = $('#log');
  log.replaceChildren();
  for (const m of state.messages) log.append(renderMessage(m));
  document.body.classList.toggle('conversation-started', state.messages.length > 0);
  const last = log.lastElementChild;
  last?.scrollIntoView?.({ block: 'nearest' });
}

function renderMessage(m) {
  const li = h('li', { class: `msg ${m.role} ${m.status === 'failed' ? 'failed' : ''}`, dataset: { msg: m.id, role: m.role, status: m.status } });
  const bubble = h('div', { class: `bubble${m.status === 'streaming' ? ' typing' : ''}`, html: richText(m.content) });
  li.append(h('span', { class: 'visually-hidden', text: m.role === 'user' ? 'You said:' : 'Jarvis said:' }), bubble);
  if (m.role === 'assistant' && m.meta) {
    const served = m.meta.servedBy || m.meta.model;
    const meta = h('div', { class: 'meta', dataset: { testid: 'answered-by' } },
      h('span', {}, 'Answered by ', h('span', { class: 'who', text: served }), state.connections.length > 1 ? ` via ${m.meta.connName}` : ''),
      m.meta.servedBy ? h('span', { class: 'sim-badge', text: m.meta.fallback ? `fallback from ${m.meta.model}` : `requested ${m.meta.model}` }) : null,
      h('span', { class: 'why', text: m.meta.auto ? `Auto chose ${m.meta.model} because ${m.meta.reason}.` : 'You picked this model.' }),
      m.meta.stopReason === 'max_tokens' ? h('span', { class: 'sim-badge', text: 'cut off at the output limit' }) : null,
    );
    li.append(meta);
    if (m.request) {
      li.append(h('details', {}, h('summary', { text: 'Request that was sent' }), h('pre', { text: JSON.stringify(m.request, null, 2) })));
    }
    for (const r of m.remember || []) li.append(renderMemoryCard(m, r));
  }
  if (m.role === 'user' && m.error) li.append(renderErrorCard(m));
  return li;
}

function renderErrorCard(m) {
  const e = m.error;
  const row = h('div', { class: 'row' });
  if (e.param && e.key) {
    row.append(h('button', { class: 'btn btn-small btn-primary', type: 'button', text: `Fix ${e.paramLabel || e.param}`, onclick: () => openSettingsAt(e.key, e.param) }));
  } else if (e.action === 'connections') {
    row.append(h('button', { class: 'btn btn-small btn-primary', type: 'button', text: 'Connect Claude', onclick: () => openSettings('connections') }));
  } else if (e.key && !e.stopped) {
    row.append(h('button', { class: 'btn btn-small', type: 'button', text: 'Model settings', onclick: () => openSettingsAt(e.key) }));
  }
  row.append(
    h('button', { class: 'btn btn-small', type: 'button', text: 'Retry', onclick: () => send(null, { retryOf: m.id }) }),
    h('button', { class: 'btn btn-small', type: 'button', text: 'Edit message', onclick: () => editFailed(m.id) }),
  );
  if (!e.stopped) row.append(h('button', { class: 'btn btn-small btn-quiet', type: 'button', text: 'Use another model', onclick: () => openPicker() }));
  const card = h('div', { class: `card ${e.stopped ? '' : 'error-card'}`, role: e.stopped ? null : 'alert', dataset: { testid: 'error-card', param: e.param || '' } },
    h('h3', { text: e.title }),
    h('p', { text: e.message }),
    e.param ? h('p', { text: `The setting at fault looks like ${e.paramLabel || e.param}. Your message is kept; fix it and retry.` }) : null,
    row,
  );
  return card;
}

function editFailed(id) {
  const m = state.messages.find((x) => x.id === id);
  if (!m) return;
  state.messages = state.messages.filter((x) => x.id !== id);
  persist();
  renderLog();
  openComposer();
  const input = $('#composer-input');
  input.value = m.content;
  autoGrow(input);
  setPhase('idle', 'Edit your message, then send it again.');
}

function renderMemoryCard(msg, r) {
  if (r.status === 'saved') return h('p', { class: 'meta', text: `Remembered: “${r.text}”. You can edit it in Settings › Memory.` });
  if (r.status === 'declined') return null;
  return h('div', { class: 'card memory-card', dataset: { testid: 'memory-card' } },
    h('h3', { text: 'Remember this across chats?' }),
    h('p', { text: `“${r.text}”` }),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-small btn-primary', type: 'button', text: 'Remember', onclick: () => { state.memories.push({ id: uid(), text: r.text, createdAt: Date.now() }); r.status = 'saved'; persist(); renderLog(); toast('Saved to memory.'); } }),
      h('button', { class: 'btn btn-small', type: 'button', text: 'Not now', onclick: () => { r.status = 'declined'; persist(); renderLog(); } }),
    ),
  );
}

function renderSuggestions(replies) {
  const box = $('#suggestions');
  box.replaceChildren();
  for (const r of replies || []) {
    box.append(h('button', { class: 'suggestion', type: 'button', text: r, onclick: () => send(r, { voice: false }) }));
  }
}

// -------------------------------------------------------- model picker

function updateChip() {
  $('#model-chip-name').textContent = selectionLabel();
}

function openPicker() {
  const box = $('#model-options');
  box.replaceChildren();
  const name = 'model-choice';
  const opt = (value, title, sub) => {
    const id = `opt-${value.replace(/[^a-z0-9]/gi, '-')}`;
    return h('label', { class: 'model-option', for: id },
      h('input', { type: 'radio', name, id, value, checked: state.prefs.selection === value || undefined, onchange: () => choose(value) }),
      h('span', {}, title), h('small', { text: sub }));
  };
  box.append(opt('auto', 'Auto', 'Picks one of your models for each message and tells you why.'));
  const groups = new Map();
  for (const m of allModels()) {
    if (!groups.has(m.connId)) groups.set(m.connId, []);
    groups.get(m.connId).push(m);
  }
  for (const list of groups.values()) {
    if (groups.size > 1) box.append(h('div', { class: 'group-label', text: list[0].connName }));
    for (const m of list) box.append(opt(m.key, m.model, state.settings[m.key]?.params && Object.keys(state.settings[m.key].params).length ? 'Custom settings' : 'Default settings'));
  }
  if (!allModels().length) box.append(h('p', { class: 'empty', text: 'No Claude models yet. Connect Claude first.' }));
  $('#model-picker').showModal();
}

function choose(value) {
  state.prefs.selection = value;
  persist();
  updateChip();
  $('#model-picker').close();
  toast(value === 'auto' ? 'Auto will choose for each message. Conversation kept.' : `Next reply comes from ${findModel(value)?.model}. Conversation kept.`);
}

// --------------------------------------------------------- settings sheet

const TABS = ['connections', 'model', 'voice', 'memory', 'general'];

function openSettings(tab = 'connections') {
  const d = $('#settings');
  if (!d.open) d.showModal();
  selectTab(tab);
}

function selectTab(tab) {
  for (const t of TABS) {
    const btn = $(`#tab-${t}`);
    const panel = $(`#panel-${t}`);
    const on = t === tab;
    btn.setAttribute('aria-selected', String(on));
    btn.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  }
  ({ connections: renderConnections, model: renderModelPanel, voice: renderVoicePanel, memory: renderMemoryPanel, general: renderGeneralPanel })[tab]();
}

function openSettingsAt(key, param) {
  state.editTarget = key;
  openSettings('model');
  if (param) {
    const row = document.querySelector(`#panel-model [data-param="${param}"]`) || document.querySelector('#panel-model [data-param="__extra"]');
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.remove('flash');
      void row.offsetWidth;
      row.classList.add('flash');
      row.querySelector('input, select, textarea')?.focus();
    }
  }
}

// ---- Connections (Claude only)

function newConnection({ name, apiKey, baseUrl }) {
  return {
    id: uid(), providerId: 'anthropic',
    name: name || (state.connections.length ? `Claude ${state.connections.length + 1}` : 'Claude'),
    baseUrl: baseUrl || DEFAULT_BASE_URL, apiKey,
    models: [...DEFAULT_MODELS], available: [], modelMeta: {},
  };
}

// Ask Anthropic which models this key can use. Returns { ok, error, status }.
async function refreshModels(conn) {
  try {
    const found = await discoverModels(conn);
    conn.available = found.map((f) => f.id);
    conn.modelMeta = conn.modelMeta || {};
    for (const f of found) conn.modelMeta[f.id] = slimMeta(f.meta);
    persist();
    return { ok: true, count: found.length };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status };
  }
}

function slimMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const k of ['display_name', 'max_tokens', 'max_input_tokens']) if (meta[k] !== undefined) out[k] = meta[k];
  return out;
}

async function connectWithKey({ apiKey, name, baseUrl }, statusEl) {
  const conn = newConnection({ apiKey, name, baseUrl });
  statusEl.className = 'status-line';
  statusEl.textContent = 'Checking your key with Anthropic\u2026';
  const r = await refreshModels(conn);
  if (!r.ok && (r.status === 401 || r.status === 403)) {
    statusEl.className = 'status-line err';
    statusEl.textContent = `Anthropic rejected that key: ${r.error}`;
    return null;
  }
  state.connections.push(conn);
  persist();
  updateChip();
  renderOnboarding();
  toast(r.ok ? 'Claude is connected.' : `Saved. Couldn\u2019t check the key yet (${r.error}).`);
  return conn;
}

function renderOnboarding() {
  const box = $('#onboarding');
  document.body.classList.toggle('needs-key', !state.connections.length);
  if (state.connections.length) { box.hidden = true; box.replaceChildren(); return; }
  const key = h('input', { class: 'input', id: 'onboard-key', type: 'password', autocomplete: 'off', placeholder: 'sk-ant-\u2026', 'aria-label': 'Anthropic API key' });
  const status = h('p', { class: 'status-line', role: 'status' });
  box.hidden = false;
  box.replaceChildren(h('form', { class: 'card onboard', onsubmit: async (e) => {
    e.preventDefault();
    const apiKey = key.value.trim();
    if (!apiKey) { key.focus(); status.className = 'status-line err'; status.textContent = 'Paste your API key first.'; return; }
    await connectWithKey({ apiKey }, status);
  } },
  h('h3', { text: 'Connect Claude to begin' }),
  h('p', { text: 'Jarvis talks only to Claude. Paste an Anthropic API key; it is stored on this computer and sent only to Anthropic.' }),
  h('div', { class: 'inline' }, key, h('button', { class: 'btn btn-primary btn-small', type: 'submit', text: 'Connect' })),
  h('p', { class: 'conn-sub', html: 'No key yet? Create one at <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">platform.claude.com</a>.' }),
  status));
}

function renderConnections() {
  const panel = $('#panel-connections');
  panel.replaceChildren(
    h('p', { class: 'lead', text: 'Jarvis only talks to Claude. Add more than one key if you use separate accounts or workspaces; each key is sent only to Anthropic, through the Jarvis app running on this computer.' }),
  );
  if (!state.connections.length) panel.append(h('p', { class: 'empty', text: 'Claude isn\u2019t connected yet.' }));
  for (const conn of state.connections) panel.append(renderConnection(conn));
  panel.append(renderAddConnection());
}

function renderConnection(conn) {
  const statusLine = h('p', { class: 'status-line', role: 'status' });
  const card = h('div', { class: 'conn', dataset: { conn: conn.id } });
  const modelInput = h('input', { class: 'input', placeholder: 'Model ID, e.g. claude-sonnet-5-5', list: `dl-${conn.id}`, 'aria-label': `Model ID to add to ${conn.name}` });
  const datalist = h('datalist', { id: `dl-${conn.id}` }, (conn.available || []).map((m) => h('option', { value: m })));
  const addModel = (id) => {
    id = String(id || '').trim();
    if (!id) return;
    if (!conn.models.includes(id)) conn.models.push(id);
    persist();
    renderConnections();
    updateChip();
  };
  const models = h('div', { class: 'models' }, conn.models.map((m) => {
    const key = settingsKey(conn.id, m);
    return h('span', { class: 'model-tag', dataset: { model: m } }, m,
      h('label', { title: 'Let Auto pick this model' },
        h('input', { type: 'checkbox', checked: !state.prefs.autoExcluded[key] || undefined, onchange: (e) => { if (e.target.checked) delete state.prefs.autoExcluded[key]; else state.prefs.autoExcluded[key] = true; persist(); } }),
        'Auto'),
      h('button', { type: 'button', 'aria-label': `Remove ${m}`, text: '\u2715', onclick: () => { conn.models = conn.models.filter((x) => x !== m); if (state.prefs.selection === key) state.prefs.selection = 'auto'; persist(); renderConnections(); updateChip(); } }));
  }));
  if (!conn.models.length) models.append(h('span', { class: 'empty', text: 'No models turned on. Add one below.' }));
  const unknown = conn.available?.length ? conn.models.filter((m) => !conn.available.includes(m)) : [];
  const quick = (conn.available || []).filter((m) => !conn.models.includes(m));
  const quickRow = quick.length
    ? h('div', { class: 'models' }, h('span', { class: 'conn-sub', text: 'Also available to this key:' }),
      quick.slice(0, 12).map((m) => h('button', { type: 'button', class: 'suggestion btn-small', text: `+ ${m}`, onclick: () => addModel(m) })))
    : null;
  const check = async () => {
    statusLine.className = 'status-line';
    statusLine.textContent = 'Asking Anthropic which models this key can use\u2026';
    const r = await refreshModels(conn);
    renderConnections();
    const fresh = document.querySelector(`[data-conn="${conn.id}"] .status-line`);
    if (!fresh) return;
    fresh.className = `status-line ${r.ok ? 'ok' : 'err'}`;
    fresh.textContent = r.ok ? `Key works. ${r.count} models available.` : `Check failed: ${r.error}`;
  };
  card.append(
    h('div', { class: 'conn-head' },
      h('div', {}, h('strong', { text: conn.name })),
      h('button', { class: 'btn btn-small btn-quiet btn-danger', type: 'button', text: 'Remove', onclick: () => removeConnection(conn) })),
    h('div', { class: 'conn-sub', text: `${conn.apiKey ? 'Key saved' : 'No key'}${conn.baseUrl && conn.baseUrl !== DEFAULT_BASE_URL ? ` \u00b7 via ${conn.baseUrl}` : ''}` }),
    models,
    unknown.length ? h('p', { class: 'issue-line warning', text: `This key doesn\u2019t list ${unknown.join(', ')}; requests to ${unknown.length === 1 ? 'it' : 'them'} may fail.` }) : null,
    h('div', { class: 'inline' }, modelInput, datalist,
      h('button', { class: 'btn btn-small', type: 'button', text: 'Add model', onclick: () => addModel(modelInput.value) }),
      h('button', { class: 'btn btn-small', type: 'button', text: 'Check key & models', onclick: check })),
    quickRow,
    statusLine,
    h('details', {}, h('summary', { class: 'conn-sub', text: 'Edit connection' }), editConnectionForm(conn)),
  );
  modelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addModel(modelInput.value); } });
  return card;
}

function removeConnection(conn) {
  const before = structuredClone(state.connections);
  state.connections = state.connections.filter((c) => c.id !== conn.id);
  if (state.prefs.selection.startsWith(`${conn.id}::`)) state.prefs.selection = 'auto';
  persist();
  renderConnections();
  renderOnboarding();
  updateChip();
  toast(`Removed ${conn.name}.`, { label: 'Undo', run: () => { state.connections = before; persist(); renderConnections(); renderOnboarding(); updateChip(); } });
}

function editConnectionForm(conn) {
  const name = h('input', { class: 'input', value: conn.name, 'aria-label': 'Connection name' });
  const base = h('input', { class: 'input', value: conn.baseUrl || DEFAULT_BASE_URL, 'aria-label': 'API base URL', inputmode: 'url' });
  const key = h('input', { class: 'input', type: 'password', placeholder: 'Leave blank to keep the saved key', autocomplete: 'off', 'aria-label': 'API key' });
  return h('form', { class: 'grid-2', onsubmit: (e) => {
    e.preventDefault();
    conn.name = name.value.trim() || conn.name;
    conn.baseUrl = base.value.trim() || DEFAULT_BASE_URL;
    if (key.value.trim()) conn.apiKey = key.value.trim();
    persist();
    renderConnections();
    toast('Connection updated.');
  } },
  h('label', { class: 'field' }, h('span', { text: 'Name' }), name),
  h('label', { class: 'field' }, h('span', { text: 'New API key' }), key),
  h('label', { class: 'field' }, h('span', { text: 'API base URL (only change this for an approved Claude gateway)' }), base),
  h('div', { class: 'field' }, h('span', { html: '&nbsp;' }), h('div', { class: 'inline' }, h('button', { class: 'btn btn-small', type: 'submit', text: 'Save changes' }))));
}

function renderAddConnection() {
  const name = h('input', { class: 'input', id: 'new-name', placeholder: 'e.g. Work' });
  const key = h('input', { class: 'input', id: 'new-key', type: 'password', autocomplete: 'off', placeholder: 'sk-ant-\u2026' });
  const base = h('input', { class: 'input', id: 'new-base', inputmode: 'url', value: DEFAULT_BASE_URL });
  const status = h('p', { class: 'status-line', role: 'status' });
  const form = h('form', { class: 'conn', id: 'add-connection', onsubmit: async (e) => {
    e.preventDefault();
    if (!key.value.trim()) { status.className = 'status-line err'; status.textContent = 'Claude needs an API key.'; key.focus(); return; }
    const conn = await connectWithKey({ apiKey: key.value.trim(), name: name.value.trim(), baseUrl: base.value.trim() }, status);
    if (conn) renderConnections();
  } },
  h('div', { class: 'grid-2' },
    h('label', { class: 'field' }, h('span', { text: 'Anthropic API key' }), key),
    h('label', { class: 'field' }, h('span', { text: 'Name (optional)' }), name)),
  h('details', {}, h('summary', { class: 'conn-sub', text: 'Advanced' }), h('label', { class: 'field' }, h('span', { text: 'API base URL (only for an approved Claude gateway)' }), base)),
  h('button', { class: 'btn btn-primary btn-small', type: 'submit', text: state.connections.length ? 'Add key' : 'Connect Claude' }),
  status);
  return h('div', {}, h('h3', { text: state.connections.length ? 'Add another key' : 'Connect Claude' }), form);
}

// ---- Model settings

function defaultEditTarget() {
  if (state.prefs.selection !== 'auto' && findModel(state.prefs.selection)) return state.prefs.selection;
  if (state.lastTarget && findModel(state.lastTarget)) return state.lastTarget;
  return allModels()[0]?.key;
}

function savedFor(key) {
  if (!state.settings[key]) state.settings[key] = { params: {} };
  if (!state.settings[key].params) state.settings[key].params = {};
  return state.settings[key];
}

function cleanupSaved(key) {
  const s = state.settings[key];
  if (s && !Object.keys(s.params || {}).length && s.extra === undefined) delete state.settings[key];
}

function renderModelPanel() {
  const panel = $('#panel-model');
  panel.replaceChildren();
  const models = allModels();
  if (!models.length) {
    panel.append(h('p', { class: 'empty', text: 'Connect a model first, then its settings appear here.' }));
    return;
  }
  if (!state.editTarget || !findModel(state.editTarget)) state.editTarget = defaultEditTarget();
  const t = findModel(state.editTarget);
  const meta = t.conn.modelMeta?.[t.model];

  const picker = h('select', { class: 'input', id: 'settings-target', 'aria-label': 'Model to configure', onchange: (e) => { state.editTarget = e.target.value; renderModelPanel(); } },
    models.map((m) => h('option', { value: m.key, selected: m.key === t.key || undefined, text: `${m.model} — ${m.connName}` })));
  const { common, extras } = describeControls(t.model, meta);
  const saved = savedFor(t.key);
  const summary = h('div', { id: 'settings-issues', 'aria-live': 'polite' });
  const preview = h('pre', { id: 'settings-preview' });
  const previewMeta = h('div', { class: 'preview-meta', id: 'preview-meta' });

  const refresh = () => {
    cleanupSaved(t.key);
    const cur = state.settings[t.key] || { params: {} };
    const issues = validateSettings(t.model, meta, cur);
    for (const row of panel.querySelectorAll('[data-param]')) {
      const id = row.dataset.param;
      const list = issues.filter((i) => i.param === id);
      const out = row.querySelector('.issue');
      out.replaceChildren(...list.map((i) => h('div', { class: `issue-line ${i.level}`, text: i.message })));
      const v = cur.params?.[id];
      const st = row.querySelector('.state');
      if (st) {
        const def = [...common, ...extras].find((d) => d.id === id);
        const defaultText = def?.required ? `Default (sends ${defaultMaxTokens(cur.params?.stream === true).toLocaleString('en-US')})`
          : def?.jarvisDefault !== undefined ? `Jarvis default: ${def.jarvisDefault ? 'on' : 'off'}` : 'Claude default';
        st.textContent = v === undefined ? defaultText : `Custom: ${Array.isArray(v) ? v.join(', ') : v}`;
        st.classList.toggle('custom', v !== undefined);
        const reset = row.querySelector('.reset');
        if (reset) reset.disabled = v === undefined;
      }
    }
    const errors = issues.filter((i) => i.level === 'error').length;
    const warnings = issues.length - errors;
    summary.replaceChildren(errors || warnings
      ? h('p', { class: `issue-line ${errors ? 'error' : 'warning'}`, text: errors ? `${errors} ${errors === 1 ? 'problem' : 'problems'} to fix before Jarvis can send to this model.` : `${warnings} ${warnings === 1 ? 'note' : 'notes'} below; sending still works.` })
      : h('p', { class: 'issue-line', style: 'color:var(--ok)', text: 'These settings are valid for this model.' }));
    renderPreview(t, meta, cur, preview, previewMeta);
    persist();
  };

  const set = (id, value) => {
    const s = savedFor(t.key);
    if (value === undefined) delete s.params[id];
    else s.params[id] = value;
    refresh();
  };

  const paramRows = common.map((def) => paramRow(def, saved.params[def.id], set));
  const extraRows = extras.map((def) => paramRow(def, saved.params[def.id], set));

  // Presets
  const presetSel = h('select', { class: 'input', id: 'preset-select', 'aria-label': 'Saved presets' },
    h('option', { value: '', text: state.presets.length ? 'Choose a preset…' : 'No presets yet' }),
    state.presets.map((p) => h('option', { value: p.id, text: p.name })));
  const presetName = h('input', { class: 'input', id: 'preset-name', placeholder: 'Name, e.g. Brainstorm', 'aria-label': 'Preset name' });
  const presetRow = h('div', {},
    h('div', { class: 'preset-row' }, presetSel,
      h('button', { class: 'btn btn-small', type: 'button', text: 'Apply', onclick: () => applyPreset(presetSel.value, t, common, extras) }),
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', text: 'Delete', onclick: () => { if (!presetSel.value) return; state.presets = state.presets.filter((p) => p.id !== presetSel.value); persist(); renderModelPanel(); } })),
    h('div', { class: 'preset-row' }, presetName,
      h('button', { class: 'btn btn-small', type: 'button', id: 'save-preset', text: 'Save current as preset', onclick: () => {
        const nm = presetName.value.trim();
        if (!nm) { presetName.focus(); toast('Give the preset a name first.'); return; }
        const cur = state.settings[t.key] || { params: {} };
        state.presets.push({ id: uid(), name: nm, params: structuredClone(cur.params || {}), extra: cur.extra ? structuredClone(cur.extra) : undefined });
        persist();
        renderModelPanel();
        toast(`Saved preset “${nm}”.`);
      } }),
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', id: 'restore-defaults', text: 'Restore provider defaults', onclick: () => {
        const before = structuredClone(state.settings[t.key]);
        delete state.settings[t.key];
        persist();
        renderModelPanel();
        toast('Every control is back to its default.', { label: 'Undo', run: () => { if (before) state.settings[t.key] = before; persist(); renderModelPanel(); } });
      } })));

  // Advanced JSON
  const jsonBox = h('textarea', { class: 'input', id: 'advanced-json', spellcheck: 'false', placeholder: '{ "logprobs": true }', 'aria-describedby': 'json-help' });
  jsonBox.value = saved.extra ? JSON.stringify(saved.extra, null, 2) : '';
  const jsonStatus = h('div', { class: 'issue' });
  const jsonRow = h('div', { class: 'param', dataset: { param: '__extra' } },
    h('div', { class: 'param-head' }, h('label', { for: 'advanced-json', text: 'Advanced JSON' })),
    h('p', { class: 'desc', id: 'json-help', text: 'Extra Messages API fields merged into the request body last, for options the controls above don\u2019t cover, such as {"output_config": {"format": {"type": "json_schema", "schema": {}}}}. Jarvis can\u2019t check what these do.' }),
    jsonBox, jsonStatus);
  jsonBox.addEventListener('input', () => {
    const s = savedFor(t.key);
    const raw = jsonBox.value.trim();
    if (!raw) { delete s.extra; refresh(); return; }
    try {
      s.extra = JSON.parse(raw);
      refresh();
    } catch (e) {
      refresh();
      jsonStatus.prepend(h('div', { class: 'issue-line error', text: `Not valid JSON yet (${e.message}). The last valid version is kept.` }));
    }
  });

  const selectionNote = state.prefs.selection === 'auto'
    ? 'Your next message goes to Auto, which picks a Claude model when you send. If it picks this one, it uses exactly these settings.'
    : state.prefs.selection === t.key ? 'Your next message goes to this model.' : `Your next message goes to ${selectionLabel()}. These settings apply whenever this model answers.`;

  panel.append(
    h('label', { class: 'field' }, h('span', { text: 'Settings for' }), picker),
    h('p', { class: 'lead', text: 'Every control starts at Claude\u2019s default and is left out of the request until you change it. Controls this model rejects are shown but switched off. Settings are saved for this model on this key only.' }),
    summary,
    h('h3', { text: 'Presets' }), presetRow,
    h('h3', { text: 'Generation' }), ...paramRows,
    extraRows.length ? h('h3', { text: 'Claude options' }) : null, ...extraRows,
    h('h3', { text: 'Anything else' }), jsonRow,
    h('h3', { text: 'Preview of the next request' }),
    h('p', { class: 'preview-meta', text: selectionNote }),
    previewMeta, preview,
  );
  refresh();
}

function paramRow(def, value, set) {
  const id = `ctl-${def.id}`;
  const badge = { yes: ['Supported', 'badge-yes'], uncertain: ['May not work', 'badge-uncertain'], no: ['Not supported', 'badge-no'] }[def.support] || ['', ''];
  const disabled = def.support === 'no';
  let input;
  const onChange = (raw) => {
    const v = coerce(def, raw);
    if (typeof v === 'number' && Number.isNaN(v)) return; // leave the last good value
    set(def.id, v);
  };
  if (def.type === 'number' || def.type === 'integer') {
    input = h('input', { class: 'input', id, type: 'number', inputmode: def.type === 'integer' ? 'numeric' : 'decimal', step: def.step ?? (def.type === 'integer' ? 1 : 0.01), min: def.min, max: def.max, placeholder: 'Claude default', value: value ?? '', disabled });
    input.addEventListener('input', () => onChange(input.value));
  } else if (def.type === 'enum') {
    input = h('select', { class: 'input', id, disabled },
      h('option', { value: '', text: 'Claude default' }),
      (def.options || []).map((o) => h('option', { value: o, text: o, selected: value === o || undefined })));
    input.addEventListener('change', () => onChange(input.value));
  } else if (def.type === 'boolean') {
    input = h('select', { class: 'input', id, disabled },
      h('option', { value: '', text: def.jarvisDefault !== undefined ? `Jarvis default (${def.jarvisDefault ? 'on' : 'off'})` : 'Claude default' }),
      h('option', { value: 'true', text: 'On', selected: value === true || undefined }),
      h('option', { value: 'false', text: 'Off', selected: value === false || undefined }));
    input.addEventListener('change', () => onChange(input.value));
  } else if (def.type === 'list') {
    input = h('textarea', { class: 'input', id, rows: 2, placeholder: 'Claude default (one per line)', disabled });
    input.value = Array.isArray(value) ? value.join('\n') : '';
    input.addEventListener('input', () => onChange(input.value));
  } else {
    input = h('input', { class: 'input', id, type: 'text', placeholder: 'Claude default', value: value ?? '', disabled });
    input.addEventListener('input', () => onChange(input.value));
  }
  const range = (def.min !== undefined || def.max !== undefined) && (def.type === 'number' || def.type === 'integer')
    ? h('span', { class: 'conn-sub', text: `${def.min ?? '–'} to ${def.max ?? '–'}` }) : null;
  const reset = h('button', { class: 'btn btn-small btn-quiet reset', type: 'button', text: 'Use default', disabled: value === undefined || undefined, onclick: () => {
    if (input.tagName === 'SELECT') input.value = '';
    else input.value = '';
    set(def.id, undefined);
  } });
  return h('div', { class: 'param', dataset: { param: def.id, support: def.support } },
    h('div', { class: 'param-head' }, h('label', { for: id, text: def.label }), h('span', { class: `badge ${badge[1]}`, text: badge[0] }), h('span', { class: 'state' })),
    h('p', { class: 'desc', text: def.desc }),
    def.note ? h('p', { class: 'note', text: def.note }) : null,
    h('div', { class: 'control' }, input, range, reset),
    h('div', { class: 'issue' }));
}

function applyPreset(id, t, common, extras) {
  const p = state.presets.find((x) => x.id === id);
  if (!p) { toast('Choose a preset first.'); return; }
  const defs = Object.fromEntries([...common, ...extras].map((d) => [d.id, d]));
  const params = {};
  const skipped = [];
  for (const [k, v] of Object.entries(p.params || {})) {
    if (!defs[k] || defs[k].support === 'no') skipped.push(defs[k]?.label || PARAMS[k]?.label || k);
    else params[k] = v;
  }
  state.settings[t.key] = { params, ...(p.extra ? { extra: structuredClone(p.extra) } : {}) };
  persist();
  renderModelPanel();
  toast(skipped.length ? `Applied “${p.name}”. Skipped ${skipped.join(', ')}: not supported by ${t.model}.` : `Applied “${p.name}”.`);
}

function renderPreview(t, meta, saved, pre, metaBox) {
  const history = historyForModel();
  const messages = [...history, { role: 'user', content: '(your next message)' }];
  const req = buildRequest({ conn: t.conn, model: t.model, meta, saved, system: systemPrompt({ memories: state.memories }), messages });
  const body = structuredClone(req.body);
  const summarize = (n) => `[${n} messages: the conversation so far plus your next message]`;
  if (Array.isArray(body.messages)) body.messages = summarize(body.messages.length);
  if (Array.isArray(body.contents)) body.contents = summarize(body.contents.length);
  if (typeof body.system === 'string') body.system = `[Jarvis system prompt, ${body.system.length} characters]`;
  if (body.systemInstruction) body.systemInstruction = '[Jarvis system prompt]';
  pre.textContent = `${req.method} ${req.url}\n${JSON.stringify(redactHeaders(req.headers), null, 2)}\n\n${JSON.stringify(body, null, 2)}`;
  const { params } = effectiveParams(t.model, meta, saved);
  const leftOut = describeControls(t.model, meta).common.filter((d) => d.support !== 'no' && params[d.id] === undefined).map((d) => d.label);
  metaBox.replaceChildren(
    leftOut.length ? h('div', { text: `Left out, so Claude\u2019s defaults apply: ${leftOut.join(', ')}.` }) : null,
    req.skipped.length ? h('div', { class: 'issue-line warning', text: `Not sent because this model doesn’t support them: ${req.skipped.map((s) => s.label).join(', ')}.` }) : null,
  );
}

// ---- Voice

const LANGS = [['', 'Browser default'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['en-IN', 'English (India)'], ['es-ES', 'Spanish (Spain)'], ['es-MX', 'Spanish (Mexico)'], ['fr-FR', 'French'], ['de-DE', 'German'], ['it-IT', 'Italian'], ['pt-BR', 'Portuguese (Brazil)'], ['nl-NL', 'Dutch'], ['hi-IN', 'Hindi'], ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['zh-CN', 'Chinese (Mandarin)']];

function renderVoicePanel() {
  const panel = $('#panel-voice');
  const vs = state.voiceSettings;
  const langPrefix = (vs.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
  const voices = voice.usableVoices();
  const matching = voices.filter((v) => v.lang?.toLowerCase().startsWith(langPrefix));
  const shown = matching.length ? matching : voices;
  const voiceSel = h('select', { class: 'input', id: 'voice-select' },
    h('option', { value: '', text: vs.allowCloud ? 'Browser default voice' : 'First on-device voice for this language' }),
    shown.map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === vs.voiceURI || undefined, text: `${v.name} (${v.lang})${v.localService ? '' : ' \u00b7 online'}` })));
  const langSel = h('select', { class: 'input', id: 'voice-lang' }, LANGS.map(([v, n]) => h('option', { value: v, selected: v === vs.lang || undefined, text: n })));
  const rate = h('input', { type: 'range', id: 'voice-rate', min: 0.5, max: 2, step: 0.05, value: vs.rate || 1, style: 'width:100%' });
  const rateOut = h('output', { for: 'voice-rate', text: `${Number(vs.rate || 1).toFixed(2)}×` });
  const commit = () => { Object.assign(voice.settings, vs); persist(); };
  voiceSel.addEventListener('change', () => { vs.voiceURI = voiceSel.value; commit(); });
  langSel.addEventListener('change', () => { vs.lang = langSel.value; vs.voiceURI = ''; commit(); renderVoicePanel(); });
  rate.addEventListener('input', () => { vs.rate = Number(rate.value); rateOut.textContent = `${vs.rate.toFixed(2)}×`; commit(); });
  const support = [];
  if (!voice.supported.recognition) support.push('This browser can’t transcribe speech, so Talk to Jarvis won’t work here. Chrome, Edge and Safari can.');
  if (!voice.supported.synthesis) support.push('This browser can’t read replies aloud.');
  panel.replaceChildren(
    h('p', { class: 'lead', text: 'The microphone only turns on when you tap Talk, and it is off while Jarvis speaks so it never hears itself. By default all speech stays on this computer, so the only service Jarvis talks to is Claude.' }),
    ...support.map((s) => h('p', { class: 'notice', text: s })),
    h('label', { class: 'field' }, h('span', { text: 'Language (for listening and speaking)' }), langSel),
    h('label', { class: 'field' }, h('span', { text: 'Voice' }), voiceSel),
    h('div', { class: 'field' }, h('label', { for: 'voice-rate', text: 'Speed' }), h('div', { class: 'inline' }, rate, rateOut)),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', id: 'pref-cloud-speech', checked: vs.allowCloud || undefined, onchange: (e) => { vs.allowCloud = e.target.checked; vs.voiceURI = ''; commit(); renderVoicePanel(); } }),
      h('span', { text: 'Allow the browser\u2019s online speech service (sends your voice or reply text to the browser maker, not only to Claude)' })),
    !vs.allowCloud && !voices.length ? h('p', { class: 'notice', text: 'No on-device voices found, so replies won\u2019t be read aloud. Install a voice in your system\u2019s speech settings, or allow the online service above.' }) : null,
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', id: 'pref-handsfree', checked: state.prefs.handsfree || undefined, onchange: (e) => { state.prefs.handsfree = e.target.checked; persist(); setPhase(state.phase); } }), h('span', { text: 'Hands-free: listen again after Jarvis finishes speaking' })),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', id: 'pref-speak-typed', checked: state.prefs.speakTyped || undefined, onchange: (e) => { state.prefs.speakTyped = e.target.checked; persist(); } }), h('span', { text: 'Also read replies to typed messages aloud' })),
    h('p', {}, h('button', { class: 'btn btn-small', type: 'button', text: 'Test voice', onclick: () => voice.speak('Hi, I’m Jarvis. This is how I sound.') })),
  );
}

// ---- Memory

function renderMemoryPanel() {
  const panel = $('#panel-memory');
  panel.replaceChildren(h('p', { class: 'lead', text: 'Jarvis always asks before remembering anything. What you approve is kept in this browser and shared with whichever model answers, in every chat.' }));
  if (!state.memories.length) panel.append(h('p', { class: 'empty', text: 'Nothing remembered yet.' }));
  for (const m of state.memories) {
    const input = h('input', { class: 'input', value: m.text, 'aria-label': 'Remembered preference' });
    input.addEventListener('change', () => { const v = input.value.trim(); if (v) { m.text = v; persist(); toast('Memory updated.'); } });
    panel.append(h('div', { class: 'mem', dataset: { memory: m.id } }, input,
      h('button', { class: 'btn btn-small btn-quiet btn-danger', type: 'button', text: 'Delete', 'aria-label': `Delete memory: ${m.text}`, onclick: () => { state.memories = state.memories.filter((x) => x.id !== m.id); persist(); renderMemoryPanel(); } })));
  }
  const add = h('input', { class: 'input', placeholder: 'Add something yourself, e.g. "I prefer metric units"', 'aria-label': 'New memory' });
  panel.append(
    h('h3', { text: 'Add a memory' }),
    h('div', { class: 'mem' }, add, h('button', { class: 'btn btn-small', type: 'button', text: 'Add', onclick: () => { const v = add.value.trim(); if (!v) return; state.memories.push({ id: uid(), text: v, createdAt: Date.now() }); persist(); renderMemoryPanel(); } })),
    state.memories.length ? h('p', {}, h('button', { class: 'btn btn-small btn-quiet btn-danger', type: 'button', text: 'Forget everything', onclick: () => { const before = state.memories; state.memories = []; persist(); renderMemoryPanel(); toast('All memories deleted.', { label: 'Undo', run: () => { state.memories = before; persist(); renderMemoryPanel(); } }); } })) : null,
  );
}

// ---- General

function renderGeneralPanel() {
  const panel = $('#panel-general');
  const radio = (value, label, sub) => h('label', { class: 'model-option' },
    h('input', { type: 'radio', name: 'priority', value, checked: state.prefs.priority === value || undefined, onchange: () => { state.prefs.priority = value; persist(); } }),
    h('span', { text: label }), h('small', { text: sub }));
  const motion = h('select', { class: 'input', id: 'pref-motion' },
    [['auto', 'Match my system setting'], ['on', 'On'], ['off', 'Off']].map(([v, n]) => h('option', { value: v, selected: state.prefs.motion === v || undefined, text: n })));
  motion.addEventListener('change', () => { state.prefs.motion = motion.value; orb.setMotion(motion.value); document.body.classList.toggle('motion-off', motion.value === 'off'); persist(); });
  panel.replaceChildren(
    h('h3', { text: 'What Auto should favour' }),
    h('div', { role: 'radiogroup', 'aria-label': 'Auto priority' },
      radio('balanced', 'Balanced', 'A sensible mix of quality and speed.'),
      radio('quality', 'Quality', 'Prefer your most capable models, such as Opus, even if slower.'),
      radio('speed', 'Speed', 'Prefer your fastest models, such as Haiku, for snappy back-and-forth.')),
    h('p', { class: 'conn-sub', text: 'Auto chooses among your Claude models. Leave individual models out of Auto under Connections.' }),
    h('h3', { text: 'Animations' }),
    h('label', { class: 'field' }, h('span', { text: 'Orb and interface motion' }), motion),
    h('h3', { text: 'Data' }),
    h('p', { class: 'conn-sub', text: 'Keys, settings, memories and the current conversation are stored on this computer only. The only service Jarvis sends anything to is Claude.' }),
    h('button', { class: 'btn btn-small btn-quiet btn-danger', type: 'button', text: 'Erase everything', onclick: () => {
      if (!window.confirm('Erase all keys, settings, memories and the conversation from this computer?')) return;
      for (const k of Object.keys(localStorage)) if (k.startsWith('jarvis.')) localStorage.removeItem(k);
      location.reload();
    } }),
  );
}

// ------------------------------------------------------------------ wiring

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

$('#talk').addEventListener('click', startTalking);
$('#type').addEventListener('click', () => openComposer(true));
$('#done-speaking').addEventListener('click', () => voice.stopListening());
$('#interrupt').addEventListener('click', interrupt);
$('#stop-thinking').addEventListener('click', stopThinking);
$('#end').addEventListener('click', endConversation);
$('#handsfree').addEventListener('change', (e) => { state.prefs.handsfree = e.target.checked; persist(); if (state.phase === 'listening') setPhase('listening'); });
$('#orb-button').addEventListener('click', () => {
  if (state.phase === 'speaking') interrupt();
  else if (state.phase === 'listening') voice.stopListening();
  else if (state.phase === 'thinking') stopThinking();
  else startTalking();
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#composer-input');
  const text = input.value;
  if (!text.trim() || state.phase === 'thinking') return;
  input.value = '';
  autoGrow(input);
  if (state.phase === 'speaking') voice.cancelSpeech();
  if (state.phase === 'listening') voice.abortListening();
  send(text, { voice: false });
});
$('#composer-input').addEventListener('input', (e) => autoGrow(e.target));
$('#composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#model-chip').addEventListener('click', openPicker);
$('#open-settings').addEventListener('click', () => openSettings(TABS.find((t) => $(`#tab-${t}`).getAttribute('aria-selected') === 'true') || 'connections'));
$('#picker-manage').addEventListener('click', () => { $('#model-picker').close(); openSettings('connections'); });
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  for (const b of d.querySelectorAll('[data-close]')) b.addEventListener('click', () => d.close());
}
const tablist = $('.tabs');
tablist.addEventListener('click', (e) => {
  const tab = e.target.closest('[role="tab"]');
  if (tab) selectTab(tab.id.replace('tab-', ''));
});
tablist.addEventListener('keydown', (e) => {
  const cur = TABS.findIndex((t) => $(`#tab-${t}`) === document.activeElement);
  if (cur < 0) return;
  let next = null;
  if (e.key === 'ArrowRight') next = (cur + 1) % TABS.length;
  if (e.key === 'ArrowLeft') next = (cur - 1 + TABS.length) % TABS.length;
  if (e.key === 'Home') next = 0;
  if (e.key === 'End') next = TABS.length - 1;
  if (next === null) return;
  e.preventDefault();
  selectTab(TABS[next]);
  $(`#tab-${TABS[next]}`).focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (state.phase === 'speaking') interrupt();
  else if (state.phase === 'listening') voice.stopListening();
  else if (state.phase === 'thinking') stopThinking();
});
window.addEventListener('beforeunload', () => voice.shutdown());

// Boot
renderOnboarding();
updateChip();
renderLog();
const lastAsst = [...state.messages].reverse().find((m) => m.role === 'assistant' && m.status === 'ok');
if (lastAsst && state.messages[state.messages.length - 1] === lastAsst) renderSuggestions(lastAsst.replies);
if (state.messages.length) openComposer(false);
setPhase('idle');

// Exposed for automated tests and the curious.
window.jarvis = { state, voice, orb };
