// Keep live activity and saved run history consistent, including older runs
// that predate structured tool outcomes.
export const TERMINAL_RUN_STATUSES = new Set(['done', 'final', 'error', 'stopped', 'aborted', 'steplimit', 'max_steps']);

export function toolOutcome(event) {
  const result = String(event?.result ?? '').trimStart();
  if (event?.cancelled || /^exit[^\n]*\(CANCELLED\)/i.test(result)) return 'cancelled';
  if (event?.timedOut || /^exit[^\n]*\(TIMED OUT\)/i.test(result)) return 'error';
  if (['success', 'error', 'denied', 'blocked', 'cancelled'].includes(event?.outcome)) return event.outcome;
  if (/^DENIED:/i.test(result)) return 'denied';
  if (/^BLOCKED:/i.test(result)) return 'blocked';
  if (event?.success === false || /^(ERROR:|unknown tool:|exit (?!0(?:\s|$)))/i.test(result)) return 'error';
  return 'success';
}

export const toolHasIssue = event => toolOutcome(event) !== 'success';
export const commandHasIssue = event => !!event?.cancelled || !!event?.timedOut || (event?.exitCode != null && event.exitCode !== 0);

export function runStatusLabel(status) {
  return ({ done: 'Complete', final: 'Complete', error: 'Ended with an error', stopped: 'Stopped', aborted: 'Stopped', steplimit: 'Step limit reached', max_steps: 'Step limit reached', running: 'In progress', waiting_approval: 'Needs approval' })[status] ?? status?.replaceAll('_', ' ') ?? 'Loading';
}

export function activityDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
