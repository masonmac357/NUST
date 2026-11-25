// The shared catalog of generation controls. Each provider decides which of
// these a given model supports, with what range, and how it is spelled on the
// wire (see providers.js). Every control starts at "Provider default", which
// means it is left out of the request entirely.

export const PARAMS = {
  temperature: {
    label: 'Temperature',
    type: 'number', min: 0, max: 2, step: 0.05,
    desc: 'Higher values make replies more varied; lower values make them more focused and repeatable.',
  },
  top_p: {
    label: 'Top-p',
    type: 'number', min: 0, max: 1, step: 0.01,
    desc: 'Limits each word choice to the most likely candidates whose probabilities add up to this share.',
  },
  top_k: {
    label: 'Top-k',
    type: 'integer', min: 1, max: 1000, step: 1,
    desc: 'Limits each word choice to this many of the most likely candidates.',
  },
  max_output_tokens: {
    label: 'Output token limit',
    type: 'integer', min: 1, max: 1000000, step: 1,
    desc: 'The most tokens the model may write in one reply; long answers are cut off at this point.',
  },
  stop: {
    label: 'Stop sequences',
    type: 'list', maxItems: 16,
    desc: 'The reply ends as soon as the model writes any of these strings (one per line).',
  },
  seed: {
    label: 'Seed',
    type: 'integer', min: 0, max: 2147483647, step: 1,
    desc: 'Asks the model to give the same output for the same input and settings, on a best-effort basis.',
  },
  frequency_penalty: {
    label: 'Frequency penalty',
    type: 'number', min: -2, max: 2, step: 0.1,
    desc: 'Discourages repeating a word more strongly the more often it has already appeared.',
  },
  presence_penalty: {
    label: 'Presence penalty',
    type: 'number', min: -2, max: 2, step: 0.1,
    desc: 'Nudges the model toward new topics by discouraging any word that has already appeared.',
  },
  reasoning_effort: {
    label: 'Reasoning effort',
    type: 'enum', options: ['low', 'medium', 'high'],
    desc: 'How hard the model thinks before answering; more effort is slower but can be more careful.',
  },
  reasoning_budget: {
    label: 'Reasoning budget',
    type: 'integer', min: 0, max: 200000, step: 256,
    desc: 'The most tokens the model may spend thinking before it starts its answer.',
  },
  response_format: {
    label: 'Response format',
    type: 'enum', options: ['text', 'json_object'],
    desc: 'Ask for ordinary text or for a single valid JSON object.',
  },
  stream: {
    label: 'Streaming',
    type: 'boolean',
    desc: 'Show the reply as it is written instead of waiting for the whole answer.',
  },
};

export const COMMON_PARAM_IDS = Object.keys(PARAMS);

// Normalise a raw form value into the param's type. Returns undefined for
// "empty" (which means: go back to provider default).
export function coerce(def, raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  switch (def.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : NaN;
    }
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
    case 'enum':
    case 'string':
    default:
      return String(raw);
  }
}

// Check one value against its (possibly provider-narrowed) definition.
export function checkValue(def, value) {
  if (value === undefined) return null;
  if (def.type === 'number' || def.type === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) return `${def.label} must be a number.`;
    if (def.type === 'integer' && !Number.isInteger(value)) return `${def.label} must be a whole number.`;
    if (def.min !== undefined && value < def.min) return `${def.label} must be at least ${def.min}.`;
    if (def.max !== undefined && value > def.max) return `${def.label} must be at most ${def.max}.`;
  }
  if (def.type === 'enum' && def.options && !def.options.includes(value)) {
    return `${def.label} must be one of: ${def.options.join(', ')}.`;
  }
  if (def.type === 'list') {
    if (!Array.isArray(value)) return `${def.label} must be a list.`;
    if (def.maxItems && value.length > def.maxItems) return `${def.label} allows at most ${def.maxItems} entries here.`;
  }
  if (def.type === 'boolean' && typeof value !== 'boolean') return `${def.label} must be on or off.`;
  return null;
}
