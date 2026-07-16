// Promise-based in-app confirm — replaces window.confirm.
// Usage: if (!(await confirmDialog({ title, message, confirmLabel, danger }))) return;

/** @type {{ open: boolean, title: string, message: string, confirmLabel: string, cancelLabel: string, danger: boolean, resolve: ((v: boolean) => void) | null }} */
export const confirmState = $state({
  open: false,
  title: 'Are you sure?',
  message: '',
  confirmLabel: 'Yes',
  cancelLabel: 'No',
  danger: false,
  resolve: null,
});

/**
 * @param {string | { title?: string, message?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts = {}) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  return new Promise((resolve) => {
    // If a dialog is already open, reject the previous waiter as cancel
    if (confirmState.resolve) confirmState.resolve(false);
    confirmState.title = o.title ?? 'Are you sure?';
    confirmState.message = o.message ?? '';
    confirmState.confirmLabel = o.confirmLabel ?? 'Yes';
    confirmState.cancelLabel = o.cancelLabel ?? 'No';
    confirmState.danger = !!o.danger;
    confirmState.resolve = resolve;
    confirmState.open = true;
  });
}

export function answerConfirm(yes) {
  const r = confirmState.resolve;
  confirmState.open = false;
  confirmState.resolve = null;
  r?.(!!yes);
}
