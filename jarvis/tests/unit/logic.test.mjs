import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, chooseModel } from '../../public/js/router.js';
import { parseReply, systemPrompt, speakable } from '../../public/js/coach.js';
import { demoReply, topicOf } from '../e2e/scripted-claude.mjs';
import { PARAMS, coerce, checkValue } from '../../public/js/params.js';

const cands = [
  { key: 'o', model: 'claude-opus-5-5' },
  { key: 's', model: 'claude-sonnet-5-5' },
  { key: 'h', model: 'claude-haiku-5-5' },
];

test('task classification', () => {
  assert.equal(classifyTask('Why does this python function throw a TypeError?'), 'code');
  assert.equal(classifyTask('Help me plan a roadmap and compare the trade-offs'), 'reasoning');
  assert.equal(classifyTask('write a tagline for my bakery'), 'creative');
  assert.equal(classifyTask('yes', { turn: 2 }), 'quick');
});

test('Auto picks among Claude models by task and priority, and explains why', () => {
  const plan = chooseModel(cands, 'Help me plan the strategy for launching this', { priority: 'quality' });
  assert.equal(plan.choice.key, 'o');
  assert.match(plan.reason, /planning or reasoning.*most capable/);
  const quick = chooseModel(cands, 'ok sure', { priority: 'speed' }, { turn: 3 });
  assert.equal(quick.choice.key, 'h');
  assert.match(quick.reason, /fastest/);
  const code = chooseModel(cands, 'fix this regex bug in my code', {});
  assert.ok(['o', 's'].includes(code.choice.key));
  const only = chooseModel([cands[1]], 'hi', {});
  assert.match(only.reason, /only Claude model/);
});

test('reply markup is parsed out of the visible text', () => {
  const r = parseReply('Who is it for?\n<replies>["Me", "My team"]</replies>\n<remember>Prefers short answers</remember>');
  assert.equal(r.text, 'Who is it for?');
  assert.deepEqual(r.replies, ['Me', 'My team']);
  assert.deepEqual(r.remember, ['Prefers short answers']);
  assert.equal(parseReply('Partial <repl').text, 'Partial <repl');
  assert.equal(parseReply('Streaming <replies>["a",').text, 'Streaming');
});

test('system prompt asks one question at a time and carries memories', () => {
  const p = systemPrompt({ memories: [{ text: 'Is a nurse' }], voice: true });
  assert.match(p, /exactly ONE/);
  assert.match(p, /Is a nurse/);
  assert.match(p, /read aloud/);
  assert.equal(speakable('**Your goal:** do `x`'), 'Your goal: do x');
});

test('the scripted test double follows the question-then-summary flow, grounded in the user’s words', () => {
  const m = [{ role: 'user', content: 'I want to build a tool for my running club' }];
  const r1 = parseReply(demoReply(m));
  assert.match(r1.text, /tool for my running club/);
  assert.match(r1.text, /\?/);
  assert.ok(r1.replies.includes('My running club'));
  m.push({ role: 'assistant', content: r1.text }, { role: 'user', content: 'My running club' });
  const r2 = parseReply(demoReply(m));
  assert.equal((r2.text.match(/\?/g) || []).length, 1, 'exactly one question');
  m.push({ role: 'assistant', content: r2.text }, { role: 'user', content: 'People actually show up to the Sunday runs' });
  const r3 = parseReply(demoReply(m));
  assert.match(r3.text, /Your goal, in your words:.*build a tool for my running club/);
  assert.match(r3.text, /Suggested next step:/);
  const pref = parseReply(demoReply([{ role: 'user', content: 'Keep it short please, I want to start a podcast' }]));
  assert.deepEqual(pref.remember, ['Prefers short, brief answers']);
  assert.equal(topicOf('So, I want to make a garden planner.'), 'a garden planner');
});

test('param coercion and checks', () => {
  assert.equal(coerce(PARAMS.temperature, ''), undefined);
  assert.equal(coerce(PARAMS.temperature, '0.4'), 0.4);
  assert.ok(Number.isNaN(coerce(PARAMS.top_k, 'abc')));
  assert.deepEqual(coerce(PARAMS.stop, 'a\n\nb'), ['a', 'b']);
  assert.equal(coerce(PARAMS.stream, 'false'), false);
  assert.match(checkValue(PARAMS.top_k, 1.5), /whole number/);
  assert.equal(checkValue(PARAMS.top_p, 0.5), null);
});
