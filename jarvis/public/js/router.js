// Auto: pick one of your Claude models for each message, from what the
// message looks like and your stated priority. A transparent heuristic; the
// reason it returns is shown next to the reply.

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

export function profileModel(model) {
  const m = String(model).toLowerCase();
  const p = { quality: 2, speed: 2, code: 3 };
  if (/(opus|fable|mythos)/.test(m)) { p.quality = 4; p.speed = 1; p.code = 4; }
  else if (/sonnet/.test(m)) { p.quality = 3; p.speed = 2.5; p.code = 4; }
  else if (/haiku/.test(m)) { p.quality = 2; p.speed = 4; p.code = 2; }
  // Newer generations edge out older ones of the same tier.
  const gen = m.match(/-(\d)(?:-(\d))?(?:-|$)/);
  if (gen) p.quality += (Number(gen[1]) + Number(gen[2] || 0) / 10) / 20;
  return p;
}

const PRIORITY = {
  balanced: { quality: 1, speed: 1 },
  speed: { quality: 0.5, speed: 2.5 },
  quality: { quality: 2.5, speed: 0.3 },
};

// candidates: [{ key, model, ... }]; prefs: { priority }
export function chooseModel(candidates, text, prefs = {}, ctx = {}) {
  if (!candidates.length) return null;
  const task = classifyTask(text, ctx);
  const want = TASKS[task].want;
  const pri = PRIORITY[prefs.priority] || PRIORITY.balanced;
  const ranked = candidates.map((c) => {
    const p = profileModel(c.model);
    let score = (want.quality || 0) * p.quality * pri.quality + (want.speed || 0) * p.speed * pri.speed + (want.code || 0) * p.code;
    score += p.quality * pri.quality + p.speed * pri.speed * 0.5;
    return { ...c, score, profile: p };
  }).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  return { choice: best, task, ranked, reason: explain(best, task, prefs, ranked.length) };
}

function explain(best, task, prefs, count) {
  if (count === 1) return 'it is the only Claude model you have turned on';
  const p = best.profile;
  const strengths = [];
  if (task === 'code' && p.code >= 4) strengths.push('strong at code');
  if (p.quality >= 3 && (task === 'reasoning' || task === 'creative' || prefs.priority === 'quality')) strengths.push('one of your most capable models');
  if (p.speed >= 4 && (task === 'quick' || prefs.priority === 'speed')) strengths.push('your fastest model');
  const pri = prefs.priority && prefs.priority !== 'balanced' ? `, with your priority set to ${prefs.priority}` : '';
  return `this looked like ${TASKS[task].label}${pri}, and it is ${strengths.length ? strengths.join(' and ') : 'the best overall fit among your models'}`;
}

export { TASKS };
