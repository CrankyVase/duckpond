import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const byteLimit = (value, fallback) => Number.isFinite(Number(value))
  ? Math.min(2 * 1024 * 1024, Math.max(0, Math.floor(Number(value)))) : fallback;
const headText = buffer => new StringDecoder('utf8').write(buffer);
function tailText(buffer) {
  let start = 0;
  // A retained tail may begin in the middle of one UTF-8 character.
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString('utf8');
}
function shortened(head, tail, totalBytes) {
  const first = headText(head), last = tailText(tail);
  const omitted = totalBytes - Buffer.byteLength(first) - Buffer.byteLength(last);
  return `${first}\n[... ${Math.max(0, omitted)} bytes truncated ...]\n${last}`;
}

export function truncateOutput(input, headBytes = 6000, tailBytes = 6000) {
  const text = String(input ?? '');
  const bytes = Buffer.from(text);
  const head = byteLimit(headBytes, 6000), tail = byteLimit(tailBytes, 6000);
  if (bytes.length <= head + tail) return { text, truncated: false };
  return { text: shortened(bytes.subarray(0, head), tail ? bytes.subarray(-tail) : Buffer.alloc(0), bytes.length), truncated: true };
}

// Consume all child output while retaining a fixed byte budget. A verbose
// command must not hit execFile.maxBuffer and leave its container job running.
export function createBoundedOutput({ headBytes = 16384, tailBytes = 16384 } = {}) {
  const headLimit = byteLimit(headBytes, 16384), tailLimit = byteLimit(tailBytes, 16384);
  let head = Buffer.alloc(0), tail = Buffer.alloc(0), totalBytes = 0;
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += bytes.length;
      if (head.length < headLimit) head = Buffer.concat([head, bytes.subarray(0, headLimit - head.length)]);
      if (tailLimit) tail = bytes.length >= tailLimit
        ? Buffer.from(bytes.subarray(-tailLimit))
        : Buffer.concat([tail, bytes]).subarray(-tailLimit);
    },
    snapshot() {
      const truncated = totalBytes > headLimit + tailLimit;
      const text = truncated ? shortened(head, tail, totalBytes)
        : Buffer.concat([head, tail.subarray(Math.max(0, head.length + tail.length - totalBytes))]).toString('utf8');
      return { text, truncated, totalBytes, retainedBytes: Math.min(totalBytes, headLimit + tailLimit) };
    },
  };
}

export function commandOptions(command, { timeoutSec = 60, cwd = '/workspace' } = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('Command required');
  if (Buffer.byteLength(command) > 1024 * 1024) throw new Error('Command exceeds 1 MB; use file tools for large content');
  const seconds = Number(timeoutSec);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 900) throw new Error('Command timeout must be from 1 through 900 seconds');
  if (typeof cwd !== 'string' || cwd.includes('\0') || cwd.length > 4096) throw new Error('Working directory must be a project path');
  const directory = posix.resolve('/workspace', cwd || '.');
  if (directory !== '/workspace' && !directory.startsWith('/workspace/')) throw new Error('Working directory escapes the project');
  return { command, timeoutSec: Math.ceil(seconds), cwd: directory };
}

export function containerCommandArgs(name, command, options, nonce) {
  const { timeoutSec, cwd } = commandOptions(command, options);
  if (!/^[a-f0-9-]{16,80}$/i.test(nonce)) throw new Error('Invalid command receipt');
  const pidFile = `/tmp/duckpond-command-${nonce}.pid`;
  // setsid isolates this job from preview servers and other commands. The
  // wrapper records its timeout parent's process group, then removes it on
  // exit. Pass the user's command as an argument, never shell interpolation.
  const wrapper = 'trap \'rm -f -- "$2"\' EXIT; printf \'%s\\n\' "$PPID" > "$2"; bash -lc \'cd -- "$1" || exit; eval -- "$2"\' duckpond-shell "$3" "$1"';
  return {
    pidFile,
    args: ['exec', '-w', cwd, name, 'setsid', '--wait', 'timeout', '-k', '5', `${timeoutSec}s`, 'bash', '-c', wrapper, 'duckpond-command', command, pidFile, cwd],
  };
}

export function cancellationArgs(name, pidFile) {
  if (!/^\/tmp\/duckpond-command-[a-f0-9-]{16,80}\.pid$/i.test(pidFile)) throw new Error('Invalid command receipt path');
  const script = [
    'for attempt in {1..20}; do test -s "$1" && break; sleep 0.1; done',
    'if ! test -s "$1"; then exit 3; fi',
    'read -r pid < "$1" || exit 1',
    'case "$pid" in *[!0-9]*|"") exit 1;; esac',
    'test "$pid" -gt 1 || exit 1',
    'kill -TERM -- -"$pid" 2>/dev/null || true',
    'sleep 0.3',
    'kill -KILL -- -"$pid" 2>/dev/null || true',
    'for attempt in {1..20}; do kill -0 -- -"$pid" 2>/dev/null || break; sleep 0.05; done',
    // kill -0 alone cannot distinguish permission denied from a missing group.
    'groups=$(ps -eo pgid=) || exit 5',
    'for group in $groups; do test "$group" = "$pid" && exit 4; done',
    'rm -f -- "$1"',
  ].join('; ');
  return ['exec', name, 'bash', '-c', script, 'duckpond-cancel', pidFile];
}

// Injectable transport: source tests can supply an inert EventEmitter child;
// importing this module does not start a process or open the application DB.
export function runSandboxCommand(args, { timeoutMs, signal, cancel, spawnProcess = spawn } = {}) {
  if (signal?.aborted) return Promise.resolve({ code: 130, cancelled: true, timedOut: false, cleanupConfirmed: true, cleanupError: null, forcedTransportStop: false, stdout: '', stderr: '', truncated: false, outputBytes: 0 });
  return new Promise(resolve => {
    const stdout = createBoundedOutput(), stderr = createBoundedOutput();
    let child, finished = false, closed = false, closeCode = 1, stopping = false, cleanupDone = false;
    let cancelled = false, timedOut = false, timer, cleanupTimer, killTimer;
    let cleanupConfirmed = null, cleanupError = null, forcedTransportStop = false;
    const finish = () => {
      if (finished || !closed || (stopping && !cleanupDone)) return;
      finished = true;
      clearTimeout(timer); clearTimeout(cleanupTimer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      const out = stdout.snapshot(), err = stderr.snapshot();
      resolve({ code: cancelled ? 130 : timedOut ? 124 : closeCode, cancelled, timedOut,
        cleanupConfirmed, cleanupError, forcedTransportStop,
        stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated,
        outputBytes: out.totalBytes + err.totalBytes });
    };
    const stop = kind => {
      if (finished || stopping) return;
      stopping = true;
      cancelled = kind === 'abort'; timedOut = kind === 'timeout';
      cleanupTimer = setTimeout(() => {
        cleanupConfirmed = false;
        cleanupError = 'Container cancellation did not settle within 8 seconds';
        stderr.append(`\nCommand cancellation could not be confirmed: ${cleanupError}. Its container timeout remains active.\n`);
        cleanupDone = true;
        forcedTransportStop = true;
        child.kill('SIGKILL');
        closed = true;
        finish();
      }, 8000);
      Promise.resolve().then(() => {
        if (typeof cancel !== 'function') throw new Error('No container cancellation handler');
        return cancel();
      }).then(() => {
        if (!finished) cleanupConfirmed = true;
      }).catch(error => {
        if (finished) return;
        cleanupConfirmed = false;
        cleanupError = String(error?.message ?? error).slice(0,300);
        stderr.append(`\nCommand cancellation could not be confirmed: ${cleanupError}. Its container timeout remains active.\n`);
      }).finally(() => {
        if (finished) return;
        cleanupDone = true;
        clearTimeout(cleanupTimer);
        if (!closed) {
          child.kill('SIGTERM');
          if (!closed && !finished) killTimer = setTimeout(() => { if (!closed) { forcedTransportStop = true; child.kill('SIGKILL'); closed = true; } finish(); }, 1000);
        }
        finish();
      });
    };
    const onAbort = () => stop('abort');
    try { child = spawnProcess('podman', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { stderr.append(error.message); closed = true; finish(); return; }
    child.stdout?.on('data', chunk => stdout.append(chunk));
    child.stderr?.on('data', chunk => stderr.append(chunk));
    child.once('error', error => { stderr.append(error.message); closed = true; closeCode = 1; finish(); });
    child.once('close', code => { closed = true; closeCode = Number.isInteger(code) ? code : 1; finish(); });
    const deadline = Number(timeoutMs);
    timer = setTimeout(() => stop('timeout'), Number.isFinite(deadline) && deadline > 0 ? deadline : 75000);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
