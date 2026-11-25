// Provider definitions: which controls each model supports, how each control
// is spelled on the wire, how to build a request, how to read a reply, how to
// discover models, and how to read a rejection.
//
// Support levels:
//   'yes'       documented for this provider/model family
//   'uncertain' may work, depends on the exact model or upstream host
//   'no'        known to be rejected or ignored; the control is disabled
//
// Pure module: no DOM, no fetch. Used by the app and by the unit tests.

import { PARAMS, checkValue } from './params.js';

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

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

function isLocalUrl(url) {
  return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|host\.docker\.internal)/i.test(String(url || ''));
}

// ------------------------------------------------------- OpenAI-style chat

function openaiReasoning(model) {
  return /^(o\d|gpt-5)/i.test(model) && !/gpt-5[\w.-]*-chat/i.test(model);
}

function openaiKnown(model) {
  return /^(gpt-|o\d|chatgpt-)/i.test(model);
}

function openaiCaps(model) {
  const p = {};
  if (!openaiKnown(model)) {
    const note = 'Unrecognised OpenAI model id; support depends on the model.';
    for (const id of ['temperature', 'top_p', 'seed', 'frequency_penalty', 'presence_penalty', 'stop', 'reasoning_effort']) p[id] = maybe(note);
    p.top_k = no('OpenAI does not offer top-k.');
    p.reasoning_budget = no('OpenAI uses reasoning effort rather than a token budget.');
    p.max_output_tokens = yes({ wire: 'max_completion_tokens' });
    p.response_format = yes();
    p.stream = yes();
    p.reasoning_effort.options = ['minimal', 'low', 'medium', 'high'];
    return p;
  }
  const reasoning = openaiReasoning(model);
  if (reasoning) {
    const why = 'Reasoning models reject sampling settings.';
    p.temperature = no(why);
    p.top_p = no(why);
    p.frequency_penalty = no(why);
    p.presence_penalty = no(why);
    p.stop = maybe('Some reasoning models reject stop sequences.', { maxItems: 4 });
    p.reasoning_effort = /^gpt-5/i.test(model)
      ? maybe('Newer GPT-5 releases may accept different levels.', { options: ['minimal', 'low', 'medium', 'high'] })
      : yes({ options: ['low', 'medium', 'high'] });
  } else {
    p.temperature = yes({ min: 0, max: 2 });
    p.top_p = yes();
    p.frequency_penalty = yes();
    p.presence_penalty = yes();
    p.stop = yes({ maxItems: 4 });
    p.reasoning_effort = no('Only reasoning models (o-series, GPT-5) take reasoning effort.');
  }
  p.top_k = no('OpenAI does not offer top-k.');
  p.seed = maybe('OpenAI treats seed as best effort and may drop it for some models.');
  p.max_output_tokens = yes({ wire: 'max_completion_tokens' });
  p.reasoning_budget = no('OpenAI uses reasoning effort rather than a token budget.');
  p.response_format = yes();
  p.stream = yes();
  return p;
}

function openrouterCaps(model, meta) {
  const sp = Array.isArray(meta?.supported_parameters) ? new Set(meta.supported_parameters) : null;
  const from = (wireName, fallback) => {
    if (!sp) return fallback;
    return sp.has(wireName) ? yes() : no('OpenRouter lists this model without this setting.');
  };
  const relay = 'OpenRouter forwards this when the upstream provider supports it.';
  const p = {
    temperature: from('temperature', yes({ min: 0, max: 2 })),
    top_p: from('top_p', yes()),
    top_k: from('top_k', maybe(relay)),
    max_output_tokens: from('max_tokens', yes({ wire: 'max_tokens' })),
    stop: from('stop', yes()),
    seed: from('seed', maybe(relay)),
    frequency_penalty: from('frequency_penalty', maybe(relay)),
    presence_penalty: from('presence_penalty', maybe(relay)),
    reasoning_effort: from('reasoning', maybe('Only reasoning-capable models use this.')),
    reasoning_budget: from('reasoning', maybe('Only reasoning-capable models use this.')),
    response_format: from('response_format', maybe(relay)),
    stream: yes(),
  };
  if (p.temperature.support === 'yes') Object.assign(p.temperature, { min: 0, max: 2 });
  if (p.max_output_tokens.support !== 'no') p.max_output_tokens.wire = 'max_tokens';
  if (p.reasoning_effort.support !== 'no') p.reasoning_effort.options = ['minimal', 'low', 'medium', 'high'];
  if (meta?.context_length && p.max_output_tokens.support !== 'no') p.max_output_tokens.max = meta.top_provider?.max_completion_tokens || meta.context_length;
  return p;
}

function hfCaps() {
  const host = 'Depends on which inference provider serves the model.';
  return {
    temperature: yes({ min: 0, max: 2 }),
    top_p: yes(),
    top_k: maybe('Not part of the Hugging Face chat schema; some providers accept it.'),
    max_output_tokens: yes({ wire: 'max_tokens' }),
    stop: yes(),
    seed: maybe(host),
    frequency_penalty: maybe(host),
    presence_penalty: maybe(host),
    reasoning_effort: maybe('Only some reasoning models accept this.', { options: ['low', 'medium', 'high'] }),
    reasoning_budget: no('Hugging Face Inference Providers does not expose a thinking budget.'),
    response_format: maybe(host),
    stream: yes(),
  };
}

function compatibleCaps() {
  const note = 'OpenAI-compatible servers differ; check your server’s docs.';
  return {
    temperature: maybe(note, { min: 0, max: 2 }),
    top_p: maybe(note),
    top_k: maybe(note),
    max_output_tokens: yes({ wire: 'max_tokens' }),
    stop: maybe(note),
    seed: maybe(note),
    frequency_penalty: maybe(note),
    presence_penalty: maybe(note),
    reasoning_effort: maybe(note, { options: ['low', 'medium', 'high'] }),
    reasoning_budget: no('There is no standard thinking-budget field for OpenAI-compatible servers; use Advanced JSON.'),
    response_format: maybe(note),
    stream: yes(),
  };
}

function buildOpenAIStyle(def, ctx) {
  const { baseUrl, apiKey, model, system, messages, params, extra, caps } = ctx;
  let sys = system;
  if (params.response_format === 'json_object' && !/json/i.test(sys)) {
    sys += '\n\nRespond with a single valid JSON object.';
  }
  const body = { model, messages: [{ role: 'system', content: sys }, ...messages.map((m) => ({ role: m.role, content: m.content }))] };
  for (const [id, value] of Object.entries(params)) {
    const wire = caps[id]?.wire || def.wire[id];
    if (!wire) continue;
    if (id === 'response_format') setPath(body, wire, { type: value });
    else setPath(body, wire, value);
  }
  deepMerge(body, extra);
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (def.id === 'openrouter') {
    headers['x-title'] = 'Jarvis';
  }
  return { url: `${trimSlash(baseUrl)}/chat/completions`, method: 'POST', headers, body };
}

const OPENAI_WIRE = {
  temperature: 'temperature', top_p: 'top_p', top_k: 'top_k', max_output_tokens: 'max_tokens', stop: 'stop',
  seed: 'seed', frequency_penalty: 'frequency_penalty', presence_penalty: 'presence_penalty',
  reasoning_effort: 'reasoning_effort', response_format: 'response_format', stream: 'stream',
};

// ---------------------------------------------------------------- Anthropic

function anthropicFamily(model) {
  const m = model.toLowerCase();
  if (/claude-(fable|mythos)|claude-(opus|sonnet|haiku)-5|claude-opus-4-[78]/.test(m)) return 'current';
  if (/claude-(opus|sonnet)-4-6/.test(m)) return 'transitional';
  if (/claude-(opus|sonnet|haiku)-4(-[0-5])?|claude-3-7/.test(m)) return 'budget';
  if (/claude-3|claude-2|claude-instant/.test(m)) return 'legacy';
  return 'unknown';
}

function anthropicCaps(model) {
  const fam = anthropicFamily(model);
  const p = {
    max_output_tokens: yes({ wire: 'max_tokens', required: true, max: 128000, note: `Anthropic requires this field. While it is on Provider default, Jarvis sends ${ANTHROPIC_DEFAULT_MAX_TOKENS}.` }),
    stop: yes({ wire: 'stop_sequences' }),
    seed: no('Anthropic does not offer a seed.'),
    frequency_penalty: no('Anthropic does not offer repetition penalties.'),
    presence_penalty: no('Anthropic does not offer repetition penalties.'),
    response_format: no('Claude uses JSON schemas (output_config.format) instead; set one in Advanced JSON.'),
    stream: yes(),
  };
  const sampling = (s) => ({ temperature: { ...s, min: 0, max: 1 }, top_p: { ...s }, top_k: { ...s, max: 500 } });
  if (fam === 'current') {
    Object.assign(p, sampling(no('Current Claude models reject sampling settings.')));
    p.reasoning_effort = yes({ wire: 'output_config.effort', options: ['low', 'medium', 'high', 'xhigh', 'max'] });
    p.reasoning_budget = no('Current Claude models think adaptively; use reasoning effort instead.');
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

function buildAnthropic(def, ctx) {
  const { baseUrl, apiKey, model, system, messages, params, extra } = ctx;
  const body = {
    model,
    max_tokens: params.max_output_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };
  for (const [id, value] of Object.entries(params)) {
    if (id === 'max_output_tokens') continue;
    if (id === 'reasoning_budget') { body.thinking = { type: 'enabled', budget_tokens: value }; continue; }
    const wire = ctx.caps[id]?.wire || def.wire[id];
    if (wire) setPath(body, wire, value);
  }
  deepMerge(body, extra);
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return { url: `${trimSlash(baseUrl)}/messages`, method: 'POST', headers, body };
}

// ------------------------------------------------------------------- Gemini

function geminiCaps(model, meta) {
  const m = model.toLowerCase();
  const gen3 = /gemini-3/.test(m);
  const thinks = meta?.thinking ?? /gemini-(2\.5|3)/.test(m);
  const p = {
    temperature: yes({ min: 0, max: meta?.maxTemperature ?? 2 }),
    top_p: yes(),
    top_k: maybe('Some Gemini models fix top-k and ignore changes.'),
    max_output_tokens: yes({ max: meta?.outputTokenLimit ?? 65536 }),
    stop: yes({ maxItems: 5 }),
    seed: yes(),
    frequency_penalty: maybe('Only some Gemini models accept penalties.'),
    presence_penalty: maybe('Only some Gemini models accept penalties.'),
    response_format: yes(),
    stream: yes({ note: 'Uses the streaming endpoint.' }),
  };
  if (gen3) {
    p.reasoning_effort = yes({ wire: 'generationConfig.thinkingConfig.thinkingLevel', options: ['low', 'high'] });
    p.reasoning_budget = maybe('Gemini 3 prefers thinking level; budgets are kept for compatibility.', { min: 0 });
  } else if (thinks) {
    p.reasoning_effort = no('Gemini 2.5 uses a thinking budget instead of a level.');
    p.reasoning_budget = yes({ min: 0, max: 32768, note: '0 turns thinking off where the model allows it.' });
  } else {
    p.reasoning_effort = no('This Gemini model does not think before answering.');
    p.reasoning_budget = no('This Gemini model does not think before answering.');
  }
  return p;
}

const GEMINI_WIRE = {
  temperature: 'generationConfig.temperature', top_p: 'generationConfig.topP', top_k: 'generationConfig.topK',
  max_output_tokens: 'generationConfig.maxOutputTokens', stop: 'generationConfig.stopSequences',
  seed: 'generationConfig.seed', frequency_penalty: 'generationConfig.frequencyPenalty',
  presence_penalty: 'generationConfig.presencePenalty', reasoning_budget: 'generationConfig.thinkingConfig.thinkingBudget',
  reasoning_effort: 'generationConfig.thinkingConfig.thinkingLevel', response_format: 'generationConfig.responseMimeType',
};

function buildGemini(def, ctx) {
  const { baseUrl, apiKey, model, system, messages, params, extra } = ctx;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
  };
  for (const [id, value] of Object.entries(params)) {
    if (id === 'stream') continue;
    const wire = ctx.caps[id]?.wire || def.wire[id];
    if (!wire) continue;
    setPath(body, wire, id === 'response_format' ? (value === 'json_object' ? 'application/json' : 'text/plain') : value);
  }
  deepMerge(body, extra);
  const name = model.replace(/^models\//, '');
  const action = params.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['x-goog-api-key'] = apiKey;
  return { url: `${trimSlash(baseUrl)}/models/${encodeURIComponent(name)}:${action}`, method: 'POST', headers, body };
}

// ------------------------------------------------------------------- Ollama

function ollamaCaps(model) {
  return {
    temperature: yes({ min: 0, max: 2 }),
    top_p: yes(),
    top_k: yes(),
    max_output_tokens: yes({ wire: 'options.num_predict' }),
    stop: yes(),
    seed: yes(),
    frequency_penalty: maybe('Accepted by Ollama; some model runners ignore it.'),
    presence_penalty: maybe('Accepted by Ollama; some model runners ignore it.'),
    reasoning_effort: /gpt-oss/i.test(model)
      ? yes({ wire: 'think', options: ['low', 'medium', 'high'] })
      : maybe('Only thinking models use this; most accept on/off rather than levels.', { wire: 'think', options: ['low', 'medium', 'high'] }),
    reasoning_budget: no('Ollama does not offer a thinking budget.'),
    response_format: yes({ wire: 'format' }),
    stream: yes({ note: 'Ollama streams by default.' }),
  };
}

const OLLAMA_WIRE = {
  temperature: 'options.temperature', top_p: 'options.top_p', top_k: 'options.top_k', max_output_tokens: 'options.num_predict',
  stop: 'options.stop', seed: 'options.seed', frequency_penalty: 'options.frequency_penalty',
  presence_penalty: 'options.presence_penalty', reasoning_effort: 'think', response_format: 'format', stream: 'stream',
};

function buildOllama(def, ctx) {
  const { baseUrl, model, system, messages, params, extra, apiKey } = ctx;
  const body = { model, messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))] };
  for (const [id, value] of Object.entries(params)) {
    const wire = ctx.caps[id]?.wire || def.wire[id];
    if (!wire) continue;
    if (id === 'response_format') { if (value === 'json_object') body.format = 'json'; continue; }
    setPath(body, wire, value);
  }
  deepMerge(body, extra);
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return { url: `${trimSlash(baseUrl)}/api/chat`, method: 'POST', headers, body };
}

// --------------------------------------------------------------- registry

const authBearer = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const listData = (j) => (Array.isArray(j?.data) ? j.data : []).map((m) => ({ id: m.id, meta: m }));

export const PROVIDERS = {
  demo: {
    id: 'demo', name: 'Jarvis Demo (simulated)', kind: 'demo', defaultBaseUrl: '', keyRequired: false,
    blurb: 'A built-in simulated model so you can try Jarvis without any account. It runs in your browser and is not a real AI.',
    defaultModels: ['jarvis-demo'],
    caps: () => ({
      temperature: yes({ min: 0, max: 2, note: 'Simulated: changes how the demo phrases its questions.' }),
      max_output_tokens: yes(),
      stream: yes(),
    }),
    extras: () => [],
    wire: { temperature: 'temperature', max_output_tokens: 'max_tokens', stream: 'stream' },
    build(ctx) {
      const body = { model: ctx.model, messages: ctx.messages.length };
      for (const [id, v] of Object.entries(ctx.params)) if (this.wire[id]) body[this.wire[id]] = v;
      return { url: 'local://demo', method: 'POST', headers: {}, body: deepMerge(body, ctx.extra) };
    },
  },
  openai: {
    id: 'openai', name: 'OpenAI', kind: 'openai', defaultBaseUrl: 'https://api.openai.com/v1', keyRequired: true,
    blurb: 'GPT and o-series models. Create a key at platform.openai.com.',
    caps: (model) => openaiCaps(model),
    extras: (model) => [
      { id: 'service_tier', label: 'Service tier', type: 'enum', options: ['auto', 'default', 'flex', 'priority'], wire: 'service_tier', support: 'uncertain', note: 'Availability depends on your account and model.', desc: 'Trade speed for price where OpenAI offers slower or priority processing.' },
      ...(openaiReasoning(model) && /^gpt-5/i.test(model)
        ? [{ id: 'verbosity', label: 'Verbosity', type: 'enum', options: ['low', 'medium', 'high'], wire: 'verbosity', support: 'yes', desc: 'How long and detailed GPT-5 replies are by default.' }]
        : []),
    ],
    wire: { ...OPENAI_WIRE, max_output_tokens: 'max_completion_tokens' },
    build(ctx) { return buildOpenAIStyle(this, ctx); },
    discover: (conn) => ({ url: `${trimSlash(conn.baseUrl)}/models`, headers: authBearer(conn.apiKey) }),
    parseModels: (j) => listData(j).filter((m) => /^(gpt|o\d|chatgpt)/i.test(m.id) && !/(embed|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|search)/i.test(m.id)),
  },
  anthropic: {
    id: 'anthropic', name: 'Anthropic', kind: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1', keyRequired: true,
    blurb: 'Claude models. Create a key at platform.claude.com.',
    caps: (model) => anthropicCaps(model),
    extras: () => [
      { id: 'thinking_display', label: 'Show thinking summary', type: 'enum', options: ['summarized', 'omitted'], wire: 'thinking.display', support: 'uncertain', note: 'Only for models that think adaptively; sends thinking.type "adaptive" with it.', desc: 'Whether Claude returns a readable summary of its reasoning.', also: { 'thinking.type': 'adaptive' } },
      { id: 'inference_geo', label: 'Inference region', type: 'enum', options: ['global', 'us'], wire: 'inference_geo', support: 'uncertain', note: 'Supported on Claude 4.6 and later.', desc: 'Where Anthropic runs the model for this request.' },
    ],
    wire: { temperature: 'temperature', top_p: 'top_p', top_k: 'top_k', stop: 'stop_sequences', stream: 'stream', reasoning_effort: 'output_config.effort' },
    build(ctx) { return buildAnthropic(this, ctx); },
    discover: (conn) => ({ url: `${trimSlash(conn.baseUrl)}/models?limit=100`, headers: { 'x-api-key': conn.apiKey || '', 'anthropic-version': '2023-06-01' } }),
    parseModels: (j) => listData(j),
  },
  gemini: {
    id: 'gemini', name: 'Google Gemini', kind: 'gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyRequired: true,
    blurb: 'Gemini models. Create a key at aistudio.google.com.',
    caps: (model, meta) => geminiCaps(model, meta),
    extras: () => [
      { id: 'include_thoughts', label: 'Include thought summaries', type: 'boolean', wire: 'generationConfig.thinkingConfig.includeThoughts', support: 'uncertain', note: 'Thinking models only.', desc: 'Ask Gemini to return summaries of its reasoning (Jarvis hides them from the reply).' },
      { id: 'candidate_count', label: 'Candidate count', type: 'integer', min: 1, max: 8, wire: 'generationConfig.candidateCount', support: 'uncertain', desc: 'How many alternative replies to generate; Jarvis shows the first.' },
    ],
    wire: GEMINI_WIRE,
    build(ctx) { return buildGemini(this, ctx); },
    discover: (conn) => ({ url: `${trimSlash(conn.baseUrl)}/models?pageSize=200`, headers: { 'x-goog-api-key': conn.apiKey || '' } }),
    parseModels: (j) => (Array.isArray(j?.models) ? j.models : [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ''), meta: m })),
  },
  huggingface: {
    id: 'huggingface', name: 'Hugging Face Inference Providers', kind: 'openai', defaultBaseUrl: 'https://router.huggingface.co/v1', keyRequired: true,
    blurb: 'Open models served by Hugging Face partners. Use a token from huggingface.co/settings/tokens. Add ":provider" to a model id to pin a provider.',
    caps: () => hfCaps(),
    extras: () => [],
    wire: OPENAI_WIRE,
    build(ctx) { return buildOpenAIStyle(this, ctx); },
    discover: (conn) => ({ url: `${trimSlash(conn.baseUrl)}/models`, headers: authBearer(conn.apiKey) }),
    parseModels: (j) => listData(j),
  },
  openrouter: {
    id: 'openrouter', name: 'OpenRouter', kind: 'openai', defaultBaseUrl: 'https://openrouter.ai/api/v1', keyRequired: true,
    blurb: 'Hundreds of models through one key from openrouter.ai. Discovery reads which settings each model accepts.',
    caps: (model, meta) => openrouterCaps(model, meta),
    extras: () => [
      { id: 'min_p', label: 'Min-p', type: 'number', min: 0, max: 1, step: 0.01, wire: 'min_p', support: 'uncertain', desc: 'Drops word choices less likely than this share of the top choice.' },
      { id: 'repetition_penalty', label: 'Repetition penalty', type: 'number', min: 0, max: 2, step: 0.05, wire: 'repetition_penalty', support: 'uncertain', desc: 'Values above 1 discourage repeating text that already appeared.' },
      { id: 'provider_sort', label: 'Route by', type: 'enum', options: ['price', 'throughput', 'latency'], wire: 'provider.sort', support: 'yes', desc: 'Which upstream provider OpenRouter tries first for this model.' },
      { id: 'require_parameters', label: 'Require every setting', type: 'boolean', wire: 'provider.require_parameters', support: 'yes', desc: 'Only use upstream providers that honour every setting you changed.' },
    ],
    wire: { ...OPENAI_WIRE, reasoning_effort: 'reasoning.effort', reasoning_budget: 'reasoning.max_tokens' },
    build(ctx) { return buildOpenAIStyle(this, ctx); },
    discover: (conn) => ({ url: `${trimSlash(conn.baseUrl)}/models`, headers: authBearer(conn.apiKey) }),
    parseModels: (j) => listData(j),
  },
  ollama: {
    id: 'ollama', name: 'Ollama (local)', kind: 'ollama', defaultBaseUrl: 'http://localhost:11434', keyRequired: false,
    blurb: 'Models running on your own computer. Install from ollama.com, then "ollama pull llama3.2".',
    caps: (model) => ollamaCaps(model),
    extras: () => [
      { id: 'num_ctx', label: 'Context window', type: 'integer', min: 256, max: 1048576, step: 256, wire: 'options.num_ctx', support: 'yes', desc: 'How many tokens of conversation the local model keeps in view.' },
      { id: 'repeat_penalty', label: 'Repeat penalty', type: 'number', min: 0, max: 2, step: 0.05, wire: 'options.repeat_penalty', support: 'yes', desc: 'Values above 1 discourage the model from repeating itself.' },
      { id: 'min_p', label: 'Min-p', type: 'number', min: 0, max: 1, step: 0.01, wire: 'options.min_p', support: 'yes', desc: 'Drops word choices less likely than this share of the top choice.' },
      { id: 'keep_alive', label: 'Keep loaded for', type: 'string', wire: 'keep_alive', support: 'yes', desc: 'How long Ollama keeps the model in memory after replying, such as "5m" or "1h".' },
    ],
    wire: OLLAMA_WIRE,
    build(ctx) { return buildOllama(this, ctx); },
    discover: (conn) => ({ url: `${trimSlash(conn.baseUrl)}/api/tags`, headers: {} }),
    parseModels: (j) => (Array.isArray(j?.models) ? j.models : []).map((m) => ({ id: m.name || m.model, meta: m })),
  },
  compatible: {
    id: 'compatible', name: 'OpenAI-compatible server', kind: 'openai', defaultBaseUrl: 'http://localhost:1234/v1', keyRequired: false,
    blurb: 'LM Studio, vLLM, llama.cpp, LocalAI or any server that speaks the OpenAI chat format.',
    caps: () => compatibleCaps(),
    extras: () => [],
    wire: OPENAI_WIRE,
    build(ctx) { return buildOpenAIStyle(this, ctx); },
    discover: (conn) => ({ url: `${trimSlash(conn.baseUrl)}/models`, headers: authBearer(conn.apiKey) }),
    parseModels: (j) => listData(j),
  },
};

export const PROVIDER_ORDER = ['openai', 'anthropic', 'gemini', 'huggingface', 'openrouter', 'ollama', 'compatible', 'demo'];

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

export function isLocalConnection(conn) {
  return conn.providerId === 'ollama' || (conn.providerId === 'compatible' && isLocalUrl(conn.baseUrl)) || conn.providerId === 'demo';
}

// ------------------------------------------------- capabilities & settings

// Full description of every control for one model: merged catalog entry,
// support level, narrowed range, and wire name.
export function describeControls(providerId, model, meta) {
  const prov = getProvider(providerId);
  const caps = prov.caps(model, meta) || {};
  const common = [];
  for (const [id, base] of Object.entries(PARAMS)) {
    const cap = caps[id] || { support: 'no', note: `${prov.name} does not offer this setting.` };
    const def = { ...base, ...cap, id, label: base.label, desc: base.desc };
    if (cap.options) def.options = cap.options;
    def.wire = cap.wire || prov.wire?.[id] || null;
    common.push(def);
  }
  const extras = (prov.extras?.(model, meta) || []).map((e) => ({ ...e, extra: true }));
  return { common, extras, caps };
}

// Split saved settings into what will be sent and what is skipped.
export function effectiveParams(providerId, model, meta, saved = {}) {
  const { common, extras } = describeControls(providerId, model, meta);
  const send = {};
  const sendExtras = {};
  const skipped = [];
  for (const def of common) {
    const v = saved.params?.[def.id];
    if (v === undefined) continue;
    if (def.support === 'no') skipped.push({ id: def.id, label: def.label, reason: def.note || 'Not supported by this model.' });
    else send[def.id] = v;
  }
  for (const def of extras) {
    const v = saved.params?.[def.id];
    if (v === undefined) continue;
    if (def.support === 'no') { skipped.push({ id: def.id, label: def.label, reason: def.note }); continue; }
    sendExtras[def.id] = v;
  }
  return { params: send, extraParams: sendExtras, skipped, common, extras };
}

// Validate values, ranges and combinations. Returns a list of issues:
// { param, level: 'error' | 'warning', message }. Errors block sending.
export function validateSettings(providerId, model, meta, saved = {}) {
  const issues = [];
  const { params, extraParams, common, extras } = effectiveParams(providerId, model, meta, saved);
  const byId = Object.fromEntries([...common, ...extras].map((d) => [d.id, d]));
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

  if (providerId === 'anthropic') {
    const maxTokens = params.max_output_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
    if (has('reasoning_budget')) {
      if (params.reasoning_budget < 1024) issues.push({ param: 'reasoning_budget', level: 'error', message: 'Claude needs a reasoning budget of at least 1024 tokens.' });
      if (params.reasoning_budget >= maxTokens) issues.push({ param: 'reasoning_budget', level: 'error', message: `The reasoning budget must be smaller than the output token limit (${maxTokens}).` });
      for (const id of ['temperature', 'top_k']) {
        if (has(id)) issues.push({ param: id, level: 'error', message: `Claude does not allow ${byId[id].label.toLowerCase()} changes while a reasoning budget is set.` });
      }
      if (has('top_p') && (params.top_p < 0.95)) issues.push({ param: 'top_p', level: 'error', message: 'With a reasoning budget, Claude only accepts top-p between 0.95 and 1.' });
    }
    if (has('temperature') && has('top_p')) issues.push({ param: 'top_p', level: 'warning', message: 'Recent Claude models reject temperature and top-p together. Change only one if the request fails.' });
    if (has('reasoning_budget') && has('reasoning_effort')) issues.push({ param: 'reasoning_effort', level: 'warning', message: 'Reasoning effort and a reasoning budget overlap; Claude may reject the pair.' });
  }
  if (providerId === 'openrouter' && has('reasoning_effort') && has('reasoning_budget')) {
    issues.push({ param: 'reasoning_budget', level: 'error', message: 'OpenRouter takes either reasoning effort or a reasoning budget, not both.' });
  }
  if (providerId === 'gemini' && has('reasoning_effort') && has('reasoning_budget')) {
    issues.push({ param: 'reasoning_budget', level: 'error', message: 'Gemini rejects a thinking level and a thinking budget together.' });
  }
  if (has('reasoning_budget') && has('max_output_tokens') && providerId !== 'anthropic' && params.reasoning_budget >= params.max_output_tokens) {
    issues.push({ param: 'reasoning_budget', level: 'warning', message: 'The reasoning budget is as large as the whole output limit, which may leave no room for the answer.' });
  }
  if (has('temperature') && params.temperature === 0 && has('top_p')) {
    issues.push({ param: 'top_p', level: 'warning', message: 'At temperature 0 top-p has no effect.' });
  }
  if (has('stream') && params.stream === false && extraParams.include_thoughts) {
    // fine; nothing to flag
  }
  // Advanced JSON
  const extra = saved.extra;
  if (extra !== undefined && (typeof extra !== 'object' || extra === null || Array.isArray(extra))) {
    issues.push({ param: '__extra', level: 'error', message: 'Advanced JSON must be an object, like {"key": "value"}.' });
  } else if (extra) {
    const prov = getProvider(providerId);
    const wires = new Map();
    for (const d of [...common, ...extras]) if (d.wire) wires.set(d.wire.split('.')[0], d.label);
    for (const k of Object.keys(extra)) {
      if (['model', 'messages', 'contents', 'system', 'systemInstruction'].includes(k)) {
        issues.push({ param: '__extra', level: 'error', message: `"${k}" is managed by Jarvis and cannot be set in Advanced JSON.` });
      } else if (wires.has(k) && !['generationConfig', 'options', 'provider', 'reasoning', 'output_config', 'thinking'].includes(k)) {
        issues.push({ param: '__extra', level: 'warning', message: `"${k}" in Advanced JSON overrides the ${wires.get(k)} control.` });
      }
    }
    void prov;
  }
  return issues;
}

// Build the exact outgoing request for one model.
export function buildRequest({ conn, model, meta, saved, system, messages }) {
  const prov = getProvider(conn.providerId);
  const eff = effectiveParams(conn.providerId, model, meta, saved);
  const extraBody = {};
  for (const def of eff.extras) {
    if (eff.extraParams[def.id] === undefined) continue;
    setPath(extraBody, def.wire, eff.extraParams[def.id]);
    if (def.also) for (const [p, v] of Object.entries(def.also)) setPath(extraBody, p, v);
  }
  deepMerge(extraBody, saved?.extra || {});
  const caps = Object.fromEntries(eff.common.map((d) => [d.id, d]));
  const req = prov.build({
    baseUrl: conn.baseUrl || prov.defaultBaseUrl,
    apiKey: conn.apiKey,
    model, system, messages, params: eff.params, extra: extraBody, caps,
  });
  return { ...req, skipped: eff.skipped, kind: prov.kind, stream: eff.params.stream === true || (prov.kind === 'ollama' && eff.params.stream !== false) };
}

export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = /authorization|api-key|x-goog-api-key/i.test(k) ? (v ? '•••• (hidden)' : v) : v;
  }
  return out;
}

// --------------------------------------------------------- reading replies

export function extractText(kind, json) {
  if (!json) return '';
  switch (kind) {
    case 'anthropic':
      return (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    case 'gemini':
      return (json.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    case 'ollama':
      return json.message?.content || '';
    case 'openai':
    default:
      return json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? '';
  }
}

// One parsed streaming event -> { delta, error, done }
export function extractDelta(kind, evt) {
  if (!evt) return {};
  if (evt.error) return { error: typeof evt.error === 'string' ? evt.error : evt.error.message || JSON.stringify(evt.error) };
  switch (kind) {
    case 'anthropic':
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') return { delta: evt.delta.text };
      if (evt.type === 'message_stop') return { done: true };
      return {};
    case 'gemini':
      return { delta: extractText('gemini', evt) };
    case 'ollama':
      return { delta: evt.message?.content || '', done: !!evt.done };
    case 'openai':
    default:
      return { delta: evt.choices?.[0]?.delta?.content || '' };
  }
}

// Read a rejection. Returns { message, param } where param is the id of the
// control the provider complained about, when we can tell.
export function parseError(providerId, model, meta, status, text) {
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const errObj = Array.isArray(json) ? json[0]?.error : json?.error;
  let message = (typeof errObj === 'string' ? errObj : errObj?.message) || json?.message || json?.detail || String(text || '').slice(0, 400) || `HTTP ${status}`;
  if (typeof message !== 'string') message = JSON.stringify(message);
  const hints = [];
  if (errObj?.param) hints.push(String(errObj.param));
  for (const d of errObj?.details || []) for (const f of d.fieldViolations || []) hints.push(String(f.field || ''));
  hints.push(message);
  const haystack = hints.join(' \n ').toLowerCase();

  const { common, extras } = describeControls(providerId, model, meta);
  const candidates = [];
  for (const d of [...common, ...extras]) {
    const names = new Set([d.id]);
    if (d.wire) { names.add(d.wire); names.add(d.wire.split('.').pop()); }
    // snake_case <-> camelCase, e.g. top_k / topK / top-k
    for (const n of [...names]) {
      names.add(n.replace(/_([a-z])/g, (_, c) => c.toUpperCase()));
      names.add(n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
      names.add(n.replace(/_/g, '-'));
    }
    if (d.id === 'reasoning_budget') { names.add('budget_tokens'); names.add('thinking'); }
    if (d.id === 'max_output_tokens') { names.add('max_tokens'); names.add('max_completion_tokens'); }
    for (const n of names) {
      const esc = n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`);
      const m = haystack.match(re);
      if (m) candidates.push({ id: d.id, at: m.index, len: n.length });
    }
  }
  candidates.sort((a, b) => a.at - b.at || b.len - a.len);
  const param = candidates[0]?.id || null;
  return { message, param, status };
}
