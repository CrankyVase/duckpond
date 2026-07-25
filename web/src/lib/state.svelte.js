import { api } from './api.js';
import { adoptServerTheme } from './theme.svelte.js';

export const app = $state({
  user: null,
  setupNeeded: false,
  authChecked: false,
  models: [],
  conversations: [],
  conv: null,            // active conversation incl. messages[] (tree) + settings
  streaming: null,       // { convId, text, thinking, tokS, n, loading, error }
  context: { used: 0, budget: 32768 },
  gpu: null,             // { totalBytes, usedBytes }
  view: 'chat',          // 'chat' | 'stats' | 'speech' | 'files' | 'providers' | 'costs'
  modelPickerOpen: false,
  settingsOpen: false,
  themeStudioOpen: false,
  // Start collapsed on narrow screens so chat is usable; desktop keeps it open.
  sidebarCollapsed: (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches),
  compacting: false,
  filesVersion: 0,       // bumped when the agent writes files → chat file rail refreshes
});

/** Close the sidebar on mobile after navigating (drawer pattern). */
export function closeSidebarIfMobile() {
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
    app.sidebarCollapsed = true;
  }
}

export async function checkAuth() {
  try {
    app.user = await api('/api/auth/me');
    adoptServerTheme(app.user?.ui_theme); // server copy wins — synced across devices + Duck Pond Control
  } catch {
    app.user = null;
    const s = await api('/api/auth/setup-needed').catch(() => ({ setupNeeded: false }));
    app.setupNeeded = s.setupNeeded;
  }
  app.authChecked = true;
}

export async function loadModels() {
  try { app.models = await api('/api/models'); } catch { /* router down */ }
}

export async function loadConversations() {
  app.conversations = await api('/api/conversations');
}

export async function openConversation(id) {
  app.conv = await api(`/api/conversations/${id}`);
  app.context = { used: 0, budget: app.conv.settings?.ctx_size ?? 32768 };
  refreshContext();
}

export async function refreshContext() {
  if (!app.conv?.id) return;
  try {
    const c = await api(`/api/conversations/${app.conv.id}/context`);
    app.context = c;
  } catch { /* non-fatal */ }
}

export async function newConversation() {
  const lastModel = app.user?.default_model_id
    ?? app.conv?.model_id ?? app.conversations[0]?.model_id
    ?? app.models.find((m) => m.status === 'loaded')?.id ?? app.models[0]?.id ?? null;
  const conv = await api('/api/conversations', { method: 'POST', body: { model_id: lastModel } });
  await loadConversations();
  await openConversation(conv.id);
}

// Summarize older turns into a compaction node (server does the heavy lifting).
export async function compactNow(keep = 8) {
  if (!app.conv || app.compacting) return null;
  app.compacting = true;
  const convId = app.conv.id;
  try {
    const r = await api(`/api/conversations/${convId}/compact`, { method: 'POST', body: { keep } });
    if (app.conv?.id === convId) {
      await openConversation(convId);
      if (r.used != null) app.context = { used: r.used, budget: r.budget };
    }
    return r;
  } finally {
    app.compacting = false;
  }
}

export async function pollStatus() {
  try { app.gpu = await api('/api/gpu'); } catch { /* ignore */ }
  await loadModels();
}

// --- message tree helpers (messages array -> visible path + sibling info) ---

export function childrenMap(messages) {
  const map = new Map();
  for (const m of messages) {
    const key = m.parent_id ?? 0;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return map;
}

export function visiblePath(messages, leafId) {
  if (!messages?.length) return [];
  const byId = new Map(messages.map((m) => [m.id, m]));
  const path = [];
  const seen = new Set(); // guard: bad data must never freeze the tab
  let cur = leafId ? byId.get(leafId) : null;
  if (!cur) {
    // fall back to deepest last message
    cur = messages[messages.length - 1];
  }
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : null;
  }
  return path.reverse();
}

// deepest descendant following the most recent child at each level
export function deepestLeaf(messages, fromId) {
  const map = childrenMap(messages);
  const seen = new Set();
  let id = fromId;
  while (!seen.has(id)) {
    seen.add(id);
    const kids = map.get(id);
    if (!kids?.length) break;
    id = kids[kids.length - 1].id;
  }
  return id;
}
