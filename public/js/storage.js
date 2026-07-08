const KEYS = {
  favorites: 'cactus:favorites:v2',
  history: 'cactus:history:v2',
  settings: 'cactus:settings:v3',
  sourceHealth: 'cactus:source-health:v1',
};

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

const state = {
  favorites: read(KEYS.favorites, []),
  history: read(KEYS.history, []),
  settings: {
    recordHistory: true,
    preferNativeHls: true,
    resumePlayback: true,
    autoFailover: true,
    autoNext: true,
    ...read('cactus:settings:v2', {}),
    ...read(KEYS.settings, {}),
  },
  sourceHealth: read(KEYS.sourceHealth, {}),
};

let favoriteKeys = new Set(state.favorites.map(item => item.key));
let historyMap = new Map(state.history.map(item => [item.key, item]));
const pendingWrites = new Map();
let writeScheduled = false;

function flush() {
  writeScheduled = false;
  for (const [key, value] of pendingWrites) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch {}
  }
  pendingWrites.clear();
}

function scheduleWrite(key, value) {
  pendingWrites.set(key, value);
  if (writeScheduled) return;
  writeScheduled = true;
  if ('requestIdleCallback' in window) requestIdleCallback(flush, { timeout: 700 });
  else setTimeout(flush, 0);
}

function cloneList(list) { return list.map(item => ({ ...item })); }

function replaceFavorites(list) {
  state.favorites = Array.isArray(list) ? list.slice(0, 300) : [];
  favoriteKeys = new Set(state.favorites.map(item => item.key));
  scheduleWrite(KEYS.favorites, state.favorites);
}

function replaceHistory(list) {
  state.history = Array.isArray(list) ? list.slice(0, 200) : [];
  historyMap = new Map(state.history.map(item => [item.key, item]));
  scheduleWrite(KEYS.history, state.history);
}

function healthEntry(provider) {
  const id = String(provider || '').trim();
  if (!id) return null;
  return state.sourceHealth[id] || { successes: 0, failures: 0, lastSuccess: 0, lastFailure: 0 };
}

function saveHealth(provider, patch) {
  const id = String(provider || '').trim();
  if (!id) return;
  state.sourceHealth[id] = { ...healthEntry(id), ...patch };
  const entries = Object.entries(state.sourceHealth)
    .sort((a, b) => Math.max(b[1].lastSuccess || 0, b[1].lastFailure || 0) - Math.max(a[1].lastSuccess || 0, a[1].lastFailure || 0))
    .slice(0, 80);
  state.sourceHealth = Object.fromEntries(entries);
  scheduleWrite(KEYS.sourceHealth, state.sourceHealth);
}

export const store = {
  favorites() { return cloneList(state.favorites); },
  replaceFavorites,
  isFavorite(key) { return favoriteKeys.has(key); },
  setFavorite(item, enabled) {
    const next = state.favorites.filter(entry => entry.key !== item.key);
    if (enabled) next.unshift(item);
    replaceFavorites(next);
    return enabled;
  },
  toggleFavorite(item) { return this.setFavorite(item, !favoriteKeys.has(item.key)); },

  history() { return cloneList(state.history); },
  replaceHistory,
  upsertHistory(item) {
    if (!item?.key) return;
    const record = { ...(historyMap.get(item.key) || {}), ...item, watchedAt: Date.now() };
    const next = state.history.filter(entry => entry.key !== item.key);
    next.unshift(record);
    replaceHistory(next);
  },
  addHistory(item) { this.upsertHistory(item); },
  updateProgress(key, position, duration, url, extra = {}) {
    const existing = historyMap.get(key);
    if (!existing) return;
    this.upsertHistory({
      ...existing,
      position,
      duration,
      ...(url ? { url } : {}),
      ...extra,
    });
  },
  progress(key) {
    const entry = historyMap.get(key);
    return entry ? { ...entry } : null;
  },

  settings() { return { ...state.settings }; },
  saveSettings(settings) {
    state.settings = { ...state.settings, ...settings };
    scheduleWrite(KEYS.settings, state.settings);
  },

  recordSourceSuccess(provider) {
    const current = healthEntry(provider);
    if (!current) return;
    saveHealth(provider, {
      successes: Number(current.successes || 0) + 1,
      lastSuccess: Date.now(),
    });
  },
  recordSourceFailure(provider) {
    const current = healthEntry(provider);
    if (!current) return;
    saveHealth(provider, {
      failures: Number(current.failures || 0) + 1,
      lastFailure: Date.now(),
    });
  },
  sourceScore(provider) {
    const entry = healthEntry(provider);
    if (!entry) return 0;
    const successes = Number(entry.successes || 0);
    const failures = Number(entry.failures || 0);
    const recentSuccess = Date.now() - Number(entry.lastSuccess || 0) < 7 * 864e5 ? 2 : 0;
    const recentFailure = Date.now() - Number(entry.lastFailure || 0) < 24 * 36e5 ? 2 : 0;
    return successes * 2 - failures * 3 + recentSuccess - recentFailure;
  },

  flush,
};

window.addEventListener('pagehide', flush, { capture: true });
