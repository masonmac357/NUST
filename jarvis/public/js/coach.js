// How Jarvis talks: the system prompt that makes any connected model ask one
// useful question at a time, plus the parser for the small markup it emits
// (suggested replies and memory requests).

export function systemPrompt({ memories = [], voice = false } = {}) {
  const lines = [
    'You are Jarvis, a warm, sharp thinking partner who helps people turn rough ideas into something concrete.',
    '',
    'How to help:',
    '- While the idea is still fuzzy, ask exactly ONE short, useful question per reply. Build on the person’s own words; do not ask several things at once.',
    '- After a question, end your reply with 2 to 4 short optional answers the person might give, written from their point of view and grounded in what they actually said, on the final line in exactly this format:',
    '  <replies>["first option", "second option", "third option"]</replies>',
    '- Once you understand the goal, who or what it is for, and at least one constraint, stop asking. Reply with a line starting "**Your goal, in your words:**" that reuses their phrasing, then a line starting "**Suggested next step:**" with one concrete action they could take today. You may still offer <replies> such as ways to continue.',
    '- If the person asks a direct question, answer it plainly first.',
    '- Keep replies short and conversational. Avoid long lists unless asked.',
    '- If the person states a lasting preference about how you should work with them (for example "keep answers short" or "I’m a teacher"), add on its own line: <remember>the preference, in a few words</remember>. Never do this for one-off details. The app will ask the person before saving it.',
  ];
  if (voice) lines.push('- This reply will be read aloud. Do not use markdown tables, code blocks or headings.');
  if (memories.length) {
    lines.push('', 'Things this person asked you to remember about them:');
    for (const m of memories) lines.push(`- ${m.text}`);
  }
  return lines.join('\n');
}

// Pull <replies> and <remember> out of a model reply.
export function parseReply(raw = '') {
  let text = String(raw);
  let replies = [];
  const remember = [];
  const rm = text.match(/<replies>([\s\S]*?)<\/replies>/i);
  if (rm) {
    try {
      const arr = JSON.parse(rm[1].trim());
      if (Array.isArray(arr)) replies = arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
    } catch {
      replies = rm[1].split(/\n|\|/).map((s) => s.replace(/^[-*\d.\s"]+|"$/g, '').trim()).filter(Boolean).slice(0, 4);
    }
    text = text.replace(rm[0], '');
  }
  text = text.replace(/<remember>([\s\S]*?)<\/remember>/gi, (_, m) => {
    const s = m.trim();
    if (s) remember.push(s);
    return '';
  });
  // Hide half-written tags while streaming.
  text = text.replace(/<(replies|remember)>[\s\S]*$/i, '');
  return { text: text.trim(), replies, remember };
}

// Plain text for speech: no markdown symbols.
export function speakable(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
