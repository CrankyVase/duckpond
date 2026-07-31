// Tiny toast queue. toast('Saved') / toast('No connection', 'error')
export const toasts = $state([]);

let seq = 0;

export function toast(text, kind = 'info', ms = 2600) {
  const id = ++seq;
  toasts.push({ id, text, kind });
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i >= 0) toasts.splice(i, 1);
}
