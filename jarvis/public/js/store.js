// Small localStorage wrapper. Everything lives in this browser only.

const PREFIX = 'jarvis.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? structuredClone(fallback) : JSON.parse(raw);
  } catch {
    return structuredClone(fallback);
  }
}

export function save(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch { return false; }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const settingsKey = (connId, model) => `${connId}::${model}`;
