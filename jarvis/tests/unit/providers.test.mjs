import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequest, validateSettings, parseError, effectiveParams, describeControls, redactHeaders,
  readMessage, readEvent, family, defaultMaxTokens, FALLBACK_BETA, DEFAULT_MODELS,
} from '../../public/js/providers.js';

const conn = { id: 'c1', providerId: 'anthropic', name: 'Claude', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-test', models: [] };
const msgs = [{ role: 'user', content: 'hello' }];
const build = (model, saved = {}, meta) => buildRequest({ conn, model, meta, saved, system: 'SYS', messages: msgs });

test('defaults: only what Claude requires is sent', () => {
  const req = build('claude-sonnet-4-5');
  assert.deepEqual(Object.keys(req.body).sort(), ['max_tokens', 'messages', 'model', 'system']);
  assert.equal(req.body.max_tokens, 16000);
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['x-api-key'], 'sk-ant-test');
  assert.equal(req.headers['anthropic-beta'], undefined);
});

test('streaming raises the default output limit', () => {
  assert.equal(build('claude-sonnet-4-5', { params: { stream: true } }).body.max_tokens, 64000);
  assert.equal(defaultMaxTokens(false), 16000);
});

test('current models default to refusal fallback, which can be turned off', () => {
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    const req = build(m);
    assert.equal(req.body.fallbacks, 'default');
    assert.equal(req.headers['anthropic-beta'], FALLBACK_BETA);
    const off = build(m, { params: { refusal_fallback: false } });
    assert.equal(off.body.fallbacks, undefined);
    assert.equal(off.headers['anthropic-beta'], undefined);
  }
  assert.equal(build('claude-haiku-5-5').body.fallbacks, undefined, 'Haiku has no server-side fallback');
});

test('current models: sampling disabled, effort goes to output_config', () => {
  const req = build('claude-opus-5-5', { params: { reasoning_effort: 'high', temperature: 0.5, top_k: 10, max_output_tokens: 1000, stop: ['###'] } });
  assert.deepEqual(req.body.output_config, { effort: 'high' });
  assert.equal(req.body.temperature, undefined);
  assert.equal(req.body.top_k, undefined);
  assert.equal(req.body.max_tokens, 1000);
  assert.deepEqual(req.body.stop_sequences, ['###']);
  assert.deepEqual(req.skipped.map((s) => s.id).sort(), ['temperature', 'top_k']);
  const ctl = Object.fromEntries(describeControls('claude-opus-5-5').common.map((d) => [d.id, d]));
  assert.equal(ctl.temperature.support, 'no');
  assert.equal(ctl.reasoning_budget.support, 'no');
  assert.deepEqual(ctl.reasoning_effort.options, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('model families', () => {
  for (const m of DEFAULT_MODELS) assert.equal(family(m), 'current');
  assert.equal(family('claude-opus-4-7'), 'current');
  assert.equal(family('claude-sonnet-4-6'), 'transitional');
  assert.equal(family('claude-haiku-4-5'), 'budget');
  assert.equal(family('claude-3-5-haiku-latest'), 'legacy');
  assert.equal(family('something-else'), 'unknown');
});

test('older Claude models: sampling and thinking budget, with validation', () => {
  const ok = build('claude-sonnet-4-5', { params: { reasoning_budget: 2048, max_output_tokens: 8000, top_k: 40 } });
  assert.deepEqual(ok.body.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(ok.body.top_k, 40);
  const bad = validateSettings('claude-sonnet-4-5', null, { params: { reasoning_budget: 512, temperature: 0.4 } });
  assert.ok(bad.some((i) => i.param === 'reasoning_budget' && i.level === 'error' && /1024/.test(i.message)));
  assert.ok(bad.some((i) => i.param === 'temperature' && i.level === 'error'));
  const range = validateSettings('claude-sonnet-4-5', null, { params: { temperature: 1.5 } });
  assert.ok(range.some((i) => i.param === 'temperature' && /at most 1/.test(i.message)));
  const both = validateSettings('claude-sonnet-4-5', null, { params: { temperature: 0.5, top_p: 0.9 } });
  assert.ok(both.some((i) => i.param === 'top_p' && i.level === 'warning'));
});

test('discovered output limits narrow the range', () => {
  const ctl = describeControls('claude-sonnet-4-5', { max_tokens: 64000 }).common.find((d) => d.id === 'max_output_tokens');
  assert.equal(ctl.max, 64000);
  const issues = validateSettings('claude-sonnet-4-5', { max_tokens: 64000 }, { params: { max_output_tokens: 90000, stream: true } });
  assert.ok(issues.some((i) => i.param === 'max_output_tokens' && i.level === 'error'));
});

test('Claude options and advanced JSON', () => {
  const req = build('claude-opus-5-5', { params: { thinking_display: 'summarized', inference_geo: 'us' }, extra: { output_config: { format: { type: 'json_schema', schema: {} } } } });
  assert.deepEqual(req.body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(req.body.inference_geo, 'us');
  assert.deepEqual(req.body.output_config, { format: { type: 'json_schema', schema: {} } });
  const merged = build('claude-opus-5-5', { params: { reasoning_effort: 'low' }, extra: { output_config: { format: { type: 'json_schema', schema: {} } } } });
  assert.deepEqual(merged.body.output_config, { effort: 'low', format: { type: 'json_schema', schema: {} } });
  const issues = validateSettings('claude-opus-5-5', null, { extra: { messages: [] } });
  assert.ok(issues.some((i) => i.param === '__extra' && i.level === 'error'));
  const old = describeControls('claude-sonnet-4-5').extras.find((e) => e.id === 'thinking_display');
  assert.equal(old.support, 'no');
});

test('two models keep entirely separate settings', () => {
  assert.deepEqual(effectiveParams('claude-sonnet-4-5', null, { params: { top_k: 40 } }).params, { top_k: 40 });
  assert.deepEqual(effectiveParams('claude-opus-5-5', null, { params: { reasoning_effort: 'low' } }).params, { reasoning_effort: 'low' });
});

test('parseError names the rejected setting', () => {
  const t = parseError('claude-sonnet-4-5', null, 400, '{"type":"error","error":{"type":"invalid_request_error","message":"temperature: range: 0..1"}}');
  assert.equal(t.param, 'temperature');
  assert.equal(t.message, 'temperature: range: 0..1');
  assert.equal(parseError('claude-sonnet-4-5', null, 400, '{"error":{"message":"thinking.budget_tokens: Input should be greater than or equal to 1024"}}').param, 'reasoning_budget');
  assert.equal(parseError('claude-opus-5-5', null, 400, '{"error":{"message":"output_config.effort: invalid value"}}').param, 'reasoning_effort');
  assert.equal(parseError('claude-opus-5-5', null, 400, '{"error":{"message":"max_tokens: 999999 > 128000"}}').param, 'max_output_tokens');
  assert.equal(parseError('claude-opus-5-5', null, 401, '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}').param, null);
});

test('reading replies, refusals and fallbacks', () => {
  const r = readMessage({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hi' }] });
  assert.equal(r.text, 'Hi');
  assert.equal(r.model, 'claude-opus-5-5');
  const fb = readMessage({ model: 'claude-opus-4-8', content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: 'ok' }] });
  assert.deepEqual(fb.fallback, { from: 'claude-opus-5-5', to: 'claude-opus-4-8' });
  const ref = readMessage({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
  assert.equal(ref.stopReason, 'refusal');
  assert.equal(readEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }).delta, 'x');
  assert.equal(readEvent({ type: 'message_start', message: { model: 'm' } }).model, 'm');
  assert.equal(readEvent({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }).stopReason, 'max_tokens');
  assert.ok(readEvent({ type: 'error', error: { message: 'overloaded' } }).error);
});

test('keys are hidden in anything shown', () => {
  const r = redactHeaders({ 'x-api-key': 'secret', 'content-type': 'application/json' });
  assert.ok(!Object.values(r).includes('secret'));
});
