// End-to-end: real Chromium, real Jarvis server, mock providers.
// Run: npm run test:e2e   (SHOT_DIR=/some/dir to save screenshots)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startStack, SPEECH_FAKES } from './harness.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }

const SHOTS = process.env.SHOT_DIR;
let stack;
let browser;

before(async () => {
  if (!chromium) return;
  stack = await startStack();
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
});
after(async () => { await browser?.close(); await stack?.stop(); });

const skip = !chromium && 'playwright is not installed';

async function open({ viewport = { width: 1280, height: 860 }, permissions = ['microphone'], reducedMotion = 'no-preference', fakes = true, deny = false } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion, permissions: deny ? [] : permissions });
  if (fakes) await ctx.addInitScript(SPEECH_FAKES);
  if (deny) {
    // A real permission denial, the way a browser reports a blocked microphone.
    await ctx.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(stack.appUrl);
  return { page, ctx, errors };
}

const orbState = (page) => page.getAttribute('#orb', 'data-state');
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); };

async function typeAndSend(page, text) {
  if (await page.isHidden('#composer')) await page.click('#type');
  await page.fill('#composer-input', text);
  await page.keyboard.press('Enter');
}

async function lastReply(page) {
  await page.waitForFunction(() => {
    const items = [...document.querySelectorAll('#log .msg')];
    const last = items[items.length - 1];
    return last && last.dataset.role === 'assistant' && last.dataset.status === 'ok';
  });
  return page.locator('#log .msg.assistant').last();
}

async function addConnection(page, { provider, name, base, key, models }) {
  if (!(await page.isVisible('#settings'))) await page.click('#open-settings');
  await page.click('#tab-connections');
  await page.selectOption('#new-provider', provider);
  await page.fill('#new-name', name);
  await page.fill('#new-base', base);
  await page.fill('#new-key', key);
  await page.click('#add-connection button[type=submit]');
  const card = page.locator(`.conn[data-conn]:has(strong:text-is("${name}"))`);
  await card.locator('.status-line.ok').waitFor();
  for (const m of models) await card.locator(`button:text-is("+ ${m}")`).click();
}

async function setParam(page, label, id, value) {
  if (!(await page.isVisible('#settings'))) await page.click('#open-settings');
  await page.click('#tab-model');
  await page.selectOption('#settings-target', { label });
  const el = page.locator(`#ctl-${id}`);
  if ((await el.evaluate((n) => n.tagName)) === 'SELECT') await el.selectOption(String(value));
  else await el.fill(String(value));
}

async function closeSettings(page) {
  if (await page.isVisible('#settings')) await page.click('#settings [data-close]');
  await page.waitForSelector('#settings:not([open])', { state: 'attached' });
}

async function pick(page, modelText) {
  await closeSettings(page);
  await page.click('#model-chip');
  await page.locator(`#model-options label:has-text("${modelText}")`).first().click();
  await page.waitForSelector('#model-picker:not([open])', { state: 'attached' });
}

// ----------------------------------------------------------------------

test('first conversation: typed, one question at a time, suggestions, summary, memory consent', { skip }, async () => {
  const { page, ctx, errors } = await open();
  assert.equal(await orbState(page), 'idle');
  assert.match(await page.textContent('#status'), /Ready/);
  assert.ok(await page.isVisible('#talk'));
  assert.ok(await page.isVisible('#type'));
  await shot(page, '01-first-open');

  await typeAndSend(page, 'I want to build a tool for my running club');
  // Waiting state is visible while the reply is on its way.
  await page.waitForFunction(() => document.querySelector('#orb').dataset.state === 'thinking');
  let reply = await lastReply(page);
  const t1 = await reply.locator('.bubble').textContent();
  assert.match(t1, /running club/);
  assert.equal((t1.match(/\?/g) || []).length, 1, 'asks exactly one question');
  assert.match(await reply.locator('.meta').textContent(), /Answered by jarvis-demo.*simulated.*Auto chose it because/s);
  const chips = await page.locator('#suggestions .suggestion').allTextContents();
  assert.ok(chips.includes('My running club'), `suggestions grounded in what was said: ${chips}`);

  await page.click('#suggestions .suggestion:text-is("My running club")');
  reply = await lastReply(page);
  await page.waitForFunction(() => document.querySelectorAll('#log .msg.assistant').length === 2);
  await page.locator('#suggestions .suggestion').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#log .msg.assistant').length === 3);
  reply = await lastReply(page);
  const summary = await reply.locator('.bubble').textContent();
  assert.match(summary, /Your goal, in your words:.*build a tool for my running club/s);
  assert.match(summary, /Suggested next step:/);
  await shot(page, '02-summary');

  // Memory: Jarvis asks before remembering anything.
  await typeAndSend(page, 'Keep it short please. Help me list those three things');
  await lastReply(page);
  const card = page.locator('[data-testid="memory-card"]');
  await card.waitFor();
  assert.match(await card.textContent(), /Remember this across chats\?.*Prefers short, brief answers/s);
  assert.equal(await page.evaluate(() => window.jarvis.state.memories.length), 0, 'nothing stored before consent');
  await card.locator('button:text-is("Remember")').click();
  assert.equal(await page.evaluate(() => window.jarvis.state.memories.length), 1);

  // Edit and delete it in Settings > Memory.
  await page.click('#open-settings');
  await page.click('#tab-memory');
  const input = page.locator('#panel-memory .mem[data-memory] input');
  await input.fill('Prefers very short answers');
  await input.press('Tab');
  assert.equal(await page.evaluate(() => window.jarvis.state.memories[0].text), 'Prefers very short answers');
  await page.click('#panel-memory .mem[data-memory] button:text-is("Delete")');
  assert.equal(await page.evaluate(() => window.jarvis.state.memories.length), 0);
  await page.keyboard.press('Escape');

  // Remembered preferences go to the model only after consent: none now.
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('voice: live transcript, spoken reply, one-tap interruption, hands-free, end conversation', { skip }, async () => {
  const { page, ctx, errors } = await open();
  await page.evaluate(() => { window.__speakMs = 4000; });
  await page.click('#talk');
  await page.waitForFunction(() => document.querySelector('#orb').dataset.state === 'listening');
  assert.match(await page.textContent('#status'), /Listening/);
  // Real (fake-device) microphone stream feeds the level meter.
  assert.ok(await page.evaluate(() => !!window.jarvis.voice.stream));
  await page.waitForFunction(() => /I want to plan/.test(document.querySelector('#live-transcript').textContent));
  await shot(page, '03-listening');
  await page.waitForFunction(() => document.querySelector('#orb').dataset.state === 'speaking');
  assert.match(await page.textContent('#status'), /Speaking/);
  assert.ok(await page.isVisible('#interrupt'));
  await shot(page, '04-speaking');
  const userText = await page.locator('#log .msg.user .bubble').first().textContent();
  assert.equal(userText, 'I want to plan a community garden');

  // One tap interrupts; the speaking animation ends with playback.
  await page.click('#interrupt');
  assert.equal(await orbState(page), 'idle');
  assert.match(await page.textContent('#status'), /Interrupted/);
  assert.equal(await page.evaluate(() => window.speechSynthesis.speaking), false);

  // Hands-free: after Jarvis finishes speaking it listens again by itself.
  await page.check('#handsfree');
  await page.evaluate(() => { window.__speakMs = 500; window.__heard = ['Mostly for my neighbours', '']; });
  const startsBefore = await page.evaluate(() => window.__speechLog.filter((e) => e.e === 'rec-start').length);
  await page.click('#orb-button');
  await page.waitForFunction((n) => window.__speechLog.filter((e) => e.e === 'rec-start').length >= n + 2, startsBefore, { timeout: 8000 });
  // Jarvis never listens while it is speaking.
  const log = await page.evaluate(() => window.__speechLog);
  assert.ok(log.filter((e) => e.e === 'speak').every((e) => !e.recActive), 'recogniser was off whenever speech started');
  assert.ok(log.filter((e) => e.e === 'rec-start').every((e) => !e.speaking), 'recogniser never started during playback');

  await page.click('#end');
  assert.equal(await page.locator('#log .msg').count(), 0);
  assert.equal(await orbState(page), 'idle');
  assert.equal(await page.evaluate(() => window.jarvis.voice.stream), null, 'microphone released');
  assert.match(await page.textContent('#status'), /Conversation ended/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('blocked microphone: clear explanation and typing still works', { skip }, async () => {
  const { page, ctx } = await open({ deny: true });
  await page.click('#talk');
  await page.waitForSelector('#voice-notice:not([hidden])');
  assert.match(await page.textContent('#voice-notice'), /Microphone access is blocked/);
  assert.match(await page.textContent('#status'), /blocked/i);
  assert.ok(await page.isVisible('#composer'), 'falls back to typing');
  assert.notEqual(await orbState(page), 'listening');
  await shot(page, '05-mic-blocked');
  await typeAndSend(page, 'I want to start a newsletter');
  await lastReply(page);
  await ctx.close();
});

test('two models with different settings each receive exactly their own; switching keeps the conversation', { skip }, async () => {
  const { page, ctx, errors } = await open();
  await addConnection(page, { provider: 'openai', name: 'Mock OpenAI', base: `${stack.mockUrl}/v1`, key: 'sk-openai-test', models: ['gpt-4.1-mini'] });
  // Discovery filtered out a non-chat model.
  assert.equal(await page.locator('.conn:has(strong:text-is("Mock OpenAI")) button:text-is("+ text-embedding-3-small")').count(), 0);
  await addConnection(page, { provider: 'anthropic', name: 'Mock Anthropic', base: `${stack.mockUrl}/v1`, key: 'sk-ant-test', models: ['claude-sonnet-4-5'] });

  await setParam(page, 'gpt-4.1-mini — Mock OpenAI', 'temperature', 0.3);
  await setParam(page, 'gpt-4.1-mini — Mock OpenAI', 'seed', 42);
  await setParam(page, 'claude-sonnet-4-5 — Mock Anthropic', 'top_k', 40);
  await setParam(page, 'claude-sonnet-4-5 — Mock Anthropic', 'max_output_tokens', 900);
  await setParam(page, 'claude-sonnet-4-5 — Mock Anthropic', 'stream', 'true');
  // The preview shows exactly what the next request would carry.
  const preview = await page.textContent('#settings-preview');
  assert.match(preview, /"top_k": 40/);
  assert.match(preview, /"max_tokens": 900/);
  assert.doesNotMatch(preview, /temperature|seed/);
  assert.doesNotMatch(preview, /sk-ant-test/, 'keys never shown');
  await shot(page, '06-settings-preview');
  await page.keyboard.press('Escape');

  stack.mock.received.length = 0;
  await pick(page, 'gpt-4.1-mini');
  assert.equal(await page.textContent('#model-chip-name'), 'gpt-4.1-mini');
  await typeAndSend(page, 'I have an idea for a recipe swap app');
  let reply = await lastReply(page);
  assert.match(await reply.locator('.meta').textContent(), /Answered by gpt-4\.1-mini via Mock OpenAI.*You picked this model/s);

  await pick(page, 'claude-sonnet-4-5');
  await typeAndSend(page, 'Mostly for my neighbours');
  await page.waitForFunction(() => document.querySelectorAll('#log .msg.assistant[data-status="ok"]').length === 2);
  reply = page.locator('#log .msg.assistant').last();
  assert.match(await reply.locator('.meta').textContent(), /Answered by claude-sonnet-4-5 via Mock Anthropic/);

  const chats = stack.mock.received.filter((r) => r.method === 'POST');
  assert.equal(chats.length, 2);
  const [toOpenAI, toAnthropic] = chats;
  assert.equal(toOpenAI.path, '/v1/chat/completions');
  assert.deepEqual(Object.keys(toOpenAI.body).sort(), ['messages', 'model', 'seed', 'temperature']);
  assert.equal(toOpenAI.body.temperature, 0.3);
  assert.equal(toOpenAI.body.seed, 42);
  assert.equal(toOpenAI.headers.authorization, 'Bearer sk-openai-test');

  assert.equal(toAnthropic.path, '/v1/messages');
  assert.deepEqual(Object.keys(toAnthropic.body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'system', 'top_k']);
  assert.equal(toAnthropic.body.top_k, 40);
  assert.equal(toAnthropic.body.max_tokens, 900);
  assert.equal(toAnthropic.headers['x-api-key'], 'sk-ant-test');
  assert.equal(toAnthropic.headers.authorization, undefined, 'OpenAI key not leaked to Anthropic');
  // The conversation survived the switch: Claude saw the earlier turns.
  assert.deepEqual(toAnthropic.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(toAnthropic.body.messages[0].content, 'I have an idea for a recipe swap app');
  assert.match(toAnthropic.body.messages[1].content, /Mock reply from gpt-4\.1-mini/);
  assert.doesNotMatch(toAnthropic.body.messages[1].content, /<replies>/, 'markup stripped from history');

  // Auto: whichever model it picks, it uses that model's own settings and says why.
  await pick(page, 'Auto');
  stack.mock.received.length = 0;
  await typeAndSend(page, 'Help me plan the strategy and compare the trade-offs for launch');
  await page.waitForFunction(() => document.querySelectorAll('#log .msg.assistant[data-status="ok"]').length === 3);
  const meta = await page.locator('#log .msg.assistant').last().locator('.meta').textContent();
  assert.match(meta, /Auto chose it because this looked like a planning or reasoning question/);
  const autoReq = stack.mock.received.find((r) => r.method === 'POST');
  if (autoReq.path === '/v1/messages') assert.equal(autoReq.body.top_k, 40);
  else assert.equal(autoReq.body.temperature, 0.3);
  assert.doesNotMatch(meta, /jarvis-demo/, 'Auto skips the simulated model once real ones exist');

  // The relay saw the same requests, with keys hidden in its log.
  assert.ok(stack.relayed.every((r) => !JSON.stringify(r).includes('sk-openai-test') && !JSON.stringify(r).includes('sk-ant-test')));
  assert.deepEqual(errors, []);
  await shot(page, '07-model-switch');
  await ctx.close();
});

test('a rejected setting is named, fixable, and the message is not lost', { skip }, async () => {
  const { page, ctx } = await open();
  await addConnection(page, { provider: 'openai', name: 'Strict OpenAI', base: `${stack.mockUrl}/v1`, key: 'sk-x', models: ['gpt-4.1-mini'] });
  await setParam(page, 'gpt-4.1-mini — Strict OpenAI', 'presence_penalty', 0.5);
  await page.keyboard.press('Escape');
  await pick(page, 'gpt-4.1-mini');
  stack.mock.rules.rejectParam = 'presence_penalty';
  try {
    await typeAndSend(page, 'My idea is a shared tool library for our street');
    const card = page.locator('[data-testid="error-card"]');
    await card.waitFor();
    assert.equal(await card.getAttribute('data-param'), 'presence_penalty');
    assert.match(await card.textContent(), /OpenAI rejected the request \(400\).*presence_penalty.*Presence penalty/s);
    await shot(page, '08-rejected-setting');
    await card.locator('button:has-text("Fix Presence penalty")').click();
    await page.waitForSelector('#panel-model:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ctl-presence_penalty');
    await page.click('[data-param="presence_penalty"] .reset');
    await page.keyboard.press('Escape');
    await page.click('[data-testid="error-card"] button:text-is("Retry")');
    await lastReply(page);
    const users = await page.locator('#log .msg.user .bubble').allTextContents();
    assert.deepEqual(users, ['My idea is a shared tool library for our street'], 'kept once, not duplicated');
    const posts = stack.mock.received.filter((r) => r.method === 'POST' && r.path === '/v1/chat/completions');
    assert.equal(posts.at(-1).body.presence_penalty, undefined);
  } finally {
    stack.mock.rules.rejectParam = null;
  }
  await ctx.close();
});

test('invalid combinations are caught before anything is sent', { skip }, async () => {
  const { page, ctx } = await open();
  await addConnection(page, { provider: 'anthropic', name: 'Claude Mock', base: `${stack.mockUrl}/v1`, key: 'k', models: ['claude-sonnet-4-5'] });
  await setParam(page, 'claude-sonnet-4-5 — Claude Mock', 'reasoning_budget', 2048);
  await setParam(page, 'claude-sonnet-4-5 — Claude Mock', 'temperature', 0.5);
  const issue = await page.textContent('[data-param="temperature"] .issue');
  assert.match(issue, /does not allow temperature changes while a reasoning budget is set/);
  assert.match(await page.textContent('#settings-issues'), /problem/);
  await setParam(page, 'claude-sonnet-4-5 — Claude Mock', 'temperature', 1.7);
  assert.match(await page.textContent('[data-param="temperature"] .issue'), /at most 1/);
  await page.keyboard.press('Escape');
  await pick(page, 'claude-sonnet-4-5');
  const before = stack.mock.received.length;
  await typeAndSend(page, 'I want to restore an old bike');
  const card = page.locator('[data-testid="error-card"]');
  await card.waitFor();
  assert.match(await card.textContent(), /can.t be sent these settings yet/);
  assert.equal(stack.mock.received.length, before, 'nothing reached the provider');
  // Current Claude models disable sampling controls entirely.
  await page.click('#open-settings');
  await addConnection(page, { provider: 'anthropic', name: 'Claude Now', base: `${stack.mockUrl}/v1`, key: 'k', models: ['claude-opus-5-5'] });
  await page.click('#tab-model');
  await page.selectOption('#settings-target', { label: 'claude-opus-5-5 — Claude Now' });
  assert.equal(await page.getAttribute('#panel-model [data-param="temperature"]', 'data-support'), 'no');
  assert.ok(await page.isDisabled('#ctl-temperature'));
  assert.equal(await page.getAttribute('#panel-model [data-param="reasoning_effort"]', 'data-support'), 'yes');
  await ctx.close();
});

test('presets, provider-specific options, advanced JSON and restore defaults', { skip }, async () => {
  const { page, ctx } = await open();
  await addConnection(page, { provider: 'openai', name: 'P OpenAI', base: `${stack.mockUrl}/v1`, key: 'k', models: ['gpt-4.1-mini'] });
  const label = 'gpt-4.1-mini — P OpenAI';
  await setParam(page, label, 'temperature', 1.1);
  await setParam(page, label, 'service_tier', 'flex');
  await page.fill('#advanced-json', '{ "logprobs": true }');
  await page.fill('#preset-name', 'Brainstorm');
  await page.click('#save-preset');
  await page.click('#restore-defaults');
  const preview = await page.textContent('#settings-preview');
  assert.doesNotMatch(preview, /temperature|service_tier|logprobs/);
  assert.match(await page.textContent('[data-param="temperature"] .state'), /Provider default/);
  await page.selectOption('#preset-select', { label: 'Brainstorm' });
  await page.click('#panel-model button:text-is("Apply")');
  const after = await page.textContent('#settings-preview');
  assert.match(after, /"temperature": 1\.1/);
  assert.match(after, /"service_tier": "flex"/);
  assert.match(after, /"logprobs": true/);
  await page.fill('#advanced-json', '{ "logprobs": tru');
  assert.match(await page.textContent('[data-param="__extra"] .issue'), /Not valid JSON yet/);
  await ctx.close();
});

test('motion: reduced-motion is respected and animations can be turned off', { skip }, async () => {
  const reduced = await open({ reducedMotion: 'reduce' });
  assert.equal(await reduced.page.getAttribute('#orb', 'data-motion'), 'off');
  await reduced.ctx.close();
  const { page, ctx } = await open();
  assert.equal(await page.getAttribute('#orb', 'data-motion'), 'on');
  await page.click('#open-settings');
  await page.click('#tab-general');
  await page.selectOption('#pref-motion', 'off');
  assert.equal(await page.getAttribute('#orb', 'data-motion'), 'off');
  await ctx.close();
});

test('mobile layout and keyboard access', { skip }, async () => {
  const { page, ctx, errors } = await open({ viewport: { width: 375, height: 740 } });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow, 0, 'no horizontal scroll at phone width');
  await shot(page, '09-mobile');
  await typeAndSend(page, 'I want to learn to bake bread');
  await lastReply(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
  await shot(page, '10-mobile-chat');

  // Keyboard: Tab reaches the primary actions; settings tabs move with arrows.
  await page.reload();
  const order = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement.id || document.activeElement.textContent.trim().slice(0, 20)));
  }
  assert.ok(order.includes('talk') && order.includes('type') && order.includes('open-settings'), order.join(','));
  await page.focus('#open-settings');
  await page.keyboard.press('Enter');
  await page.focus('#tab-connections');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'tab-model');
  assert.ok(await page.isVisible('#panel-model'));
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#settings'), false);
  // Voice settings: choose a voice and speed; Jarvis uses them.
  await page.click('#open-settings');
  await page.click('#tab-voice');
  await page.selectOption('#voice-lang', 'en-GB');
  await page.selectOption('#voice-select', 'test-b');
  await page.locator('#voice-rate').fill('1.5');
  await page.click('#panel-voice button:text-is("Test voice")');
  const spoke = await page.evaluate(() => window.__speechLog.filter((e) => e.e === 'speak').at(-1));
  assert.equal(spoke.voice, 'test-b');
  assert.equal(spoke.rate, 1.5);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('streaming replies and the stop button', { skip }, async () => {
  const { page, ctx } = await open();
  await addConnection(page, { provider: 'openai', name: 'S OpenAI', base: `${stack.mockUrl}/v1`, key: 'k', models: ['gpt-4.1-mini'] });
  await setParam(page, 'gpt-4.1-mini — S OpenAI', 'stream', 'true');
  await page.keyboard.press('Escape');
  await pick(page, 'gpt-4.1-mini');
  await typeAndSend(page, 'I want a better way to track my plants');
  const reply = await lastReply(page);
  assert.match(await reply.locator('.bubble').textContent(), /^Mock reply from gpt-4\.1-mini\. What matters most to you here\?$/);
  assert.deepEqual(await page.locator('#suggestions .suggestion').allTextContents(), ['Speed', 'Cost']);
  // Stop: switch to the slow simulated demo and stop it mid-reply.
  await pick(page, 'jarvis-demo');
  await typeAndSend(page, 'And another idea');
  await page.waitForSelector('#stop-thinking:not([hidden])');
  await page.click('#stop-thinking');
  const card = page.locator('[data-testid="error-card"]');
  await card.waitFor();
  assert.match(await card.textContent(), /Stopped/);
  assert.equal(await page.locator('#log .msg.user .bubble:text-is("And another idea")').count(), 1);
  await ctx.close();
});
