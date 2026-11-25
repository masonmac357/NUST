// Auto: pick one of the connected models for each message, based on what the
// message looks like and the person's stated priority. Everything here is a
// transparent heuristic, and the reason it returns is shown next to the reply.

const TASKS = {
  code: { label: 'a coding question', want: { code: 3, quality: 1 } },
  reasoning: { label: 'a planning or reasoning question', want: { quality: 3 } },
  creative: { label: 'a writing task', want: { quality: 2, speed: 0.5 } },
  quick: { label: 'a quick reply', want: { speed: 3 } },
  general: { label: 'an open conversation', want: { quality: 1, speed: 1 } },
};

export function classifyTask(text = '', { voice = false, turn = 0 } = {}) {
  const t = text.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (/```|\b(function|class|bug|stack trace|error:|compile|regex|sql|python|javascript|typescript|api endpoint|refactor|code)\b/.test(t)) return 'code';
  if (/\b(plan|strategy|compare|trade-?offs?|why|analy[sz]e|decide|pros and cons|roadmap|break (it|this) down|step[- ]by[- ]step)\b/.test(t) || words > 80) return 'reasoning';
  if (/\b(write|draft|story|poem|name ideas|slogan|tagline|rewrite|email)\b/.test(t)) return 'creative';
  if (words <= 6 && turn > 0) return 'quick';
  if (voice && words <= 14) return 'quick';
  return 'general';
}

export function profileModel(model, { local = false, demo = false } = {}) {
  const m = model.toLowerCase();
  const p = { quality: 2, speed: 2, code: 1, local, demo };
  if (/(opus|fable|mythos|gpt-5(?![\w.-]*(mini|nano))|\bo3\b|o3-pro|\bo1\b|-pro\b|pro-|405b|235b|120b|70b|72b|large|deepseek-r1|ultra|gemini-[\d.]+-pro)/.test(m)) { p.quality = 4; p.speed = 1; }
  if (/(sonnet|gpt-4\.1(?!-mini|-nano)|gpt-4o(?!-mini)|32b|27b|medium)/.test(m)) { p.quality = 3; p.speed = 2; }
  if (/(mini|nano|flash|haiku|lite|instant|small|tiny|\b[1-9]b\b|:[1-9]b|-[1-9]b|turbo)/.test(m)) { p.speed = 4; p.quality = Math.min(p.quality, 2); }
  if (/(coder|codestral|devstral|code)/.test(m)) p.code = 4;
  else if (/(claude|gpt-5|gpt-4\.1|sonnet|opus|qwen3|deepseek)/.test(m)) p.code = 3;
  if (local) p.speed += 0.5;
  if (demo) { p.quality = 0; p.speed = 3; p.code = 0; }
  return p;
}

const PRIORITY = {
  balanced: { quality: 1, speed: 1 },
  speed: { quality: 0.5, speed: 2.5 },
  quality: { quality: 2.5, speed: 0.3 },
};

// candidates: [{ connId, connName, providerId, model, local, demo }]
// prefs: { priority, preferLocal }
export function chooseModel(candidates, text, prefs = {}, ctx = {}) {
  if (!candidates.length) return null;
  const task = classifyTask(text, ctx);
  const want = TASKS[task].want;
  const pri = PRIORITY[prefs.priority] || PRIORITY.balanced;
  const realExists = candidates.some((c) => !c.demo);
  const ranked = candidates.map((c) => {
    const p = profileModel(c.model, c);
    let score = 0;
    score += (want.quality || 0) * p.quality * pri.quality;
    score += (want.speed || 0) * p.speed * pri.speed;
    score += (want.code || 0) * p.code;
    score += p.quality * pri.quality + p.speed * pri.speed * 0.5;
    if (prefs.preferLocal && c.local && !c.demo) score += 12;
    if (c.demo && realExists) score -= 100;
    return { ...c, score, profile: p };
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  return { choice: best, task, ranked, reason: explain(best, task, prefs, ranked.length) };
}

function explain(best, task, prefs, count) {
  if (count === 1) return 'it is the only model you have connected';
  const strengths = [];
  const p = best.profile;
  if (task === 'code' && p.code >= 3) strengths.push('strong at code');
  if (p.quality >= 3 && (task === 'reasoning' || task === 'creative' || prefs.priority === 'quality')) strengths.push('one of your most capable models');
  if (p.speed >= 4 && (task === 'quick' || prefs.priority === 'speed')) strengths.push('one of your fastest models');
  if (prefs.preferLocal && best.local && !best.demo) strengths.push('runs locally, as you prefer');
  const pri = prefs.priority && prefs.priority !== 'balanced' ? `, with your priority set to ${prefs.priority}` : '';
  const why = strengths.length ? strengths.join(' and ') : 'the best overall fit among your models';
  return `this looked like ${TASKS[task].label}${pri}, and it is ${why}`;
}

export { TASKS };
