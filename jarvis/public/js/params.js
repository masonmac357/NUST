// The catalog of Claude generation controls. Which ones a given Claude model
// accepts, and with what range, is decided in providers.js. Every control
// starts at its default, which means it is left out of the request.

export const PARAMS = {
  temperature: {
    label: 'Temperature',
    type: 'number', min: 0, max: 1, step: 0.05,
    desc: 'Higher values make replies more varied; lower values make them more focused and repeatable.',
  },
  top_p: {
    label: 'Top-p',
    type: 'number', min: 0, max: 1, step: 0.01,
    desc: 'Limits each word choice to the most likely candidates whose probabilities add up to this share.',
  },
  top_k: {
    label: 'Top-k',
    type: 'integer', min: 1, max: 500, step: 1,
    desc: 'Limits each word choice to this many of the most likely candidates.',
  },
  max_output_tokens: {
    label: 'Output token limit',
    type: 'integer', min: 1, max: 128000, step: 1,
    desc: 'The most tokens Claude may write in one reply; long answers are cut off at this point.',
  },
  stop: {
    label: 'Stop sequences',
    type: 'list', maxItems: 16,
    desc: 'The reply ends as soon as Claude writes any of these strings (one per line).',
  },
  reasoning_effort: {
    label: 'Reasoning effort',
    type: 'enum', options: ['low', 'medium', 'high'],
    desc: 'How hard Claude thinks before answering; more effort is slower and costs more but can be more careful.',
  },
  reasoning_budget: {
    label: 'Reasoning budget',
    type: 'integer', min: 1024, max: 128000, step: 256,
    desc: 'The most tokens an older Claude model may spend thinking before it starts its answer.',
  },
  stream: {
    label: 'Streaming',
    type: 'boolean',
    desc: 'Show the reply as it is written instead of waiting for the whole answer.',
  },
};

// Normalise a raw form value. Returns undefined for "empty" (= default).
export function coerce(def, raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  switch (def.type) {
    case 'number':
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : NaN;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      return raw === 'true' ? true : raw === 'false' ? false : undefined;
    case 'list': {
      const items = Array.isArray(raw) ? raw : String(raw).split('\n');
      const clean = items.map((s) => String(s)).filter((s) => s.length > 0);
      return clean.length ? clean : undefined;
    }
    default:
      return String(raw);
  }
}

export function checkValue(def, value) {
  if (value === undefined) return null;
  if (def.type === 'number' || def.type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) return `${def.label} must be a number.`;
    if (def.type === 'integer' && !Number.isInteger(value)) return `${def.label} must be a whole number.`;
    if (def.min !== undefined && value < def.min) return `${def.label} must be at least ${def.min}.`;
    if (def.max !== undefined && value > def.max) return `${def.label} must be at most ${def.max}.`;
  }
  if (def.type === 'enum' && def.options && !def.options.includes(value)) return `${def.label} must be one of: ${def.options.join(', ')}.`;
  if (def.type === 'list') {
    if (!Array.isArray(value)) return `${def.label} must be a list.`;
    if (def.maxItems && value.length > def.maxItems) return `${def.label} allows at most ${def.maxItems} entries here.`;
  }
  if (def.type === 'boolean' && typeof value !== 'boolean') return `${def.label} must be on or off.`;
  return null;
}
