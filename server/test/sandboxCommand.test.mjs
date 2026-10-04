import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  cancellationArgs, commandOptions, containerCommandArgs, createBoundedOutput,
  runSandboxCommand, truncateOutput,
} from '../src/sandboxCommand.js';

// All children are inert emitters. These tests never call Podman or a shell.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  signals = [];
  ignoreTerm = false;
  kill(signal) {
    this.signals.push(signal);
    if (signal !== 'SIGTERM' || !this.ignoreTerm) this.emit('close', null);
    return true;
  }
}
const nonce = '12345678-1234-1234-1234-123456789abc';

test('command options normalize explicit working folders and bound timeouts', () => {
  assert.deepEqual(commandOptions('npm test', { cwd: 'server' }), { command: 'npm test', cwd: '/workspace/server', timeoutSec: 60 });
  assert.equal(commandOptions('npm test', { cwd: '/workspace/web/../server' }).cwd, '/workspace/server');
  assert.equal(commandOptions('npm test', { timeoutSec: 5.2 }).timeoutSec, 6);
  assert.equal(commandOptions('npm test', {}).cwd, '/workspace');
  for (const cwd of ['/etc', '../outside', '/workspace/../../etc', 'bad\0path']) assert.throws(() => commandOptions('test', { cwd }), /directory/);
  for (const timeoutSec of [0, -1, Infinity, NaN, 901]) assert.throws(() => commandOptions('test', { timeoutSec }), /timeout/);
  assert.throws(() => commandOptions(' '), /required/);
  assert.throws(() => commandOptions('x'.repeat(1024 * 1024 + 1)), /1 MB/);
});

test('shell source stays in arguments and isolated command status is awaited', () => {
  const command = 'printf "%s\\n" \'a; b\'; echo "$VALUE"; echo `literal`';
  const built = containerCommandArgs('duckpond-ws-7', command, { cwd: 'server', timeoutSec: 30 }, nonce);
  assert.deepEqual(built.args.slice(0, 10), ['exec', '-w', '/workspace/server', 'duckpond-ws-7', 'setsid', '--wait', 'timeout', '-k', '5', '30s']);
  assert.equal(built.args.at(-3), command);
  assert.equal(built.args.at(-2), built.pidFile);
  assert.equal(built.args.at(-1), '/workspace/server');
  const wrapper = built.args[12];
  assert.ok(!wrapper.includes(command));
  assert.match(wrapper, /"\$PPID"/);
  assert.match(wrapper, /cd -- "\$1"/);
  assert.match(wrapper, /eval -- "\$2"/);
  const cancellation = cancellationArgs('duckpond-ws-7', built.pidFile);
  assert.equal(cancellation.at(-1), built.pidFile);
  assert.match(cancellation[4], /kill -TERM/);
  assert.match(cancellation[4], /kill -KILL/);
  assert.match(cancellation[4], /ps -eo pgid=/);
  assert.match(cancellation[4], /exit 4/);
  assert.throws(() => cancellationArgs('duckpond-ws-7', '/tmp/user-pid'), /receipt/);
  assert.throws(() => containerCommandArgs('duckpond-ws-7', 'test', {}, 'bad; token'), /receipt/);
});

test('byte truncation preserves UTF-8 and handles empty head or tail correctly', () => {
  const original = '🙂'.repeat(100);
  const cropped = truncateOutput(original, 5, 7);
  assert.equal(cropped.truncated, true);
  assert.match(cropped.text, /392 bytes truncated/);
  assert.doesNotMatch(cropped.text, /\ufffd/);
  assert.ok(cropped.text.startsWith('🙂'));
  assert.ok(cropped.text.endsWith('🙂'));
  assert.equal(truncateOutput('unchanged', 5, 5).text, 'unchanged');
  assert.equal(truncateOutput('secret'.repeat(100), 0, 0).text.includes('secret'), false);
  assert.ok(truncateOutput('HEAD' + 'x'.repeat(1000), 4, 0).text.startsWith('HEAD'));
});

test('stream capture reconstructs fragmented small output without overlap', () => {
  const capture = createBoundedOutput({ headBytes: 8, tailBytes: 8 });
  const bytes = Buffer.from('hello 🙂');
  capture.append(bytes.subarray(0, 7));
  capture.append(bytes.subarray(7));
  assert.deepEqual(capture.snapshot(), { text: 'hello 🙂', truncated: false, totalBytes: bytes.length, retainedBytes: bytes.length });
  const zeroHead = createBoundedOutput({ headBytes: 0, tailBytes: 20 });
  zeroHead.append('tail only');
  assert.equal(zeroHead.snapshot().text, 'tail only');
});

test('verbose commands retain fixed memory and actual tail errors', async () => {
  const child = new FakeChild();
  const pending = runSandboxCommand(['exec', 'fake'], { timeoutMs: 1000, spawnProcess: () => child });
  const chunk = Buffer.alloc(64 * 1024, 120);
  for (let i = 0; i < 128; i++) child.stdout.emit('data', chunk);
  child.stderr.emit('data', 'Build failed at the last line');
  child.emit('close', 2);
  const result = await pending;
  assert.equal(result.code, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.outputBytes, chunk.length * 128 + Buffer.byteLength('Build failed at the last line'));
  assert.ok(result.stdout.length < 33000);
  assert.equal(result.stderr, 'Build failed at the last line');
  assert.deepEqual(child.signals, []);
});

test('pre-cancelled calls cannot start a transport', async () => {
  const abort = new AbortController(); abort.abort();
  const result = await runSandboxCommand([], { signal: abort.signal, spawnProcess: () => { throw new Error('Must not spawn'); } });
  assert.equal(result.cancelled, true);
  assert.equal(result.code, 130);
  assert.equal(result.cleanupConfirmed, true);
});

test('cancelled transport waits for container cleanup even after child close', async () => {
  const child = new FakeChild(), abort = new AbortController();
  let settleCleanup, resolved = false;
  const pending = runSandboxCommand([], {
    timeoutMs: 1000, signal: abort.signal, spawnProcess: () => child,
    cancel: () => new Promise(resolve => { settleCleanup = resolve; }),
  });
  pending.then(() => { resolved = true; });
  abort.abort();
  await Promise.resolve();
  child.emit('close', 143);
  await Promise.resolve();
  assert.equal(resolved, false);
  settleCleanup();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.cleanupError, null);
});

test('cleanup failure is explicit and never claims confirmed termination', async () => {
  const child = new FakeChild(), abort = new AbortController();
  const pending = runSandboxCommand([], {
    timeoutMs: 1000, signal: abort.signal, spawnProcess: () => child,
    cancel: async () => { throw new Error('Container cleanup denied'); },
  });
  abort.abort();
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.cleanupError, 'Container cleanup denied');
  assert.match(result.stderr, /could not be confirmed/);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('ignored transport SIGTERM is escalated before command completion', async () => {
  const child = new FakeChild(), abort = new AbortController(); child.ignoreTerm = true;
  const pending = runSandboxCommand([], { timeoutMs: 5000, signal: abort.signal, spawnProcess: () => child, cancel: async () => {} });
  abort.abort();
  const result = await pending;
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.forcedTransportStop, true);
  assert.equal(result.cleanupConfirmed, true);
});

test('host deadlines clean up the command and report timeout separately from cancellation', async () => {
  const child = new FakeChild(); let cleaned = 0;
  const result = await runSandboxCommand([], { timeoutMs: 5, spawnProcess: () => child, cancel: async () => { cleaned++; } });
  assert.equal(cleaned, 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.code, 124);
  assert.equal(result.cleanupConfirmed, true);
});

test('transport startup failures settle without a child or container cleanup', async () => {
  const result = await runSandboxCommand([], { spawnProcess: () => { throw new Error('Podman unavailable'); } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Podman unavailable/);
  assert.equal(result.cleanupConfirmed, null);
});
