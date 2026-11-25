// End-to-end: real Chromium, real Jarvis server, mock Anthropic API.
// Run: npm run test:e2e   (SHOT_DIR=/some/dir to save screenshots)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startStack, SPEECH_FAKES, GOOD_KEY } from './harness.mjs';

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

async function open({ viewport = { width: 1280, height: 860 }, reducedMotion = 'no-preference', deny = false, localSpeech = 'available', connect = true } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion, permissions: deny ? [] : ['microphone'] });
  await ctx.addInitScript((mode) => { window.__localSpeech = mode; }, localSpeech);
  await ctx.addInitScript(SPEECH_FAKES);
  await ctx.addInitScript(() => {
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__micRequests = 0;
    navigator.mediaDevices.getUserMedia = (c) => { window.__micRequests++; return window.__denyMic ? Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) : real(c); };
  });
  if (deny) await ctx.addInitScript(() => { window.__denyMic = true; });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|Unauthorized/.test(m.text())) errors.push(m.text()); });
  await page.goto(stack.appUrl);
  if (connect) await connectViaOnboarding(page, GOOD_KEY);
  return { page, ctx, errors };
}

async function connectViaOnboarding(page, key) {
  await page.fill('#onboard-key', key);
  await page.click('#onboarding button[type=submit]');
  await page.waitForSelector('#onboarding', { state: 'hidden' });
}

const orbState = (page) => page.getAttribute('#orb', 'data-state');
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const posts = () => stack.mock.received.filter((r) => r.method === 'POST');

async function typeAndSend(page, text) {
  if (await page.isHidden('#composer')) await page.click('#type');
  await page.fill('#composer-input', text);
  await page.keyboard.press('Enter');
}

async function replyCount(page, n) {
  await page.waitForFunction((k) => document.querySelectorAll('#log .msg.assistant[data-status="ok"]').length === k, n);
  return page.locator('#log .msg.assistant').last();
}

async function closeSettings(page) {
  if (await page.isVisible('#settings')) await page.click('#settings [data-close]');
  await page.waitForSelector('#settings:not([open])', { state: 'attached' });
}

async function setParam(page, model, id, value) {
  if (!(await page.isVisible('#settings'))) await page.click('#open-settings');
  await page.click('#tab-model');
  await page.selectOption('#settings-target', { label: `${model} — Claude` });
  const el = page.locator(`#ctl-${id}`);
  if ((await el.evaluate((n) => n.tagName)) === 'SELECT') await el.selectOption(String(value));
  else await el.fill(String(value));
}

async function addModel(page, model) {
  if (!(await page.isVisible('#settings'))) await page.click('#open-settings');
  await page.click('#tab-connections');
  await page.click(`.conn button:text-is("+ ${model}")`);
}

async function pick(page, modelText) {
  await closeSettings(page);
  await page.click('#model-chip');
  await page.locator(`#model-options label:has-text("${modelText}")`).first().click();
  await page.waitForSelector('#model-picker:not([open])', { state: 'attached' });
}

// ----------------------------------------------------------------------

test('first run: connect Claude, then one question at a time, suggestions, summary, memory consent', { skip }, async () => {
  const { page, ctx, errors } = await open({ connect: false });
  assert.ok(await page.isVisible('#onboarding'));
  assert.match(await page.textContent('#onboarding'), /Connect Claude to begin/);
  await shot(page, '01-first-run');
  await page.fill('#onboard-key', 'sk-ant-wrong');
  await page.click('#onboarding button[type=submit]');
  await page.waitForSelector('#onboarding .status-line.err');
  assert.match(await page.textContent('#onboarding .status-line'), /Anthropic rejected that key/);
  assert.equal(await page.evaluate(() => window.jarvis.state.connections.length), 0);
  await connectViaOnboarding(page, GOOD_KEY);
  assert.deepEqual(await page.evaluate(() => window.jarvis.state.connections[0].models), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);

  stack.mock.received.length = 0;
  await typeAndSend(page, 'I want to build a tool for my running club');
  await page.waitForFunction(() => document.querySelector('#orb').dataset.state === 'thinking');
  let reply = await replyCount(page, 1);
  const t1 = await reply.locator('.bubble').textContent();
  assert.match(t1, /running club/);
  assert.equal((t1.match(/\?/g) || []).length, 1, 'asks exactly one question');
  assert.match(await reply.locator('.meta').textContent(), /Answered by claude-.*Auto chose claude-/s);
  const chips = await page.locator('#suggestions .suggestion').allTextContents();
  assert.ok(chips.includes('My running club'), `suggestions grounded in what was said: ${chips}`);
  await page.click('#suggestions .suggestion:text-is("My running club")');
  await replyCount(page, 2);
  await page.locator('#suggestions .suggestion').first().click();
  reply = await replyCount(page, 3);
  const summary = await reply.locator('.bubble').textContent();
  assert.match(summary, /Your goal, in your words:.*build a tool for my running club/s);
  assert.match(summary, /Suggested next step:/);
  await shot(page, '02-summary');

  // Every request went to Claude's Messages API with the key.
  assert.ok(posts().length === 3 && posts().every((r) => r.path === '/v1/messages' && r.headers['x-api-key'] === GOOD_KEY));
  assert.ok(stack.relayed.every((r) => new URL(r.url).hostname === 'api.anthropic.com'));
  assert.match(posts()[0].body.system, /exactly ONE/);

  await typeAndSend(page, 'Keep it short please. Help me list those three things');
  await replyCount(page, 4);
  const card = page.locator('[data-testid="memory-card"]');
  await card.waitFor();
  assert.match(await card.textContent(), /Remember this across chats\?.*Prefers short, brief answers/s);
  assert.equal(await page.evaluate(() => window.jarvis.state.memories.length), 0, 'nothing stored before consent');
  await card.locator('button:text-is("Remember")').click();
  await typeAndSend(page, 'ok');
  await replyCount(page, 5);
  assert.match(posts().at(-1).body.system, /Prefers short, brief answers/, 'remembered after consent');
  await page.click('#open-settings');
  await page.click('#tab-memory');
  const input = page.locator('#panel-memory .mem[data-memory] input');
  await input.fill('Prefers very short answers');
  await input.press('Tab');
  assert.equal(await page.evaluate(() => window.jarvis.state.memories[0].text), 'Prefers very short answers');
  await page.click('#panel-memory .mem[data-memory] button:text-is("Delete")');
  assert.equal(await page.evaluate(() => window.jarvis.state.memories.length), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('voice on-device: live transcript, spoken reply, interruption, hands-free, end conversation', { skip }, async () => {
  const { page, ctx, errors } = await open();
  await page.evaluate(() => { window.__speakMs = 4000; });
  await page.click('#talk');
  await page.waitForFunction(() => document.querySelector('#orb').dataset.state === 'listening');
  assert.match(await page.textContent('#status'), /Listening/);
  assert.ok(await page.evaluate(() => !!window.jarvis.voice.stream), 'fake-device microphone stream feeds the meter');
  await page.waitForFunction(() => /I want to plan/.test(document.querySelector('#live-transcript').textContent));
  await shot(page, '03-listening');
  await page.waitForFunction(() => document.querySelector('#orb').dataset.state === 'speaking');
  assert.ok(await page.isVisible('#interrupt'));
  await shot(page, '04-speaking');
  const log1 = await page.evaluate(() => window.__speechLog);
  assert.ok(log1.find((e) => e.e === 'rec-start').processLocally, 'recognition asked to stay on-device');
  assert.equal(log1.find((e) => e.e === 'speak').voice, 'test-a', 'an on-device voice, never the online one');

  await page.click('#interrupt');
  assert.equal(await orbState(page), 'idle');
  assert.match(await page.textContent('#status'), /Interrupted/);
  assert.equal(await page.evaluate(() => window.speechSynthesis.speaking), false);

  await page.check('#handsfree');
  await page.evaluate(() => { window.__speakMs = 500; window.__heard = ['Mostly for my neighbours', '']; });
  const before = await page.evaluate(() => window.__speechLog.filter((e) => e.e === 'rec-start').length);
  await page.click('#orb-button');
  await page.waitForFunction((n) => window.__speechLog.filter((e) => e.e === 'rec-start').length >= n + 2, before, { timeout: 8000 });
  const log = await page.evaluate(() => window.__speechLog);
  assert.ok(log.filter((e) => e.e === 'speak').every((e) => !e.recActive), 'recogniser off whenever speech started');
  assert.ok(log.filter((e) => e.e === 'rec-start').every((e) => !e.speaking), 'recogniser never started during playback');

  await page.click('#end');
  assert.equal(await page.locator('#log .msg').count(), 0);
  assert.equal(await page.evaluate(() => window.jarvis.voice.stream), null, 'microphone released');
  assert.match(await page.textContent('#status'), /Conversation ended/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('voice privacy: no on-device recognition means no microphone until you allow the browser service', { skip }, async () => {
  const { page, ctx } = await open({ localSpeech: 'none' });
  await page.click('#talk');
  await page.waitForSelector('#voice-notice:not([hidden])');
  assert.match(await page.textContent('#voice-notice'), /sending your audio to its own online service, not Claude/);
  assert.equal(await page.evaluate(() => window.__micRequests), 0, 'microphone never opened');
  assert.ok(await page.isVisible('#composer'), 'typing offered instead');
  await shot(page, '05-voice-privacy');
  await page.click('#allow-cloud-speech');
  await page.waitForFunction(() => document.querySelector('#orb').dataset.state === 'listening');
  const start = await page.evaluate(() => window.__speechLog.find((e) => e.e === 'rec-start'));
  assert.equal(start.processLocally, false);
  assert.equal(await page.evaluate(() => window.jarvis.state.voiceSettings.allowCloud), true);
  await ctx.close();
});

test('blocked microphone: clear explanation and typing still works', { skip }, async () => {
  const { page, ctx } = await open({ deny: true });
  await page.click('#talk');
  await page.waitForSelector('#voice-notice:not([hidden])');
  assert.match(await page.textContent('#voice-notice'), /Microphone access is blocked/);
  assert.match(await page.textContent('#status'), /blocked/i);
  assert.ok(await page.isVisible('#composer'));
  assert.notEqual(await orbState(page), 'listening');
  await shot(page, '06-mic-blocked');
  await typeAndSend(page, 'I want to start a newsletter');
  await replyCount(page, 1);
  await ctx.close();
});

test('two Claude models with different settings each receive exactly their own; switching keeps the conversation', { skip }, async () => {
  const { page, ctx, errors } = await open();
  await addModel(page, 'claude-sonnet-4-5');
  await setParam(page, 'claude-opus-5-5', 'reasoning_effort', 'low');
  // Sampling controls are switched off for current models.
  assert.ok(await page.isDisabled('#ctl-temperature'));
  assert.equal(await page.getAttribute('#panel-model [data-param="temperature"]', 'data-support'), 'no');
  await setParam(page, 'claude-sonnet-4-5', 'top_k', 40);
  await setParam(page, 'claude-sonnet-4-5', 'max_output_tokens', 900);
  await setParam(page, 'claude-sonnet-4-5', 'stream', 'true');
  const preview = await page.textContent('#settings-preview');
  assert.match(preview, /"top_k": 40/);
  assert.match(preview, /"max_tokens": 900/);
  assert.doesNotMatch(preview, /effort|fallbacks/);
  assert.doesNotMatch(preview, new RegExp(GOOD_KEY));
  await shot(page, '07-settings-preview');

  stack.mock.received.length = 0;
  await pick(page, 'claude-opus-5-5');
  await typeAndSend(page, 'I have an idea for a recipe swap app');
  let reply = await replyCount(page, 1);
  assert.match(await reply.locator('.meta').textContent(), /Answered by claude-opus-5-5.*You picked this model/s);
  await pick(page, 'claude-sonnet-4-5');
  await typeAndSend(page, 'Mostly for my neighbours');
  reply = await replyCount(page, 2);
  assert.match(await reply.locator('.meta').textContent(), /Answered by claude-sonnet-4-5/);

  const [toOpus, toSonnet] = posts();
  assert.deepEqual(Object.keys(toOpus.body).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.deepEqual(toOpus.body.output_config, { effort: 'low' });
  assert.equal(toOpus.body.max_tokens, 16000);
  assert.equal(toOpus.body.fallbacks, 'default');
  assert.equal(toOpus.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.deepEqual(Object.keys(toSonnet.body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'system', 'top_k']);
  assert.equal(toSonnet.body.top_k, 40);
  assert.equal(toSonnet.body.max_tokens, 900);
  assert.equal(toSonnet.headers['anthropic-beta'], undefined);
  assert.deepEqual(toSonnet.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(toSonnet.body.messages[0].content, 'I have an idea for a recipe swap app');
  assert.doesNotMatch(toSonnet.body.messages[1].content, /<replies>/);

  await pick(page, 'Auto');
  stack.mock.received.length = 0;
  await typeAndSend(page, 'Help me plan the strategy and compare the trade-offs for launch');
  reply = await replyCount(page, 3);
  const meta = await reply.locator('.meta').textContent();
  assert.match(meta, /Auto chose claude-.* because this looked like a planning or reasoning question/);
  const autoReq = posts()[0];
  if (autoReq.body.model === 'claude-sonnet-4-5') assert.equal(autoReq.body.top_k, 40);
  if (autoReq.body.model === 'claude-opus-5-5') assert.deepEqual(autoReq.body.output_config, { effort: 'low' });
  assert.ok(stack.relayed.every((r) => !JSON.stringify(r).includes(GOOD_KEY)), 'relay log never holds the key');
  assert.deepEqual(errors, []);
  await shot(page, '08-model-switch');
  await ctx.close();
});

test('a rejected setting is named, fixable, and the message is not lost', { skip }, async () => {
  const { page, ctx } = await open();
  await addModel(page, 'claude-sonnet-4-5');
  await setParam(page, 'claude-sonnet-4-5', 'top_k', 20);
  await pick(page, 'claude-sonnet-4-5');
  stack.mock.rules.rejectParam = 'top_k';
  try {
    await typeAndSend(page, 'My idea is a shared tool library for our street');
    const card = page.locator('[data-testid="error-card"]');
    await card.waitFor();
    assert.equal(await card.getAttribute('data-param'), 'top_k');
    assert.match(await card.textContent(), /Claude rejected the request \(400\).*top_k.*Top-k/s);
    await shot(page, '09-rejected-setting');
    await card.locator('button:has-text("Fix Top-k")').click();
    await page.waitForSelector('#panel-model:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ctl-top_k');
    await page.click('#panel-model [data-param="top_k"] .reset');
    await closeSettings(page);
    await page.click('[data-testid="error-card"] button:text-is("Retry")');
    await replyCount(page, 1);
    assert.deepEqual(await page.locator('#log .msg.user .bubble').allTextContents(), ['My idea is a shared tool library for our street']);
    assert.equal(posts().at(-1).body.top_k, undefined);
  } finally {
    stack.mock.rules.rejectParam = null;
  }
  await ctx.close();
});

test('invalid combinations are caught before anything is sent', { skip }, async () => {
  const { page, ctx } = await open();
  await addModel(page, 'claude-sonnet-4-5');
  await setParam(page, 'claude-sonnet-4-5', 'reasoning_budget', 2048);
  await setParam(page, 'claude-sonnet-4-5', 'temperature', 0.5);
  assert.match(await page.textContent('#panel-model [data-param="temperature"] .issue'), /does not allow temperature changes while a reasoning budget is set/);
  await setParam(page, 'claude-sonnet-4-5', 'temperature', 1.7);
  assert.match(await page.textContent('#panel-model [data-param="temperature"] .issue'), /at most 1/);
  await pick(page, 'claude-sonnet-4-5');
  const before = stack.mock.received.length;
  await typeAndSend(page, 'I want to restore an old bike');
  const card = page.locator('[data-testid="error-card"]');
  await card.waitFor();
  assert.match(await card.textContent(), /can.t be sent these settings yet/);
  assert.equal(stack.mock.received.length, before, 'nothing reached Claude');
  await ctx.close();
});

test('refusals and server-side fallbacks are shown plainly', { skip }, async () => {
  const { page, ctx } = await open();
  await pick(page, 'claude-opus-5-5');
  await typeAndSend(page, 'REFUSE this one');
  let reply = await replyCount(page, 1);
  assert.match(await reply.locator('.bubble').textContent(), /Claude declined to continue with this request \(cyber\)/);
  await typeAndSend(page, 'FALLBACK please');
  reply = await replyCount(page, 2);
  const meta = await reply.locator('.meta').textContent();
  assert.match(meta, /Answered by claude-opus-4-8.*fallback from claude-opus-5-5/s);
  await ctx.close();
});

test('presets, Claude options, advanced JSON and restore defaults', { skip }, async () => {
  const { page, ctx } = await open();
  await setParam(page, 'claude-opus-5-5', 'reasoning_effort', 'xhigh');
  await setParam(page, 'claude-opus-5-5', 'inference_geo', 'us');
  await setParam(page, 'claude-opus-5-5', 'refusal_fallback', 'false');
  await page.fill('#advanced-json', '{ "output_config": { "format": { "type": "json_schema", "schema": { "type": "object" } } } }');
  await page.fill('#preset-name', 'Deep');
  await page.click('#save-preset');
  await page.click('#restore-defaults');
  let preview = await page.textContent('#settings-preview');
  assert.doesNotMatch(preview, /effort|inference_geo|json_schema/);
  assert.match(preview, /"fallbacks": "default"/, 'Jarvis default returns');
  await page.selectOption('#preset-select', { label: 'Deep' });
  await page.click('#panel-model button:text-is("Apply")');
  preview = await page.textContent('#settings-preview');
  assert.match(preview, /"effort": "xhigh"/);
  assert.match(preview, /"json_schema"/);
  assert.match(preview, /"inference_geo": "us"/);
  assert.doesNotMatch(preview, /fallbacks/);
  await page.fill('#advanced-json', '{ "x": tru');
  assert.match(await page.textContent('[data-param="__extra"] .issue'), /Not valid JSON yet/);
  await ctx.close();
});

test('motion: reduced-motion is respected and animations can be turned off', { skip }, async () => {
  const reduced = await open({ reducedMotion: 'reduce', connect: false });
  assert.equal(await reduced.page.getAttribute('#orb', 'data-motion'), 'off');
  await reduced.ctx.close();
  const { page, ctx } = await open({ connect: false });
  assert.equal(await page.getAttribute('#orb', 'data-motion'), 'on');
  await page.click('#open-settings');
  await page.click('#tab-general');
  await page.selectOption('#pref-motion', 'off');
  assert.equal(await page.getAttribute('#orb', 'data-motion'), 'off');
  await ctx.close();
});

test('mobile layout, keyboard access and voice settings', { skip }, async () => {
  const { page, ctx, errors } = await open({ viewport: { width: 375, height: 740 }, connect: false });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(await overflow(), 0);
  await shot(page, '10-mobile-first-run');
  await connectViaOnboarding(page, GOOD_KEY);
  await typeAndSend(page, 'I want to learn to bake bread');
  await replyCount(page, 1);
  assert.equal(await overflow(), 0);
  await shot(page, '11-mobile-chat');
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
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#settings'), false);
  await page.click('#open-settings');
  await page.click('#tab-voice');
  const options = await page.locator('#voice-select option').allTextContents();
  assert.ok(!options.some((o) => /Online Voice/.test(o)), 'online voices hidden while speech stays on-device');
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

test('streaming and the stop button', { skip }, async () => {
  const { page, ctx } = await open();
  await setParam(page, 'claude-haiku-5-5', 'stream', 'true');
  await pick(page, 'claude-haiku-5-5');
  await typeAndSend(page, 'I want a better way to track my plants');
  const reply = await replyCount(page, 1);
  assert.match(await reply.locator('.bubble').textContent(), /track my plants.*\?$/s);
  assert.equal(posts().at(-1).body.max_tokens, 64000, 'streaming default output limit');
  await typeAndSend(page, 'SLOW and another idea');
  await page.waitForSelector('#stop-thinking:not([hidden])');
  await page.click('#stop-thinking');
  const card = page.locator('[data-testid="error-card"]');
  await card.waitFor();
  assert.match(await card.textContent(), /Stopped/);
  assert.equal(await page.locator('#log .msg.user .bubble:text-is("SLOW and another idea")').count(), 1);
  await ctx.close();
});

test('the relay refuses every host except Claude', { skip }, async () => {
  for (const url of ['https://api.openai.com/v1/chat/completions', 'https://generativelanguage.googleapis.com/v1beta/models', 'http://localhost:11434/api/chat', 'https://example.com/']) {
    const r = await fetch(`${stack.appUrl}/proxy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-proxy': '1' }, body: JSON.stringify({ url, method: 'POST', headers: {}, body: {} }) });
    assert.equal(r.status, 599, url);
    assert.match((await r.json()).message, /only talks to Claude/);
  }
  const noHeader = await fetch(`${stack.appUrl}/proxy`, { method: 'POST', body: '{}' });
  assert.equal(noHeader.status, 403, 'other web pages cannot use the relay');
  const health = await (await fetch(`${stack.appUrl}/health`)).json();
  assert.equal(health.app, 'jarvis');
});
