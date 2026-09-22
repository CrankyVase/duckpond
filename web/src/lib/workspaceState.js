// Browser-local workspace state, partitioned by account and conversation.
// Never persist file attachments or credentials here.
export function workspaceState(storage, userId) {
  const key = `dp_workspace_v1:${userId}`;
  let data;
  const read = () => {
    try { data = JSON.parse(storage.getItem(key) || '{}'); } catch { data = {}; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  };
  const save = () => { try { storage.setItem(key, JSON.stringify(data)); } catch { /* quota/private mode */ } };
  return {
    draft(id) { read(); return typeof data[`draft:${id}`] === 'string' ? data[`draft:${id}`] : ''; },
    saveDraft(id, value) { read(); if (value) data[`draft:${id}`] = value; else delete data[`draft:${id}`]; save(); },
    selected(mode) { read(); return data[`selected:${mode}`] ?? null; },
    select(mode, id) { read(); data[`selected:${mode}`] = id; save(); },
  };
}
