import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequest, validateSettings, parseError, effectiveParams, describeControls, redactHeaders,
  extractText, extractDelta, ANTHROPIC_DEFAULT_MAX_TOKENS,
} from '../../public/js/providers.js';

const conn = (providerId, extra = {}) => ({ id: 'c1', providerId, name: providerId, baseUrl: '', apiKey: 'sk-test', models: [], ...extra });
const msgs = [{ role: 'user', content: 'hello' }];
const build = (providerId, model, saved = {}, meta) => buildRequest({ conn: conn(providerId), model, meta, saved, system: 'SYS', messages: msgs });

test('provider default means the control is omitted from the request', () => {
  for (const [pid, model] of [['openai', 'gpt-4.1-mini'], ['gemini', 'gemini-2.5-flash'], ['ollama', 'llama3.2'], ['openrouter', 'x/y'], ['huggingface', 'm/n'], ['compatible', 'local']]) {
    const req = build(pid, model);
    const body = JSON.stringify(req.body);
    for (const w of ['temperature', 'top_p', 'topP', 'top_k', 'max_tokens', 'max_completion_tokens', 'maxOutputTokens', 'seed', 'stop', 'penalty', 'Penalty', 'reasoning', 'thinking', 'response_format', 'responseMimeType', '"stream"', 'options']) {
      assert.ok(!body.includes(w), `${pid} default body should not contain ${w}: ${body}`);
    }
  }
});

test('Anthropic always sends max_tokens because the API requires it', () => {
  const req = build('anthropic', 'claude-opus-5-5');
  assert.equal(req.body.max_tokens, ANTHROPIC_DEFAULT_MAX_TOKENS);
  assert.deepEqual(Object.keys(req.body).sort(), ['max_tokens', 'messages', 'model', 'system']);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['x-api-key'], 'sk-test');
  assert.match(req.url, /\/messages$/);
});

test('OpenAI non-reasoning model maps every sampling control', () => {
  const req = build('openai', 'gpt-4.1-mini', { params: { temperature: 0.3, top_p: 0.9, max_output_tokens: 300, stop: ['END'], seed: 7, frequency_penalty: 0.5, presence_penalty: -0.2, response_format: 'json_object', stream: true } });
  const b = req.body;
  assert.equal(b.temperature, 0.3);
  assert.equal(b.top_p, 0.9);
  assert.equal(b.max_completion_tokens, 300);
  assert.equal(b.max_tokens, undefined);
  assert.deepEqual(b.stop, ['END']);
  assert.equal(b.seed, 7);
  assert.deepEqual(b.response_format, { type: 'json_object' });
  assert.equal(b.stream, true);
  assert.match(b.messages[0].content, /JSON/, 'json mode adds the instruction OpenAI requires');
  assert.equal(req.headers.authorization, 'Bearer sk-test');
});

test('OpenAI reasoning models drop sampling settings and accept reasoning effort', () => {
  const saved = { params: { temperature: 0.2, reasoning_effort: 'high' } };
  const req = build('openai', 'o3', saved);
  assert.equal(req.body.temperature, undefined);
  assert.equal(req.body.reasoning_effort, 'high');
  assert.deepEqual(req.skipped.map((s) => s.id), ['temperature']);
  const issues = validateSettings('openai', 'o3', null, saved);
  assert.ok(issues.some((i) => i.param === 'temperature' && i.level === 'warning'));
});

test('current Claude models: effort goes to output_config, sampling is not sent', () => {
  const req = build('anthropic', 'claude-sonnet-5-5', { params: { reasoning_effort: 'low', temperature: 0.5, max_output_tokens: 1000, stop: ['###'] } });
  assert.deepEqual(req.body.output_config, { effort: 'low' });
  assert.equal(req.body.temperature, undefined);
  assert.equal(req.body.max_tokens, 1000);
  assert.deepEqual(req.body.stop_sequences, ['###']);
  const ctl = describeControls('anthropic', 'claude-sonnet-5-5').common.find((d) => d.id === 'reasoning_budget');
  assert.equal(ctl.support, 'no');
});

test('older Claude models use a thinking budget and validate it', () => {
  const ok = build('anthropic', 'claude-sonnet-4-5', { params: { reasoning_budget: 2048, max_output_tokens: 8000 } });
  assert.deepEqual(ok.body.thinking, { type: 'enabled', budget_tokens: 2048 });
  const bad = validateSettings('anthropic', 'claude-sonnet-4-5', null, { params: { reasoning_budget: 512, temperature: 0.4 } });
  assert.ok(bad.some((i) => i.param === 'reasoning_budget' && i.level === 'error' && /1024/.test(i.message)));
  assert.ok(bad.some((i) => i.param === 'temperature' && i.level === 'error'));
  const tooBig = validateSettings('anthropic', 'claude-sonnet-4-5', null, { params: { reasoning_budget: 5000 } });
  assert.ok(tooBig.some((i) => i.param === 'reasoning_budget' && /smaller than the output token limit/.test(i.message)));
});

test('range validation uses the provider-narrowed range', () => {
  const issues = validateSettings('anthropic', 'claude-sonnet-4-5', null, { params: { temperature: 1.5 } });
  assert.ok(issues.some((i) => i.param === 'temperature' && i.level === 'error' && /at most 1/.test(i.message)));
  assert.equal(validateSettings('openai', 'gpt-4.1', null, { params: { temperature: 1.5 } }).length, 0);
  const stops = validateSettings('openai', 'gpt-4.1', null, { params: { stop: ['a', 'b', 'c', 'd', 'e'] } });
  assert.ok(stops.some((i) => i.param === 'stop' && i.level === 'error'));
});

test('Gemini maps into generationConfig and switches endpoint for streaming', () => {
  const req = build('gemini', 'gemini-2.5-flash', { params: { temperature: 0.7, top_k: 20, max_output_tokens: 512, response_format: 'json_object', reasoning_budget: 0, stream: true } });
  assert.deepEqual(req.body.generationConfig, { temperature: 0.7, topK: 20, maxOutputTokens: 512, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } });
  assert.match(req.url, /models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(req.body.contents[0].role, 'user');
  assert.equal(req.headers['x-goog-api-key'], 'sk-test');
  const both = validateSettings('gemini', 'gemini-3-pro', null, { params: { reasoning_effort: 'low', reasoning_budget: 100 } });
  assert.ok(both.some((i) => i.level === 'error'));
});

test('Ollama maps into options and provider-specific extras', () => {
  const req = build('ollama', 'llama3.2', { params: { temperature: 0.1, top_k: 30, max_output_tokens: 99, num_ctx: 8192, keep_alive: '10m', response_format: 'json_object' } });
  assert.deepEqual(req.body.options, { temperature: 0.1, top_k: 30, num_predict: 99, num_ctx: 8192 });
  assert.equal(req.body.keep_alive, '10m');
  assert.equal(req.body.format, 'json');
  assert.match(req.url, /\/api\/chat$/);
  assert.equal(req.stream, true, 'Ollama streams unless told otherwise');
});

test('OpenRouter reads supported_parameters from discovery metadata', () => {
  const meta = { supported_parameters: ['temperature', 'max_tokens', 'reasoning'] };
  const ctl = Object.fromEntries(describeControls('openrouter', 'a/b', meta).common.map((d) => [d.id, d.support]));
  assert.equal(ctl.temperature, 'yes');
  assert.equal(ctl.top_k, 'no');
  assert.equal(ctl.reasoning_effort, 'yes');
  const req = buildRequest({ conn: conn('openrouter'), model: 'a/b', meta, saved: { params: { reasoning_effort: 'high', provider_sort: 'latency', require_parameters: true } }, system: 's', messages: msgs });
  assert.deepEqual(req.body.reasoning, { effort: 'high' });
  assert.deepEqual(req.body.provider, { sort: 'latency', require_parameters: true });
});

test('advanced JSON merges last and protected keys are rejected', () => {
  const req = build('openai', 'gpt-4.1', { params: {}, extra: { logprobs: true, metadata: { a: 1 } } });
  assert.equal(req.body.logprobs, true);
  const issues = validateSettings('openai', 'gpt-4.1', null, { extra: { messages: [] } });
  assert.ok(issues.some((i) => i.param === '__extra' && i.level === 'error'));
  const arr = validateSettings('openai', 'gpt-4.1', null, { extra: [1] });
  assert.ok(arr.some((i) => i.param === '__extra' && i.level === 'error'));
});

test('two models keep entirely separate settings', () => {
  const a = effectiveParams('openai', 'gpt-4.1-mini', null, { params: { temperature: 0.2 } });
  const b = effectiveParams('anthropic', 'claude-sonnet-4-5', null, { params: { top_k: 40 } });
  assert.deepEqual(a.params, { temperature: 0.2 });
  assert.deepEqual(b.params, { top_k: 40 });
});

test('parseError identifies the setting a provider rejected', () => {
  const openai = parseError('openai', 'gpt-4.1', null, 400, JSON.stringify({ error: { message: 'Invalid value', param: 'presence_penalty' } }));
  assert.equal(openai.param, 'presence_penalty');
  const anthropic = parseError('anthropic', 'claude-sonnet-4-5', null, 400, JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'temperature: range: 0..1' } }));
  assert.equal(anthropic.param, 'temperature');
  assert.equal(anthropic.message, 'temperature: range: 0..1');
  const gemini = parseError('gemini', 'gemini-2.5-flash', null, 400, JSON.stringify({ error: { message: 'Invalid JSON payload', details: [{ fieldViolations: [{ field: 'generation_config.top_k' }] }] } }));
  assert.equal(gemini.param, 'top_k');
  const gem2 = parseError('gemini', 'gemini-2.5-flash', null, 400, JSON.stringify({ error: { message: 'maxOutputTokens must be positive' } }));
  assert.equal(gem2.param, 'max_output_tokens');
  const ollama = parseError('ollama', 'llama3.2', null, 400, JSON.stringify({ error: 'option num_ctx too large' }));
  assert.equal(ollama.param, 'num_ctx');
  const none = parseError('openai', 'gpt-4.1', null, 401, JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  assert.equal(none.param, null);
  const thinking = parseError('anthropic', 'claude-sonnet-4-5', null, 400, '{"error":{"message":"thinking.budget_tokens: Input should be greater than or equal to 1024"}}');
  assert.equal(thinking.param, 'reasoning_budget');
});

test('replies are read for each wire format', () => {
  assert.equal(extractText('openai', { choices: [{ message: { content: 'a' } }] }), 'a');
  assert.equal(extractText('anthropic', { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'b' }] }), 'b');
  assert.equal(extractText('gemini', { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }, { text: 'c' }] } }] }), 'c');
  assert.equal(extractText('ollama', { message: { content: 'd' } }), 'd');
  assert.equal(extractDelta('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'e' } }).delta, 'e');
  assert.equal(extractDelta('openai', { choices: [{ delta: { content: 'f' } }] }).delta, 'f');
  assert.ok(extractDelta('anthropic', { type: 'error', error: { message: 'overloaded' } }).error);
});

test('keys are hidden in anything shown to the user', () => {
  const r = redactHeaders({ authorization: 'Bearer x', 'x-api-key': 'y', 'x-goog-api-key': 'z', 'content-type': 'application/json' });
  assert.ok(!JSON.stringify(r).includes('Bearer x'));
  assert.ok(!Object.values(r).includes('y'));
  assert.equal(r['content-type'], 'application/json');
});
