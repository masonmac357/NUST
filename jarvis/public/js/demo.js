// Jarvis Demo: a scripted, in-browser stand-in for a real model, so a first
// visit works without any account. It follows the same reply format a real
// model is asked to use (one question, <replies>, then a summary). It is
// labelled "simulated" everywhere it appears.

const FILLER = /^(so|um+|uh+|well|okay|ok|hey jarvis|jarvis|hi|hello)[,.!\s]+/i;
const LEAD = /^(i('ve| have) (got )?(an|this|a) idea (for|about|to)|i('m| am) thinking (of|about)|i want to|i'd like to|i would like to|i wanna|maybe|what if (i|we)|help me|i need to|my idea is( to)?|i'm trying to|i am trying to)\s+/i;

function clean(s) {
  return String(s).trim().replace(FILLER, '').replace(/[.!?]+$/, '').trim();
}

export function topicOf(text) {
  let t = clean(text);
  for (let i = 0; i < 3; i++) t = t.replace(LEAD, '').trim();
  t = t.replace(/^(build|make|create|start|launch|write|design|set up|put together|come up with)\s+/i, '');
  const words = t.split(/\s+/);
  return (words.length > 12 ? words.slice(0, 12).join(' ') + '…' : t) || 'this idea';
}

function preference(text) {
  const t = text.toLowerCase();
  const short = t.match(/\b(keep (it|things|answers|replies|responses) (short|brief|concise)|i prefer (short|brief) (answers|replies))\b/);
  if (short) return 'Prefers short, brief answers';
  const role = text.match(/\bI(?:'m| am) an? ([A-Za-z][A-Za-z -]{2,30}?)(?:[,.!]|\s+(?:and|who|so|but)\b|$)/);
  if (role && !/\b(idea|bit|little|lot|way)\b/i.test(role[1])) return `Works as ${/^[aeiou]/i.test(role[1]) ? 'an' : 'a'} ${role[1].trim()}`;
  return null;
}

function pick(list, temperature, salt) {
  if (!temperature || temperature < 0.5) return list[0];
  return list[(salt + Math.round(temperature * 10)) % list.length];
}

export function demoReply(messages, { temperature } = {}) {
  const users = messages.filter((m) => m.role === 'user').map((m) => m.content);
  const n = users.length;
  const last = users[n - 1] || '';
  const first = users[0] || '';
  const topic = topicOf(first);
  const pref = preference(last);
  const remember = pref ? `\n<remember>${pref}</remember>` : '';
  const rep = (arr) => `\n<replies>${JSON.stringify(arr)}</replies>`;

  if (/^(start over|reset|new idea)\b/i.test(clean(last))) {
    return 'Fresh start. What’s the rough idea on your mind?' + rep(['A side project', 'Something for work', 'I’m not sure yet']);
  }

  if (n === 1) {
    const open = pick([`“${topic}” — I like where this is going.`, `Okay, “${topic}.” Let’s shape it.`, `Interesting: “${topic}.”`], temperature, n);
    const forWhom = first.match(/\bfor (my|our|the|a|an) ([\w' -]{2,40}?)(?=[,.!?]|\s+(?:so|that|to|who|which|and)\b|$)/i);
    const owner = forWhom && (forWhom[1].toLowerCase() === 'my' || forWhom[1].toLowerCase() === 'our') ? forWhom[1][0].toUpperCase() + forWhom[1].slice(1).toLowerCase() : 'The';
    const audience = forWhom ? `${owner} ${forWhom[2].trim()}` : 'Other people like me';
    return `${open} Who is this mainly for?` + rep([audience, 'Mostly for me', 'I’m not sure yet']) + remember;
  }
  if (n === 2) {
    return `Got it: ${clean(last).toLowerCase()}. A month from now, what would make this feel worth it?` +
      rep(['I actually use it every week', 'Someone else finds it useful', 'I learned something building it']) + remember;
  }
  if (n === 3) {
    const who = clean(users[1]);
    const why = clean(users[2]);
    return [
      `**Your goal, in your words:** ${clean(first)} — for ${who.toLowerCase()}, so that ${why.charAt(0).toLowerCase() + why.slice(1)}.`,
      `**Suggested next step:** Spend 20 minutes listing the three smallest things ${topic.toLowerCase()} has to do, then sketch the first one on paper.`,
    ].join('\n\n') + rep(['Help me list those three things', 'Let’s adjust the goal', 'Start over']) + remember;
  }
  return `Let’s keep going with “${topicOf(last)}.” What’s the one part you feel least sure about?` +
    rep(['How to start', 'Whether it’s worth it', 'How long it will take']) + remember;
}

export async function* demoStream(text, { signal, maxTokens, delay = 18 } = {}) {
  const parts = text.match(/\S+\s*/g) || [];
  const limit = maxTokens ? Math.max(1, Math.floor(maxTokens)) : Infinity;
  let i = 0;
  for (const p of parts) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (i++ >= limit) break;
    // Never cut through the markup the app parses.
    yield p;
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
}
